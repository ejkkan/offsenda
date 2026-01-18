/**
 * Retry strategy implementations.
 * Fully testable with dependency injection for delays.
 */

import { calculateBackoff } from "./backoff.js";

export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay in ms between retries */
  baseDelayMs?: number;
  /** Maximum delay in ms */
  maxDelayMs?: number;
  /** Whether to use exponential backoff (default: true) */
  exponential?: boolean;
  /** Callback for each retry attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export interface RetryResult<T> {
  success: boolean;
  value?: T;
  error?: Error;
  attempts: number;
}

export interface DelayProvider {
  delay(ms: number): Promise<void>;
}

/**
 * Default delay provider using setTimeout.
 */
export class TimeoutDelayProvider implements DelayProvider {
  async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Mock delay provider for testing (instant delays).
 */
export class InstantDelayProvider implements DelayProvider {
  public delays: number[] = [];

  async delay(ms: number): Promise<void> {
    this.delays.push(ms);
    // No actual delay
  }
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "onRetry">> = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  exponential: true,
};

/**
 * Execute an operation with retry logic.
 *
 * @param operation - Async operation to execute
 * @param options - Retry configuration
 * @param delayProvider - Delay implementation (for testing)
 * @returns Result with success status, value or error, and attempt count
 *
 * @example
 * const result = await executeWithRetry(
 *   () => fetch('https://api.example.com/data'),
 *   { maxRetries: 3, baseDelayMs: 1000 }
 * );
 * if (result.success) {
 *   console.log(result.value);
 * } else {
 *   console.error(`Failed after ${result.attempts} attempts:`, result.error);
 * }
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  delayProvider: DelayProvider = new TimeoutDelayProvider()
): Promise<RetryResult<T>> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const value = await operation();
      return {
        success: true,
        value,
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error as Error;

      if (attempt < config.maxRetries) {
        const delayMs = config.exponential
          ? calculateBackoff(attempt, {
              baseDelayMs: config.baseDelayMs,
              maxDelayMs: config.maxDelayMs,
            })
          : config.baseDelayMs;

        if (options.onRetry) {
          options.onRetry(attempt + 1, lastError, delayMs);
        }

        await delayProvider.delay(delayMs);
      }
    }
  }

  return {
    success: false,
    error: lastError!,
    attempts: config.maxRetries + 1,
  };
}

/**
 * Retry strategy interface for dependency injection.
 */
export interface RetryStrategy {
  execute<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Exponential backoff retry strategy.
 */
export class ExponentialBackoffRetry implements RetryStrategy {
  constructor(
    private options: RetryOptions = { maxRetries: 3 },
    private delayProvider: DelayProvider = new TimeoutDelayProvider()
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const result = await executeWithRetry(operation, this.options, this.delayProvider);
    if (result.success) {
      return result.value!;
    }
    throw result.error;
  }
}

/**
 * No-retry strategy (for testing or when retries are disabled).
 */
export class NoRetryStrategy implements RetryStrategy {
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
