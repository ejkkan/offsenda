import type { Module, JobPayload, JobResult, ValidationResult, SendConfig, WebhookModuleConfig } from "./types.js";
import { log } from "../logger.js";
import { ResilientHttpClient, type ResilientClientConfig } from "../http/resilient-client.js";

// =============================================================================
// Webhook Module - Enhanced with Resilient HTTP Client
// =============================================================================
// Sends HTTP POST/PUT requests to user's endpoints with:
// - Automatic retry with exponential backoff
// - Circuit breaker for failing endpoints
// - Configurable timeout and success codes
// - Template variable substitution
// =============================================================================

/**
 * Webhook Module - Sends HTTP POST/PUT requests to user's endpoints
 *
 * Users configure their endpoint URL and we call it for each job,
 * handling rate limiting, retries, and monitoring via the resilient HTTP client.
 */
export class WebhookModule implements Module {
  readonly type = "webhook";
  readonly name = "Webhook";

  // Shared HTTP client with circuit breaker (per endpoint)
  private httpClient: ResilientHttpClient;

  constructor(clientConfig?: Partial<ResilientClientConfig>) {
    // Create resilient HTTP client with webhook-optimized defaults
    this.httpClient = new ResilientHttpClient({
      defaultTimeout: 30000,
      retry: {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        backoffMultiplier: 2,
        jitter: true,
        retryableStatusCodes: [408, 429, 500, 502, 503, 504],
        retryOnTimeout: true,
        retryOnNetworkError: true,
      },
      circuitBreaker: {
        enabled: true,
        failureThreshold: 5,
        successThreshold: 2,
        resetTimeoutMs: 30000,
        failureWindowMs: 60000,
      },
      defaultHeaders: {
        "User-Agent": "BatchSender/1.0",
        "Content-Type": "application/json",
      },
      ...clientConfig,
    });
  }

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
    const successCodes = cfg.successStatusCodes || [200, 201, 202, 204];
    const maxRetries = cfg.retries ?? 3;

    // Build request body
    const body = this.buildRequestBody(payload, cfg);

    // Update client config based on per-request settings
    // (The client handles retry internally, but we can override timeout)
    const result = await this.httpClient.request<Record<string, unknown>>(cfg.url, {
      method,
      headers: cfg.headers,
      body,
      timeout,
    });

    // Circuit breaker tripped
    if (result.circuitBreakerTripped) {
      log.webhook.warn({ url: cfg.url }, "circuit breaker open, request blocked");
      return {
        success: false,
        error: "Circuit breaker open - too many recent failures",
      };
    }

    // Request failed after retries
    if (!result.success || !result.response) {
      log.webhook.warn(
        { url: cfg.url, error: result.error, attempts: result.attempts },
        "webhook failed after retries"
      );
      return {
        success: false,
        error: result.error || "Request failed",
      };
    }

    const response = result.response;
    const success = successCodes.includes(response.status);

    // Try to extract message ID from response
    let providerMessageId: string | undefined;
    if (success && typeof response.body === "object" && response.body !== null) {
      const json = response.body as Record<string, unknown>;
      providerMessageId =
        json.id?.toString() ||
        json.messageId?.toString() ||
        json.message_id?.toString();
    }

    if (!success) {
      const errorBody = typeof response.body === "string"
        ? (response.body as string).slice(0, 200)
        : JSON.stringify(response.body || {}).slice(0, 200);

      return {
        success: false,
        statusCode: response.status,
        error: `HTTP ${response.status}: ${errorBody}`,
      };
    }

    log.webhook.debug(
      { url: cfg.url, status: response.status, attempts: result.attempts },
      "webhook succeeded"
    );

    return {
      success: true,
      statusCode: response.status,
      providerMessageId,
    };
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

  /**
   * Get circuit breaker status for all endpoints (for monitoring)
   */
  async getCircuitStatus(): Promise<Map<string, { state: string; failures: number }>> {
    return this.httpClient.getCircuitStatus();
  }

  /**
   * Reset circuit breaker for a specific endpoint
   */
  async resetCircuit(host: string): Promise<void> {
    await this.httpClient.resetCircuit(host);
  }

  /**
   * Reset all circuit breakers
   */
  async resetAllCircuits(): Promise<void> {
    await this.httpClient.resetAllCircuits();
  }
}
