/**
 * Idempotency checking types.
 */

export type ProcessedStatus = "sent" | "failed" | "bounced" | "complained";

export interface IdempotencyCheckResult {
  /** Whether the recipient was already processed */
  processed: boolean;
  /** The status if processed, null otherwise */
  status: ProcessedStatus | null;
  /** Source of the check result */
  source: "cache" | "database" | "unknown";
}

/**
 * Idempotency checker interface for dependency injection.
 * Allows swapping implementations for testing.
 */
export interface IdempotencyChecker {
  /**
   * Check if a recipient has already been processed.
   *
   * @param batchId - Batch identifier
   * @param recipientId - Recipient identifier
   * @returns Check result with processed status
   * @throws If check cannot be performed and we should fail-safe
   */
  check(batchId: string, recipientId: string): Promise<IdempotencyCheckResult>;

  /**
   * Check if the checker is available (circuit not open, etc.)
   */
  isAvailable(): boolean;
}
