/**
 * Job Types - Shared across worker modules
 *
 * Single source of truth for NATS message types used in:
 * - Queue service
 * - Workers
 * - Batch processing
 */

import type {
  ModuleType,
  SendConfigData,
  RateLimitConfig,
  BatchPayload,
} from "@batchsender/db";

// Re-export from source of truth
export type {
  ModuleType,
  SendConfigData,
  RateLimitConfig,
  BatchPayload,
  EmailBatchPayload,
  SmsBatchPayload,
  WebhookBatchPayload,
  PushBatchPayload,
} from "@batchsender/db";

/**
 * Batch processing job - triggers processing of a batch
 */
export interface BatchJobData {
  batchId: string;
  userId: string;
  dryRun?: boolean;
}

/**
 * Embedded send config - included in job messages to avoid DB lookups
 */
export interface EmbeddedSendConfig {
  id: string;
  module: ModuleType;
  config: SendConfigData;
  rateLimit?: RateLimitConfig | null;
}

/**
 * Job data for processing a single recipient.
 *
 * Uses `identifier` for the recipient address (works for email, phone, URL, etc.)
 * and `payload` for module-specific content.
 *
 * Legacy fields (email, fromEmail, subject, etc.) are kept for backwards
 * compatibility with existing database records. New code should use `payload`.
 */
export interface JobData {
  batchId: string;
  recipientId: string;
  userId: string;

  /** Recipient address - works for any channel (email, phone, device token, URL) */
  identifier: string;

  /** Recipient display name */
  name?: string;

  /** Variable substitutions for templates */
  variables?: Record<string, string>;

  /** Embedded send config (no DB lookup needed during processing) */
  sendConfig: EmbeddedSendConfig;

  /** Module-specific payload - PREFERRED for new code */
  payload?: BatchPayload;

  /** Dry run mode - skip actual outbound calls */
  dryRun?: boolean;

  /** Webhook-specific data (for webhook module) */
  data?: Record<string, unknown>;

  // ===========================================================================
  // LEGACY FIELDS - Kept for backwards compatibility with existing DB records
  // New batches should use `payload` instead. These fields will be removed
  // after database migration consolidates to payload-only storage.
  // ===========================================================================

  /** @deprecated Use `identifier` instead */
  email?: string;

  /** @deprecated Use `payload.fromEmail` instead */
  fromEmail?: string;

  /** @deprecated Use `payload.fromName` instead */
  fromName?: string;

  /** @deprecated Use `payload.subject` instead */
  subject?: string;

  /** @deprecated Use `payload.htmlContent` instead */
  htmlContent?: string;

  /** @deprecated Use `payload.textContent` instead */
  textContent?: string;
}

/**
 * @deprecated Use JobData instead
 */
export type EmailJobData = JobData;

/**
 * Queue statistics for monitoring
 */
export interface QueueStats {
  pending: number;
  consumers: number;
  bytes: number;
  oldestMessageAge?: number;
}

/**
 * Stream statistics for all queues
 */
export interface StreamStats {
  batch: QueueStats;
  email: QueueStats;
  priority: QueueStats;
}

/**
 * Result of enqueueing jobs
 */
export interface EnqueueResult {
  success: number;
  failed: number;
  errors: Array<{ email: string; error: string }>;
}
