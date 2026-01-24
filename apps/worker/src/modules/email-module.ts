import { Resend } from "resend";
import type { Module, JobPayload, JobResult, ValidationResult, SendConfig, EmailModuleConfig, BatchJobPayload, BatchJobResult } from "./types.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { interpolateVariables } from "../domain/utils/template.js";

/**
 * Email Module - Sends emails via platform services (SES or Resend)
 *
 * Platform-only: Uses our managed SES or Resend accounts.
 * For custom endpoints, users should use the Webhook module.
 *
 * Supports batch execution for higher throughput.
 */
export class EmailModule implements Module {
  readonly type = "email";
  readonly name = "Email";
  readonly supportsBatch = true;

  validateConfig(rawConfig: unknown): ValidationResult {
    const errors: string[] = [];
    const cfg = rawConfig as EmailModuleConfig;

    if (!cfg.service) {
      errors.push("service is required (ses or resend)");
    } else if (cfg.service !== "ses" && cfg.service !== "resend") {
      errors.push('service must be "ses" or "resend"');
    }

    if (!cfg.fromEmail) {
      errors.push("fromEmail is required");
    }

    return { valid: errors.length === 0, errors };
  }

  validatePayload(payload: JobPayload): ValidationResult {
    const errors: string[] = [];

    if (!payload.to) {
      errors.push("to (email address) is required");
    } else if (!this.isValidEmail(payload.to)) {
      errors.push("to must be a valid email address");
    }

    if (!payload.subject) {
      errors.push("subject is required");
    }

    if (!payload.htmlContent && !payload.textContent) {
      errors.push("htmlContent or textContent is required");
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(payload: JobPayload, sendConfig: SendConfig): Promise<JobResult> {
    const start = Date.now();
    const cfg = sendConfig.config as EmailModuleConfig;

    try {
      // Apply template variables
      const processedPayload = this.applyTemplateVariables(payload);

      let providerMessageId: string;

      if (cfg.service === "resend") {
        providerMessageId = await this.sendViaResend(processedPayload, config.RESEND_API_KEY);
      } else {
        providerMessageId = await this.sendViaSES(processedPayload, {
          region: config.AWS_REGION,
          accessKeyId: config.AWS_ACCESS_KEY_ID,
          secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
          endpoint: config.SES_ENDPOINT,
        });
      }

      return {
        success: true,
        providerMessageId,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      log.email.error({ error, to: payload.to }, "Email send failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Execute a batch of email sends in a single API call
   */
  async executeBatch(payloads: BatchJobPayload[], sendConfig: SendConfig): Promise<BatchJobResult[]> {
    const start = Date.now();
    const cfg = sendConfig.config as EmailModuleConfig;

    // Process all payloads with template variables
    const processedPayloads = payloads.map((p) => ({
      recipientId: p.recipientId,
      payload: this.applyTemplateVariables(p.payload),
    }));

    try {
      if (cfg.service === "resend") {
        return await this.sendBatchViaResend(processedPayloads, config.RESEND_API_KEY, start);
      } else {
        return await this.sendBatchViaSES(processedPayloads, {
          region: config.AWS_REGION,
          accessKeyId: config.AWS_ACCESS_KEY_ID,
          secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
          endpoint: config.SES_ENDPOINT,
        }, start);
      }
    } catch (error) {
      // If the entire batch fails, return failure for all
      log.email.error({ error, count: payloads.length }, "Batch email send failed");
      const latencyMs = Date.now() - start;
      return payloads.map((p) => ({
        recipientId: p.recipientId,
        result: {
          success: false,
          error: error instanceof Error ? error.message : "Batch send failed",
          latencyMs,
        },
      }));
    }
  }

  /**
   * Send batch via Resend batch API
   */
  private async sendBatchViaResend(
    payloads: { recipientId: string; payload: JobPayload }[],
    apiKey: string,
    startTime: number
  ): Promise<BatchJobResult[]> {
    const resend = new Resend(apiKey);

    // Build batch request
    const emails = payloads.map((p) => {
      const from = p.payload.fromName
        ? `${p.payload.fromName} <${p.payload.fromEmail}>`
        : p.payload.fromEmail!;

      return {
        from,
        to: p.payload.to!,
        subject: p.payload.subject!,
        ...(p.payload.htmlContent ? { html: p.payload.htmlContent } : {}),
        text: p.payload.textContent || " ",
      };
    });

    const result = await resend.batch.send(emails);
    const latencyMs = Date.now() - startTime;

    // Map results back to recipients
    if (result.error) {
      // Entire batch failed
      return payloads.map((p) => ({
        recipientId: p.recipientId,
        result: {
          success: false,
          error: result.error!.message,
          latencyMs,
        },
      }));
    }

    // Map individual results
    const resultData = result.data as unknown as Array<{ id: string }> | undefined;
    return payloads.map((p, index) => {
      const emailResult = resultData?.[index];
      if (emailResult?.id) {
        return {
          recipientId: p.recipientId,
          result: {
            success: true,
            providerMessageId: emailResult.id,
            latencyMs,
          },
        };
      } else {
        return {
          recipientId: p.recipientId,
          result: {
            success: false,
            error: "No message ID returned",
            latencyMs,
          },
        };
      }
    });
  }

  /**
   * Send batch via AWS SES
   * SES doesn't have a true batch API for custom content, so we send individually
   * but benefit from connection reuse
   */
  private async sendBatchViaSES(
    payloads: { recipientId: string; payload: JobPayload }[],
    sesConfig: {
      region: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      endpoint?: string;
    },
    startTime: number
  ): Promise<BatchJobResult[]> {
    const results: BatchJobResult[] = [];

    for (const p of payloads) {
      try {
        const messageId = await this.sendViaSES(p.payload, sesConfig);
        results.push({
          recipientId: p.recipientId,
          result: {
            success: true,
            providerMessageId: messageId,
            latencyMs: Date.now() - startTime,
          },
        });
      } catch (error) {
        results.push({
          recipientId: p.recipientId,
          result: {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
            latencyMs: Date.now() - startTime,
          },
        });
      }
    }

    return results;
  }

  /**
   * Send via Resend
   */
  private async sendViaResend(payload: JobPayload, apiKey: string): Promise<string> {
    const resend = new Resend(apiKey);

    const from = payload.fromName
      ? `${payload.fromName} <${payload.fromEmail}>`
      : payload.fromEmail!;

    const result = await resend.emails.send({
      from,
      to: payload.to!,
      subject: payload.subject!,
      ...(payload.htmlContent ? { html: payload.htmlContent } : {}),
      text: payload.textContent || " ",
    });

    if (result.error) {
      throw new Error(result.error.message);
    }

    return result.data?.id || "";
  }

  /**
   * Send via AWS SES
   */
  private async sendViaSES(
    payload: JobPayload,
    sesConfig: {
      region: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      endpoint?: string;
    }
  ): Promise<string> {
    // Dynamic import to avoid loading AWS SDK when not needed
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");

    const client = new SESv2Client({
      region: sesConfig.region,
      credentials: sesConfig.accessKeyId
        ? {
            accessKeyId: sesConfig.accessKeyId,
            secretAccessKey: sesConfig.secretAccessKey!,
          }
        : undefined,
      ...(sesConfig.endpoint ? { endpoint: sesConfig.endpoint } : {}),
    });

    const fromAddress = payload.fromName
      ? `${payload.fromName} <${payload.fromEmail}>`
      : payload.fromEmail!;

    const command = new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: {
        ToAddresses: [payload.to!],
      },
      Content: {
        Simple: {
          Subject: {
            Data: payload.subject!,
            Charset: "UTF-8",
          },
          Body: {
            ...(payload.htmlContent && {
              Html: {
                Data: payload.htmlContent,
                Charset: "UTF-8",
              },
            }),
            Text: {
              Data: payload.textContent || " ",
              Charset: "UTF-8",
            },
          },
        },
      },
    });

    const result = await client.send(command);
    return result.MessageId || "";
  }

  /**
   * Apply template variables to payload
   */
  private applyTemplateVariables(payload: JobPayload): JobPayload {
    const result = { ...payload };
    const vars = {
      ...payload.variables,
      name: payload.name || "",
      email: payload.to || "",
    };

    if (result.htmlContent) {
      result.htmlContent = interpolateVariables(result.htmlContent, vars);
    }

    if (result.textContent) {
      result.textContent = interpolateVariables(result.textContent, vars);
    }

    if (result.subject) {
      result.subject = interpolateVariables(result.subject, vars);
    }

    return result;
  }

  /**
   * Simple email validation
   */
  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}
