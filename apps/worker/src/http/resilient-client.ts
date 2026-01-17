import { log, createTimer } from "../logger.js";

// =============================================================================
// Resilient HTTP Client
// =============================================================================
// A production-grade HTTP client with:
// - Configurable retry with exponential backoff
// - Circuit breaker pattern for failing endpoints
// - Request timeout with AbortController
// - Error classification (transient vs permanent)
// - Metrics and logging hooks
//
// Design principles:
// - Fail fast on permanent errors (4xx except 429)
// - Retry on transient errors (5xx, timeouts, network errors)
// - Circuit breaker prevents cascading failures
// - Configurable per-endpoint settings
// =============================================================================

/**
 * HTTP request options
 */
export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string | object;
  timeout?: number;
}

/**
 * HTTP response wrapper
 */
export interface HttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: T;
  latencyMs: number;
}

/**
 * Retry policy configuration
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts (0 = no retries) */
  maxRetries: number;

  /** Base delay between retries (ms) */
  baseDelayMs: number;

  /** Maximum delay between retries (ms) */
  maxDelayMs: number;

  /** Multiplier for exponential backoff */
  backoffMultiplier: number;

  /** Add jitter to prevent thundering herd */
  jitter: boolean;

  /** HTTP status codes to retry on */
  retryableStatusCodes: number[];

  /** Whether to retry on timeout */
  retryOnTimeout: boolean;

  /** Whether to retry on network errors */
  retryOnNetworkError: boolean;
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Whether circuit breaker is enabled */
  enabled: boolean;

  /** Number of failures before opening circuit */
  failureThreshold: number;

  /** Number of successes in half-open to close circuit */
  successThreshold: number;

  /** Time to wait before attempting half-open (ms) */
  resetTimeoutMs: number;

  /** Window for counting failures (ms) */
  failureWindowMs: number;
}

/**
 * Complete client configuration
 */
export interface ResilientClientConfig {
  /** Default request timeout (ms) */
  defaultTimeout: number;

  /** Retry policy */
  retry: RetryPolicy;

  /** Circuit breaker config */
  circuitBreaker: CircuitBreakerConfig;

  /** Custom headers added to all requests */
  defaultHeaders: Record<string, string>;
}

/**
 * Circuit breaker states
 */
type CircuitState = "closed" | "open" | "half-open";

/**
 * Internal circuit breaker state
 */
interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  failureTimestamps: number[];
}

/**
 * Request result with retry info
 */
export interface RequestResult<T = unknown> {
  success: boolean;
  response?: HttpResponse<T>;
  error?: string;
  attempts: number;
  totalLatencyMs: number;
  circuitBreakerTripped?: boolean;
}

/**
 * Error classification
 */
export type ErrorType = "transient" | "permanent" | "timeout" | "circuit_open";

/**
 * Detailed error info
 */
export interface HttpError {
  type: ErrorType;
  message: string;
  status?: number;
  retryable: boolean;
}

// Default configurations
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  retryOnTimeout: true,
  retryOnNetworkError: true,
};

const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  enabled: true,
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeoutMs: 30000,
  failureWindowMs: 60000,
};

const DEFAULT_CONFIG: ResilientClientConfig = {
  defaultTimeout: 30000,
  retry: DEFAULT_RETRY_POLICY,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER,
  defaultHeaders: {
    "User-Agent": "BatchSender/1.0",
    "Content-Type": "application/json",
  },
};

/**
 * Resilient HTTP Client
 */
export class ResilientHttpClient {
  private config: ResilientClientConfig;
  private circuits: Map<string, CircuitBreakerState> = new Map();

