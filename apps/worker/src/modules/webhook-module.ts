import type { Module, JobPayload, JobResult, ValidationResult, SendConfig, WebhookModuleConfig } from "./types.js";
import { log } from "../logger.js";

/**
 * Webhook Module - Sends HTTP POST/PUT requests to user's endpoints
 *
 * Users configure their endpoint URL and we call it for each job,
 * handling rate limiting, retries, and monitoring.
 */
export class WebhookModule implements Module {
  readonly type = "webhook";
  readonly name = "Webhook";

  validateConfig(rawConfig: unknown): ValidationResult {
    const errors: string[] = [];
    const cfg = rawConfig as WebhookModuleConfig;

    if (!cfg.url) {
      errors.push("url is required");
    } else {
      try {
        const url = new URL(cfg.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          errors.push("url must use http or https protocol");
        }
        // Warn but don't error for non-https in validation
        // Production should enforce https
      } catch {
        errors.push("url must be a valid URL");
      }
    }

    if (cfg.method && cfg.method !== "POST" && cfg.method !== "PUT") {
      errors.push('method must be "POST" or "PUT"');
    }

    if (cfg.timeout !== undefined) {
      if (typeof cfg.timeout !== "number" || cfg.timeout < 1000 || cfg.timeout > 60000) {
        errors.push("timeout must be between 1000 and 60000 milliseconds");
      }
    }

    if (cfg.retries !== undefined) {
      if (typeof cfg.retries !== "number" || cfg.retries < 0 || cfg.retries > 10) {
        errors.push("retries must be between 0 and 10");
      }
    }

    if (cfg.successStatusCodes !== undefined) {
      if (!Array.isArray(cfg.successStatusCodes)) {
        errors.push("successStatusCodes must be an array");
      } else if (cfg.successStatusCodes.some((code) => typeof code !== "number")) {
        errors.push("successStatusCodes must contain only numbers");
      }
    }

    return { valid: errors.length === 0, errors };
  }

  validatePayload(payload: JobPayload): ValidationResult {
    // Webhook accepts any payload - it's user-defined
    // The data field should contain whatever they want to send
    return { valid: true };
  }

  async execute(payload: JobPayload, sendConfig: SendConfig): Promise<JobResult> {
    const start = Date.now();
    const cfg = sendConfig.config as WebhookModuleConfig;

    try {
      const result = await this.sendWebhook(payload, cfg);
      return {
        ...result,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      log.email.error({ error, url: cfg.url }, "Webhook send failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        latencyMs: Date.now() - start,
      };
    }
  }

  private async sendWebhook(
    payload: JobPayload,
    cfg: WebhookModuleConfig
  ): Promise<Omit<JobResult, "latencyMs">> {
    const method = cfg.method || "POST";
    const timeout = cfg.timeout || 30000;
    const successCodes = cfg.successStatusCodes || [200, 201, 202];

    // Build request body
    const body = this.buildRequestBody(payload, cfg);

    // Make the request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(cfg.url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "BatchSender/1.0",
          ...cfg.headers,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const success = successCodes.includes(response.status);

      // Try to extract message ID from response
      let providerMessageId: string | undefined;
      if (success) {
        try {
          const json = await response.json();
          providerMessageId =
            (json as Record<string, unknown>).id?.toString() ||
            (json as Record<string, unknown>).messageId?.toString() ||
            (json as Record<string, unknown>).message_id?.toString();
        } catch {
          // Response not JSON, that's fine
        }
      }

      if (!success) {
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch {
          // Ignore
        }
        return {
          success: false,
          statusCode: response.status,
          error: `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
        };
      }

      return {
        success: true,
        statusCode: response.status,
        providerMessageId,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return {
          success: false,
          error: `Request timeout after ${timeout}ms`,
        };
      }

      throw error;
    }
  }

  /**
   * Build the request body from payload
   */
  private buildRequestBody(payload: JobPayload, cfg: WebhookModuleConfig): string {
    // If payload has data field, use that as the body
    // Otherwise send the whole payload
    const data = payload.data || {
      to: payload.to,
      name: payload.name,
      subject: payload.subject,
      htmlContent: payload.htmlContent,
      textContent: payload.textContent,
      variables: payload.variables,
    };

    // Apply template variables if present
    if (payload.variables) {
      return this.applyTemplateVariables(JSON.stringify(data), payload.variables);
    }

    return JSON.stringify(data);
  }

  /**
   * Apply template variables to the body string
   */
  private applyTemplateVariables(body: string, variables: Record<string, string>): string {
    let result = body;
    for (const [key, value] of Object.entries(variables)) {
      // Handle both {{key}} and "{{key}}" patterns
      result = result.replace(new RegExp(`{{${key}}}`, "g"), value);
    }
    return result;
  }
}
