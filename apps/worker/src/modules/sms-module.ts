import type { Module, JobPayload, JobResult, ValidationResult, SendConfig } from "./types.js";
import type { SmsModuleConfig } from "@batchsender/db";
import { log } from "../logger.js";

/**
 * SMS payload with SMS-specific fields
 */
interface SmsPayload extends JobPayload {
  fromNumber?: string;
  message?: string;
}

/**
 * SMS Module - Sends SMS messages via Twilio, AWS SNS, or mock provider
 *
 * Currently implements mock provider only.
 * Real providers can be added when needed.
 */
export class SmsModule implements Module {
  readonly type = "sms";
  readonly name = "SMS";

  validateConfig(rawConfig: unknown): ValidationResult {
    const errors: string[] = [];
    const cfg = rawConfig as SmsModuleConfig;

    // Provider validation
    if (!cfg.provider) {
      errors.push("provider is required (twilio, aws-sns, or mock)");
    } else if (!["twilio", "aws-sns", "mock"].includes(cfg.provider)) {
      errors.push('provider must be "twilio", "aws-sns", or "mock"');
    }

    // fromNumber required for all providers
    if (!cfg.fromNumber) {
      errors.push("fromNumber is required");
    }

    // Provider-specific validation
    if (cfg.provider === "twilio") {
      if (!cfg.accountSid) errors.push("accountSid is required for Twilio");
      if (!cfg.authToken) errors.push("authToken is required for Twilio");
    }

    if (cfg.provider === "aws-sns") {
      if (!cfg.region) errors.push("region is required for AWS SNS");
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

      switch (cfg.provider) {
        case "mock":
          messageId = await this.sendMock(smsPayload);
          break;
        case "twilio":
          // Real Twilio integration can be added here
          messageId = await this.sendMock(smsPayload);
          log.system.warn({ provider: "twilio" }, "Twilio not implemented, using mock");
          break;
        case "aws-sns":
          // Real AWS SNS integration can be added here
          messageId = await this.sendMock(smsPayload);
          log.system.warn({ provider: "aws-sns" }, "AWS SNS not implemented, using mock");
          break;
        default:
          throw new Error(`Unknown SMS provider: ${cfg.provider}`);
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

  private async sendMock(payload: SmsPayload): Promise<string> {
    // Simulate network latency (10-50ms)
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
    return `mock-sms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private isValidPhoneNumber(phone: string): boolean {
    // E.164 format: + followed by 1-15 digits
    return /^\+[1-9]\d{1,14}$/.test(phone);
  }
}