  constructor(config: Partial<ResilientClientConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      retry: { ...DEFAULT_RETRY_POLICY, ...config.retry },
      circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER, ...config.circuitBreaker },
      defaultHeaders: { ...DEFAULT_CONFIG.defaultHeaders, ...config.defaultHeaders },
    };
  }

  /**
   * Execute an HTTP request with retry and circuit breaker
   */
  async request<T = unknown>(
    url: string,
    options: HttpRequestOptions = {}
  ): Promise<RequestResult<T>> {
    const timer = createTimer();
    const host = new URL(url).host;
    let attempts = 0;

    // Check circuit breaker
    if (this.config.circuitBreaker.enabled) {
      const circuitState = this.getCircuitState(host);

      if (circuitState === "open") {
        return {
          success: false,
          error: `Circuit breaker open for ${host}`,
          attempts: 0,
          totalLatencyMs: 0,
          circuitBreakerTripped: true,
        };
      }
    }

    // Attempt the request with retries
    let lastError: HttpError | null = null;

    for (let attempt = 0; attempt <= this.config.retry.maxRetries; attempt++) {
      attempts++;

      try {
        // Add delay for retries (not first attempt)
        if (attempt > 0) {
          const delay = this.calculateBackoff(attempt);
          log.system.debug({ url, attempt, delayMs: delay }, "retrying request");
          await this.sleep(delay);
        }

        const response = await this.executeRequest<T>(url, options);

        // Check if response is successful or should retry
        if (response.ok || !this.shouldRetry(response.status, attempt)) {
          // Record success for circuit breaker
          if (this.config.circuitBreaker.enabled) {
            this.recordSuccess(host);
          }

          return {
            success: response.ok,
            response,
            attempts,
            totalLatencyMs: this.parseLatency(timer()),
            error: response.ok ? undefined : `HTTP ${response.status}`,
          };
        }

        // Record failure for circuit breaker
        if (this.config.circuitBreaker.enabled) {
          this.recordFailure(host);
        }

        lastError = this.classifyError(response.status);
      } catch (error) {
        const err = error as Error;
        const isTimeout = err.name === "AbortError";
        const isNetworkError = err.name === "TypeError" || err.message.includes("fetch");

        // Determine if retryable
        const shouldRetry =
          (isTimeout && this.config.retry.retryOnTimeout) ||
          (isNetworkError && this.config.retry.retryOnNetworkError);

        if (!shouldRetry || attempt >= this.config.retry.maxRetries) {
          // Record failure for circuit breaker
          if (this.config.circuitBreaker.enabled) {
            this.recordFailure(host);
          }

          return {
            success: false,
            error: isTimeout ? "Request timeout" : err.message,
            attempts,
            totalLatencyMs: this.parseLatency(timer()),
          };
        }

        lastError = {
          type: isTimeout ? "timeout" : "transient",
          message: err.message,
          retryable: true,
        };

        // Record failure for circuit breaker
        if (this.config.circuitBreaker.enabled) {
          this.recordFailure(host);
        }
      }
    }

    // All retries exhausted
    return {
      success: false,
      error: lastError?.message || "Request failed after retries",
      attempts,
      totalLatencyMs: this.parseLatency(timer()),
    };
  }

  /**
   * Execute a single HTTP request without retry
   */
  private async executeRequest<T>(
    url: string,
    options: HttpRequestOptions
  ): Promise<HttpResponse<T>> {
    const start = Date.now();
    const timeout = options.timeout ?? this.config.defaultTimeout;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          ...this.config.defaultHeaders,
          ...options.headers,
        },
        body: options.body
          ? typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body)
          : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Parse response body
      let body: T;
      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        body = (await response.json()) as T;
      } else {
        body = (await response.text()) as unknown as T;
      }

      // Extract headers
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Determine if a request should be retried based on status code
   */
  private shouldRetry(status: number, currentAttempt: number): boolean {
    if (currentAttempt >= this.config.retry.maxRetries) {
      return false;
    }
    return this.config.retry.retryableStatusCodes.includes(status);
  }

  /**
   * Classify an error based on HTTP status
   */
  private classifyError(status: number): HttpError {
    // 4xx (except 429) are permanent errors
    if (status >= 400 && status < 500 && status !== 429 && status !== 408) {
      return {
        type: "permanent",
        message: `HTTP ${status}`,
        status,
        retryable: false,
      };
    }

    // 5xx and 429/408 are transient
    return {
      type: "transient",
      message: `HTTP ${status}`,
      status,
      retryable: true,
    };
  }

  /**
   * Calculate backoff delay for a retry attempt
   */
  private calculateBackoff(attempt: number): number {
    let delay = this.config.retry.baseDelayMs *
      Math.pow(this.config.retry.backoffMultiplier, attempt - 1);

    // Apply max cap
    delay = Math.min(delay, this.config.retry.maxDelayMs);

    // Apply jitter (±25%)
    if (this.config.retry.jitter) {
      const jitterFactor = 0.75 + Math.random() * 0.5;
      delay = Math.floor(delay * jitterFactor);
    }

    return delay;
  }

  /**
   * Get circuit breaker state for a host
   */
  private getCircuitState(host: string): CircuitState {
    const circuit = this.circuits.get(host);

    if (!circuit) {
      return "closed";
    }

    // Check if open circuit should transition to half-open
    if (circuit.state === "open") {
      const timeSinceLastFailure = Date.now() - circuit.lastFailureTime;
      if (timeSinceLastFailure >= this.config.circuitBreaker.resetTimeoutMs) {
        circuit.state = "half-open";
        circuit.successes = 0;
      }
    }

    return circuit.state;
  }

  /**
   * Record a successful request for circuit breaker
   */
  private recordSuccess(host: string): void {
    const circuit = this.circuits.get(host);

    if (!circuit) {
      return;
    }

    if (circuit.state === "half-open") {
      circuit.successes++;
      if (circuit.successes >= this.config.circuitBreaker.successThreshold) {
        // Close the circuit
        circuit.state = "closed";
        circuit.failures = 0;
        circuit.failureTimestamps = [];
        log.system.info({ host }, "circuit breaker closed");
      }
    } else if (circuit.state === "closed") {
      // Reset failures on success
      circuit.failures = 0;
      circuit.failureTimestamps = [];
    }
  }

  /**
   * Record a failed request for circuit breaker
   */
  private recordFailure(host: string): void {
    let circuit = this.circuits.get(host);

    if (!circuit) {
      circuit = {
        state: "closed",
        failures: 0,
        successes: 0,
        lastFailureTime: 0,
        failureTimestamps: [],
      };
      this.circuits.set(host, circuit);
    }

    const now = Date.now();
    circuit.lastFailureTime = now;
    circuit.failureTimestamps.push(now);

    // Remove old failures outside the window
    const windowStart = now - this.config.circuitBreaker.failureWindowMs;
    circuit.failureTimestamps = circuit.failureTimestamps.filter((t) => t > windowStart);
    circuit.failures = circuit.failureTimestamps.length;

    // Check if circuit should open
    if (circuit.state === "closed" || circuit.state === "half-open") {
      if (circuit.failures >= this.config.circuitBreaker.failureThreshold) {
        circuit.state = "open";
        log.system.warn(
          { host, failures: circuit.failures },
          "circuit breaker opened"
        );
      }
    }
  }

  /**
   * Get circuit breaker status for monitoring
   */
  getCircuitStatus(): Map<string, { state: CircuitState; failures: number }> {
    const status = new Map<string, { state: CircuitState; failures: number }>();

    for (const [host, circuit] of this.circuits) {
      status.set(host, {
        state: this.getCircuitState(host),
        failures: circuit.failures,
      });
    }

    return status;
  }

  /**
   * Reset circuit breaker for a specific host
   */
  resetCircuit(host: string): void {
    this.circuits.delete(host);
    log.system.info({ host }, "circuit breaker reset");
  }

  /**
   * Reset all circuit breakers
   */
  resetAllCircuits(): void {
    this.circuits.clear();
    log.system.info({}, "all circuit breakers reset");
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<ResilientClientConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
      retry: { ...this.config.retry, ...updates.retry },
      circuitBreaker: { ...this.config.circuitBreaker, ...updates.circuitBreaker },
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): ResilientClientConfig {
    return { ...this.config };
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Parse latency string to number
   */
  private parseLatency(latencyStr: string): number {
    if (latencyStr.endsWith("ms")) {
      return parseInt(latencyStr.replace("ms", ""));
    }
    if (latencyStr.endsWith("s")) {
      return parseFloat(latencyStr.replace("s", "")) * 1000;
    }
    return 0;
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Create a pre-configured client for webhook calls
 */
export function createWebhookClient(overrides?: Partial<ResilientClientConfig>): ResilientHttpClient {
  return new ResilientHttpClient({
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
    ...overrides,
  });
}

/**
 * Create a client with no retries (for time-sensitive operations)
 */
export function createNoRetryClient(timeout = 5000): ResilientHttpClient {
  return new ResilientHttpClient({
    defaultTimeout: timeout,
    retry: {
      ...DEFAULT_RETRY_POLICY,
      maxRetries: 0,
    },
    circuitBreaker: {
      ...DEFAULT_CIRCUIT_BREAKER,
      enabled: false,
    },
  });
}

// Export singleton for general use
let defaultClient: ResilientHttpClient | null = null;

export function getDefaultHttpClient(): ResilientHttpClient {
  if (!defaultClient) {
    defaultClient = new ResilientHttpClient();
  }
  return defaultClient;
}
