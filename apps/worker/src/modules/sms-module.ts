import type { Module, JobPayload, JobResult, ValidationResult, SendConfig, BatchJobPayload, BatchJobResult } from "./types.js";
import type { SmsModuleConfig } from "@batchsender/db";
import { log } from "../logger.js";
import { interpolateVariables } from "../domain/utils/template.js";

/**
 * SMS payload with SMS-specific fields
 */
interface SmsPayload extends JobPayload {
  fromNumber?: string;
  message?: string;
}

/**
 * SMS Module - Sends SMS messages via platform service (Telnyx)
 *
 * Platform-only: Uses our managed Telnyx account.
 * For custom endpoints, users should use the Webhook module.
 *
 * Batch execution: Makes parallel individual API calls (no batch API available).
 * Concurrency is limited to avoid overwhelming the provider.
 */
export class SmsModule implements Module {
  readonly type = "sms";
  readonly name = "SMS";
  readonly supportsBatch = true;

  // Max parallel requests when executing a batch (Telnyx limit is ~15/sec)
  private readonly maxParallelRequests = 10;

  validateConfig(rawConfig: unknown): ValidationResult {
    const errors: string[] = [];
    const cfg = rawConfig as SmsModuleConfig;

    if (!cfg.service) {
      errors.push("service is required (telnyx)");
    } else if (cfg.service !== "telnyx") {
      errors.push('service must be "telnyx"');
    }

    if (!cfg.fromNumber) {
      errors.push("fromNumber is required");
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
      const messageId = await this.sendViaTelnyx(smsPayload, cfg);

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
   * Execute a batch of SMS sends using parallel individual API calls.
   * SMS providers (Telnyx) don't have batch APIs, so we make parallel calls
   * with controlled concurrency to avoid overwhelming the provider.
   */
  async executeBatch(payloads: BatchJobPayload[], sendConfig: SendConfig): Promise<BatchJobResult[]> {
    const start = Date.now();
    const results: BatchJobResult[] = new Array(payloads.length);

    // Process in chunks to control concurrency
    for (let i = 0; i < payloads.length; i += this.maxParallelRequests) {
      const chunk = payloads.slice(i, i + this.maxParallelRequests);
      const chunkPromises = chunk.map(async (p, chunkIndex) => {
        const result = await this.execute(p.payload, sendConfig);
        return {
          index: i + chunkIndex,
          recipientId: p.recipientId,
          result,
        };
      });

      const chunkResults = await Promise.all(chunkPromises);
      for (const r of chunkResults) {
        results[r.index] = {
          recipientId: r.recipientId,
          result: r.result,
        };
      }
    }

    const latencyMs = Date.now() - start;
    log.system.debug(
      { count: payloads.length, latencyMs, parallelism: this.maxParallelRequests },
      "SMS batch completed"
    );

    return results;
  }

  /**
   * Send SMS via Telnyx API
   */
  private async sendViaTelnyx(payload: SmsPayload, cfg: SmsModuleConfig): Promise<string> {
    const telnyxApiUrl = "https://api.telnyx.com/v2/messages";
    const apiKey = process.env.TELNYX_API_KEY;

    if (!apiKey) {
      throw new Error("TELNYX_API_KEY environment variable is required");
    }

    // Prepare the request body
    const requestBody: Record<string, unknown> = {
      from: payload.fromNumber || cfg.fromNumber,
      to: payload.to,
      text: interpolateVariables(payload.message || "", payload.variables),
      type: "SMS",
    };

    // Add messaging profile if configured
    if (cfg.messagingProfileId) {
      requestBody.messaging_profile_id = cfg.messagingProfileId;
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
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as {
          errors?: Array<{ detail?: string }>;
          message?: string;
        };
        const errorMessage = errorData.errors?.[0]?.detail ||
                           errorData.message ||
                           `Telnyx API error: ${response.status} ${response.statusText}`;
        throw new Error(errorMessage);
      }

      const data = await response.json() as { data: { id: string } };

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

  private isValidPhoneNumber(phone: string): boolean {
    // E.164 format: + followed by 1-15 digits
    return /^\+[1-9]\d{1,14}$/.test(phone);
  }
}
