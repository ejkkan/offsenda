/**
 * Idempotency checker implementations.
 */

import type { IdempotencyChecker, IdempotencyCheckResult, ProcessedStatus } from "./types.js";

/**
 * Always returns not processed (for testing).
 */
export class AlwaysAllowChecker implements IdempotencyChecker {
  async check(): Promise<IdempotencyCheckResult> {
    return {
      processed: false,
      status: null,
      source: "unknown",
    };
  }

  isAvailable(): boolean {
    return true;
  }
}

/**
 * Always returns already processed (for testing).
 */
export class AlwaysBlockChecker implements IdempotencyChecker {
  constructor(private status: ProcessedStatus = "sent") {}

  async check(): Promise<IdempotencyCheckResult> {
    return {
      processed: true,
      status: this.status,
      source: "unknown",
    };
  }

  isAvailable(): boolean {
    return true;
  }
}

/**
 * In-memory idempotency checker (for testing).
 */
export class InMemoryIdempotencyChecker implements IdempotencyChecker {
  private processed = new Map<string, ProcessedStatus>();

  async check(batchId: string, recipientId: string): Promise<IdempotencyCheckResult> {
    const key = `${batchId}:${recipientId}`;
    const status = this.processed.get(key);

    if (status) {
      return {
        processed: true,
        status,
        source: "cache",
      };
    }

    return {
      processed: false,
      status: null,
      source: "cache",
    };
  }

  isAvailable(): boolean {
    return true;
  }

  /** Mark a recipient as processed (for testing) */
  markProcessed(batchId: string, recipientId: string, status: ProcessedStatus): void {
    const key = `${batchId}:${recipientId}`;
    this.processed.set(key, status);
  }

  /** Clear all processed records */
  clear(): void {
    this.processed.clear();
  }
}

/**
 * Composite checker that tries multiple checkers in order.
 * Falls back to next checker if current one fails.
 */
export class CompositeIdempotencyChecker implements IdempotencyChecker {
  constructor(private checkers: IdempotencyChecker[]) {
    if (checkers.length === 0) {
      throw new Error("At least one checker is required");
    }
  }

  async check(batchId: string, recipientId: string): Promise<IdempotencyCheckResult> {
    let lastError: Error | null = null;

    for (const checker of this.checkers) {
      if (!checker.isAvailable()) {
        continue;
      }

      try {
        const result = await checker.check(batchId, recipientId);
        return result;
      } catch (error) {
        lastError = error as Error;
        // Continue to next checker
      }
    }

    // All checkers failed
    if (lastError) {
      throw new Error(`All idempotency checkers failed: ${lastError.message}`);
    }

    throw new Error("No available idempotency checkers");
  }

  isAvailable(): boolean {
    return this.checkers.some((c) => c.isAvailable());
  }
}
