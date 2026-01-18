/**
 * Pure utility functions for exponential backoff calculation.
 * These are fully unit-testable with no side effects.
 */

export interface BackoffOptions {
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 to add randomness (default: 0) */
  jitterFactor?: number;
}

const DEFAULT_BACKOFF_OPTIONS: Required<BackoffOptions> = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0,
};

/**
 * Calculate exponential backoff delay.
 *
 * @param attempt - The attempt number (0-indexed, so first retry is attempt 0)
 * @param options - Backoff configuration options
 * @returns Delay in milliseconds
 *
 * @example
 * // Default: 1s, 2s, 4s, 8s, 16s, 30s (capped)
 * calculateBackoff(0) // 1000
 * calculateBackoff(1) // 2000
 * calculateBackoff(5) // 30000 (capped)
 *
 * @example
 * // Custom base and max
 * calculateBackoff(2, { baseDelayMs: 500, maxDelayMs: 10000 }) // 2000
 */
export function calculateBackoff(attempt: number, options?: BackoffOptions): number {
  const { baseDelayMs, maxDelayMs, jitterFactor } = {
    ...DEFAULT_BACKOFF_OPTIONS,
    ...options,
  };

  // Calculate base exponential delay
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

  // Cap at maximum
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter if configured
  if (jitterFactor > 0) {
    const jitter = cappedDelay * jitterFactor * Math.random();
    return Math.floor(cappedDelay + jitter);
  }

  return cappedDelay;
}

/**
 * Calculate backoff for NATS message redelivery.
 * Uses redeliveryCount which is 1-indexed (first redelivery = 1).
 *
 * @param redeliveryCount - NATS redelivery count (1-indexed)
 * @param options - Backoff configuration
 * @returns Delay in milliseconds
 */
export function calculateNatsBackoff(
  redeliveryCount: number,
  options?: BackoffOptions
): number {
  // Convert 1-indexed redeliveryCount to 0-indexed attempt
  const attempt = Math.max(0, redeliveryCount - 1);
  return calculateBackoff(attempt, options);
}

/**
 * Batch processor specific backoff with longer delays.
 * First retry: 5s, then 10s, 20s, 40s, up to 60s max.
 */
export function calculateBatchBackoff(redeliveryCount: number): number {
  return calculateNatsBackoff(redeliveryCount, {
    baseDelayMs: 5000,
    maxDelayMs: 60000,
  });
}

/**
 * Email processor specific backoff.
 * First retry: 1s, then 2s, 4s, 8s, up to 30s max.
 */
export function calculateEmailBackoff(redeliveryCount: number): number {
  return calculateNatsBackoff(redeliveryCount, {
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  });
}
