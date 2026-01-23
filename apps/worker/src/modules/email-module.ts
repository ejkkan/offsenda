import { Resend } from "resend";
import type { Module, JobPayload, JobResult, ValidationResult, SendConfig, EmailModuleConfig, BatchJobPayload, BatchJobResult } from "./types.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { interpolateVariables } from "../domain/utils/template.js";

/**
 * Email Module - Sends emails via Resend or AWS SES
 *
 * Supports two modes:
 * - managed: Uses our infrastructure (Resend/SES from env vars)
 * - byok: Uses user's own API key (Bring Your Own Key)
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

    if (!cfg.mode) {
      errors.push("mode is required (managed or byok)");
    } else if (cfg.mode !== "managed" && cfg.mode !== "byok") {
      errors.push('mode must be "managed" or "byok"');
    }

    if (cfg.mode === "byok") {
      if (!cfg.provider) {
        errors.push("provider is required for BYOK mode (resend or ses)");
      } else if (cfg.provider !== "resend" && cfg.provider !== "ses") {
        errors.push('provider must be "resend" or "ses"');
      }

      if (!cfg.apiKey) {
        errors.push("apiKey is required for BYOK mode");
      }

      if (cfg.provider === "ses" && cfg.apiKey && !cfg.apiKey.includes(":")) {
        errors.push("SES apiKey must be in format: accessKeyId:secretAccessKey");
      }
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

      if (cfg.mode === "managed") {
        providerMessageId = await this.sendManaged(processedPayload);
      } else {
        providerMessageId = await this.sendBYOK(processedPayload, cfg);
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
      if (cfg.mode === "managed") {
        return await this.sendBatchManaged(processedPayloads, start);
      } else {
        return await this.sendBatchBYOK(processedPayloads, cfg, start);
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
   * Send batch using managed infrastructure
   */
  private async sendBatchManaged(
    payloads: { recipientId: string; payload: JobPayload }[],
    startTime: number
  ): Promise<BatchJobResult[]> {
    const providerType = config.EMAIL_PROVIDER;

    if (providerType === "resend") {
      return this.sendBatchViaResend(payloads, config.RESEND_API_KEY, startTime);
    } else if (providerType === "ses") {
      return this.sendBatchViaSES(payloads, {
        region: config.AWS_REGION,
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
        endpoint: config.SES_ENDPOINT,
      }, startTime);
    } else if (providerType === "mock") {
      // Mock provider - simulate success for all
      const latencyMs = Date.now() - startTime;
      return payloads.map((p) => ({
        recipientId: p.recipientId,
        result: {
          success: true,
          providerMessageId: `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          latencyMs,
        },
      }));
    }

    throw new Error(`Unknown managed provider: ${providerType}`);
  }

  /**
   * Send batch using user's own API key (BYOK)
   */
  private async sendBatchBYOK(
    payloads: { recipientId: string; payload: JobPayload }[],
    cfg: EmailModuleConfig,
    startTime: number
  ): Promise<BatchJobResult[]> {
    if (cfg.provider === "resend") {
      return this.sendBatchViaResend(payloads, cfg.apiKey!, startTime);
    } else if (cfg.provider === "ses") {
      const [accessKeyId, secretAccessKey] = cfg.apiKey!.split(":");
      return this.sendBatchViaSES(payloads, {
        region: cfg.region || "us-east-1",
        accessKeyId,
        secretAccessKey,
      }, startTime);
    }

    throw new Error(`Unknown BYOK provider: ${cfg.provider}`);
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
   * Send batch via AWS SES SendBulkEmail API
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
    // If custom endpoint (mock), fall back to individual sends
    if (sesConfig.endpoint) {
      const results: BatchJobResult[] = [];
      for (const p of payloads) {
        try {
          const messageId = await this.sendViaSESMock(p.payload, sesConfig.endpoint);
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

    const { SESv2Client, SendBulkEmailCommand } = await import("@aws-sdk/client-sesv2");

    const client = new SESv2Client({
      region: sesConfig.region,
      credentials: sesConfig.accessKeyId
        ? {
            accessKeyId: sesConfig.accessKeyId,
            secretAccessKey: sesConfig.secretAccessKey!,
          }
        : undefined,
    });

    // SES requires a common template or simple content for bulk
    // For now, we use BulkEmailEntry with individual replacements
    const fromAddress = payloads[0].payload.fromName
      ? `${payloads[0].payload.fromName} <${payloads[0].payload.fromEmail}>`
      : payloads[0].payload.fromEmail!;

    const command = new SendBulkEmailCommand({
      FromEmailAddress: fromAddress,
      DefaultContent: {
        Template: undefined, // We'll use simple content per entry
      },
      BulkEmailEntries: payloads.map((p) => ({
        Destination: {
          ToAddresses: [p.payload.to!],
        },
        ReplacementEmailContent: {
          ReplacementTemplate: undefined,
        },
        // SES bulk requires template, so we send individually for custom content
      })),
    });

    // Note: SES bulk email has limitations - requires templates
    // For fully custom content per recipient, we batch the individual sends
    // This still benefits from connection reuse
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
   * Send using our managed infrastructure
   */
  private async sendManaged(payload: JobPayload): Promise<string> {
    // Use the configured provider from environment
    const providerType = config.EMAIL_PROVIDER;

    if (providerType === "resend") {
      return this.sendViaResend(payload, config.RESEND_API_KEY);
    } else if (providerType === "ses") {
      return this.sendViaSES(payload, {
        region: config.AWS_REGION,
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
        endpoint: config.SES_ENDPOINT,
      });
    } else if (providerType === "mock") {
      // For testing
      return `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    throw new Error(`Unknown managed provider: ${providerType}`);
  }

  /**
   * Send using user's own API key (BYOK)
   */
  private async sendBYOK(payload: JobPayload, cfg: EmailModuleConfig): Promise<string> {
    if (cfg.provider === "resend") {
      return this.sendViaResend(payload, cfg.apiKey!);
    } else if (cfg.provider === "ses") {
      const [accessKeyId, secretAccessKey] = cfg.apiKey!.split(":");
      return this.sendViaSES(payload, {
        region: cfg.region || "us-east-1",
        accessKeyId,
        secretAccessKey,
      });
    }

    throw new Error(`Unknown BYOK provider: ${cfg.provider}`);
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
    // If custom endpoint, use mock server
    if (sesConfig.endpoint) {
      return this.sendViaSESMock(payload, sesConfig.endpoint);
    }

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
   * Send via mock SES endpoint (for testing)
   */
  private async sendViaSESMock(payload: JobPayload, endpoint: string): Promise<string> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: payload.to,
        from: payload.fromEmail,
        fromName: payload.fromName,
        subject: payload.subject,
        html: payload.htmlContent,
        text: payload.textContent,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mock SES error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as { MessageId: string };
    return data.MessageId;
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
