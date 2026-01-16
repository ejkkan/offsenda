import { Resend } from "resend";
import type { Module, JobPayload, JobResult, ValidationResult, SendConfig, EmailModuleConfig } from "./types.js";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Email Module - Sends emails via Resend or AWS SES
 *
 * Supports two modes:
 * - managed: Uses our infrastructure (Resend/SES from env vars)
 * - byok: Uses user's own API key (Bring Your Own Key)
 */
export class EmailModule implements Module {
  readonly type = "email";
  readonly name = "Email";

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
      for (const [key, value] of Object.entries(vars)) {
        result.htmlContent = result.htmlContent.replace(
          new RegExp(`{{${key}}}`, "g"),
          value
        );
      }
    }

    if (result.textContent) {
      for (const [key, value] of Object.entries(vars)) {
        result.textContent = result.textContent.replace(
          new RegExp(`{{${key}}}`, "g"),
          value
        );
      }
    }

    if (result.subject) {
      for (const [key, value] of Object.entries(vars)) {
        result.subject = result.subject.replace(
          new RegExp(`{{${key}}}`, "g"),
          value
        );
      }
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
