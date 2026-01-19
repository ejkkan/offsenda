/**
 * System Limits - Creation-time limits for the platform
 *
 * These limits are checked when users create batches.
 * Simple approach: limit at creation, process as fast as provider allows at runtime.
 */

export const LIMITS = {
  // ═══════════════════════════════════════════════════════════════════════════
  // BATCH CREATION LIMITS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Max jobs/recipients in a single batch */
  maxBatchSize: 100_000,

  /** Max recipients per request (for chunked uploads) */
  maxRecipientsPerRequest: 10_000,

  /** Max total pending/processing jobs per user */
  maxPendingJobsPerUser: 1_000_000,

  /** Max active (non-completed) batches per user */
  maxActiveBatchesPerUser: 50,

  /** Max days in advance a batch can be scheduled */
  maxScheduleAheadDays: 30,

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND CONFIG LIMITS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Max send configs per user */
  maxSendConfigsPerUser: 20,

  // ═══════════════════════════════════════════════════════════════════════════
  // PROVIDER DEFAULTS (used when user doesn't specify rate limit)
  // ═══════════════════════════════════════════════════════════════════════════

  providerDefaults: {
    /** AWS SES default rate (sandbox-safe) */
    ses: { perSecond: 14 },

    /** Resend default rate */
    resend: { perSecond: 100 },

    /** Webhook default rate (conservative) */
    webhook: { perSecond: 50 },

    /** Managed email (our infrastructure) */
    managed: { perSecond: 100 },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RATE LIMIT BOUNDS (for validating user-configured limits)
  // ═══════════════════════════════════════════════════════════════════════════

  rateLimitBounds: {
    minPerSecond: 1,
    maxPerSecond: 500,
  },
} as const;

export type Limits = typeof LIMITS;
