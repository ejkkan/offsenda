import type { Module, JobPayload, JobResult, ValidationResult, SendConfig } from "./types.js";
import type { SmsModuleConfig } from "@batchsender/db";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * SMS payload with SMS-specific fields
 */
interface SmsPayload extends JobPayload {
  fromNumber?: string;
  message?: string;
}

/**
 * SMS Module - Sends SMS messages via Telnyx, Twilio, AWS SNS, or mock provider
 *
 * Supports two modes:
 * - managed: Uses BatchSender's infrastructure (Telnyx from env vars)
 * - byok: Uses user's own API credentials (Bring Your Own Key)
 */
export class SmsModule implements Module {
  readonly type = "sms";
  readonly name = "SMS";

  validateConfig(rawConfig: unknown): ValidationResult {
    const errors: string[] = [];
    const cfg = rawConfig as SmsModuleConfig;

    // Mode validation (optional for backwards compatibility)
    if (cfg.mode && cfg.mode !== "managed" && cfg.mode !== "byok") {
      errors.push('mode must be "managed" or "byok"');
    }

    // Managed mode - minimal validation, provider from env
    if (cfg.mode === "managed") {
      // fromNumber can be optional in managed mode (use env default)
      return { valid: errors.length === 0, errors };
    }

    // BYOK mode validation
    if (!cfg.provider) {
      errors.push("provider is required (twilio, aws-sns, telnyx, or mock)");
    } else if (!["twilio", "aws-sns", "mock", "telnyx"].includes(cfg.provider)) {
      errors.push('provider must be "twilio", "aws-sns", "telnyx", or "mock"');
    }

    // fromNumber required for BYOK
    if (!cfg.fromNumber) {
      errors.push("fromNumber is required");
    }

    // Provider-specific validation for BYOK
    if (cfg.provider === "twilio") {
      if (!cfg.accountSid) errors.push("accountSid is required for Twilio");
      if (!cfg.authToken) errors.push("authToken is required for Twilio");
    }

    if (cfg.provider === "aws-sns") {
      if (!cfg.region) errors.push("region is required for AWS SNS");
    }

    if (cfg.provider === "telnyx") {
      if (!cfg.apiKey) errors.push("apiKey is required for Telnyx");
    }

    return { valid: errors.length === 0, errors };
  }

  validatePayload(payload: JobPayload): ValidationResult {
    const errors: string[] = [];
    const smsPayload = payload as SmsPayload;

    if (!smsPayload.to) {
      errors.push("to (phone number) is required");
    } else if (!this.isValidPhoneNumber(smsPayload.to)) {
      errors.push("to must be a valid phone number (E.164 format: +1234567890)");
    }

    if (!smsPayload.message) {
      errors.push("message is required");
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(payload: JobPayload, sendConfig: SendConfig): Promise<JobResult> {
    const start = Date.now();
    const cfg = sendConfig.config as SmsModuleConfig;
    const smsPayload = payload as SmsPayload;

    try {
      let messageId: string;

      if (cfg.mode === "managed") {
        messageId = await this.sendManaged(smsPayload, cfg);
      } else {
        messageId = await this.sendBYOK(smsPayload, cfg);
      }

      return {
        success: true,
        providerMessageId: messageId,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      log.system.error({ error, to: smsPayload.to }, "SMS send failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Send using BatchSender's managed infrastructure
   */
  private async sendManaged(payload: SmsPayload, cfg: SmsModuleConfig): Promise<string> {
    const provider = config.SMS_PROVIDER;

    if (provider === "mock") {
      return this.sendMock(payload);
    }

    if (provider === "telnyx") {
      // Use managed Telnyx credentials from environment
      const managedConfig: SmsModuleConfig = {
        mode: "managed",
        provider: "telnyx",
        apiKey: process.env.TELNYX_API_KEY,
        fromNumber: cfg.fromNumber || process.env.TELNYX_FROM_NUMBER,
        messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
      };
      return this.sendTelnyx(payload, managedConfig);
    }

    throw new Error(`Unknown managed SMS provider: ${provider}`);
  }

  /**
   * Send using user's own credentials (BYOK)
   */
  private async sendBYOK(payload: SmsPayload, cfg: SmsModuleConfig): Promise<string> {
    switch (cfg.provider) {
      case "mock":
        return this.sendMock(payload);
      case "twilio":
        log.system.warn({ provider: "twilio" }, "Twilio not implemented, using mock");
        return this.sendMock(payload);
      case "aws-sns":
        log.system.warn({ provider: "aws-sns" }, "AWS SNS not implemented, using mock");
        return this.sendMock(payload);
      case "telnyx":
        return this.sendTelnyx(payload, cfg);
      default:
        throw new Error(`Unknown SMS provider: ${cfg.provider}`);
    }
  }

  private async sendMock(payload: SmsPayload): Promise<string> {
    // Simulate network latency (10-50ms)
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
    return `mock-sms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private async sendTelnyx(payload: SmsPayload, config: SmsModuleConfig): Promise<string> {
    const telnyxApiUrl = "https://api.telnyx.com/v2/messages";

    // Prepare the request body
    const requestBody: Record<string, any> = {
      from: payload.fromNumber || config.fromNumber,
      to: payload.to,
      text: this.interpolateVariables(payload.message || "", payload.variables),
      type: "SMS",
    };

    // Add messaging profile if configured
    if (config.messagingProfileId) {
      requestBody.messaging_profile_id = config.messagingProfileId;
    }

    // Add webhook URL if configured
    const webhookUrl = process.env.TELNYX_WEBHOOK_URL || process.env.WEBHOOK_BASE_URL;
    if (webhookUrl) {
      requestBody.webhook_url = `${webhookUrl}/api/webhooks/telnyx`;
      requestBody.webhook_failover_url = `${webhookUrl}/api/webhooks/telnyx-failover`;
    }

    try {
      const response = await fetch(telnyxApiUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.errors?.[0]?.detail ||
                           errorData.message ||
                           `Telnyx API error: ${response.status} ${response.statusText}`;
        throw new Error(errorMessage);
      }

      const data = await response.json();

      // Telnyx returns the message ID in data.data.id
      return data.data.id;
    } catch (error) {
      if (error instanceof Error) {
        log.system.error({ error: error.message, to: payload.to }, "Telnyx SMS send failed");
        throw error;
      }
      throw new Error("Unknown error sending SMS via Telnyx");
    }
  }

  private interpolateVariables(text: string, variables?: Record<string, string>): string {
    if (!variables) return text;

    return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return variables[key] || match;
    });
  }

  private isValidPhoneNumber(phone: string): boolean {
    // E.164 format: + followed by 1-15 digits
    return /^\+[1-9]\d{1,14}$/.test(phone);
  }
}
