/**
 * Recipient grouping utilities - pure functions.
 * Used by PostgreSQL sync service for bulk updates.
 */

export type RecipientStatus = "pending" | "queued" | "sent" | "failed" | "bounced" | "complained";

export interface RecipientState {
  status: RecipientStatus;
  sentAt?: number;
  providerMessageId?: string;
  errorMessage?: string;
}

export interface SentRecipient {
  id: string;
  sentAt: Date;
  providerMessageId: string;
}

export interface FailedRecipient {
  id: string;
  errorMessage: string;
}

export interface RecipientGroups {
  sent: SentRecipient[];
  failed: FailedRecipient[];
}

/**
 * Group recipients by status for efficient bulk database updates.
 *
 * @param states - Map of recipient ID to state
 * @returns Recipients grouped by status
 *
 * @example
 * const states = new Map([
 *   ['r1', { status: 'sent', sentAt: 1234567890, providerMessageId: 'msg-1' }],
 *   ['r2', { status: 'failed', errorMessage: 'Connection timeout' }],
 * ]);
 * const groups = groupRecipientsByStatus(states);
 * // groups.sent = [{ id: 'r1', sentAt: Date, providerMessageId: 'msg-1' }]
 * // groups.failed = [{ id: 'r2', errorMessage: 'Connection timeout' }]
 */
export function groupRecipientsByStatus(
  states: Map<string, RecipientState>
): RecipientGroups {
  const sent: SentRecipient[] = [];
  const failed: FailedRecipient[] = [];

  for (const [recipientId, state] of states) {
    if (state.status === "sent") {
      sent.push({
        id: recipientId,
        sentAt: state.sentAt ? new Date(state.sentAt) : new Date(),
        providerMessageId: state.providerMessageId || "",
      });
    } else if (state.status === "failed") {
      failed.push({
        id: recipientId,
        errorMessage: state.errorMessage || "",
      });
    }
  }

  return { sent, failed };
}

/**
 * Check if a recipient status is terminal (no more processing needed).
 */
export function isTerminalStatus(status: RecipientStatus): boolean {
  return status === "sent" || status === "failed" || status === "bounced" || status === "complained";
}

/**
 * Get counts by status from a map of recipient states.
 */
export function countByStatus(states: Map<string, RecipientState>): Record<RecipientStatus, number> {
  const counts: Record<RecipientStatus, number> = {
    pending: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    bounced: 0,
    complained: 0,
  };

  for (const state of states.values()) {
    counts[state.status]++;
  }

  return counts;
}
