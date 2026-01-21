/**
 * Shared Types - Single Source of Truth
 *
 * This module consolidates all shared type definitions for the worker.
 * Import types from here instead of scattered locations.
 *
 * @example
 * import { JobData, EventType, CircuitBreakerConfig } from "./types";
 *
 * Source hierarchy:
 * 1. @batchsender/db - Database entities, enums, configs (re-exported here)
 * 2. ./types/jobs.ts - NATS message types
 * 3. ./types/events.ts - Event logging types
 * 4. ./types/domain.ts - Domain pattern types
 */

// =============================================================================
// RE-EXPORTS FROM @batchsender/db (Source of Truth for domain types)
// =============================================================================
export type {
  // Enums
  ModuleType,
  BatchStatus,
  RecipientStatus,
  // Config types
  SendConfigData,
  EmailModuleConfig,
  WebhookModuleConfig,
  SmsModuleConfig,
  PushModuleConfig,
  // Batch payloads
  BatchPayload,
  EmailBatchPayload,
  SmsBatchPayload,
  WebhookBatchPayload,
  PushBatchPayload,
  // Rate limiting
  RateLimitConfig,
  // Database entities
  SendConfig,
  Batch,
  Recipient,
  User,
} from "@batchsender/db";

// =============================================================================
// JOB TYPES (NATS messaging)
// =============================================================================
export type {
  BatchJobData,
  EmbeddedSendConfig,
  JobData,
  EmailJobData,
  QueueStats,
  StreamStats,
  EnqueueResult,
} from "./jobs.js";

// =============================================================================
// EVENT TYPES (ClickHouse logging, webhooks)
// =============================================================================
export type {
  EventType,
  EmailEventType,
  EmailEvent,
  WebhookEvent,
  WebhookBatch,
} from "./events.js";

// =============================================================================
// DOMAIN PATTERN TYPES
// =============================================================================
export type {
  // Circuit breaker
  CircuitState,
  CircuitBreakerState,
  CircuitBreakerConfig,
  CircuitBreakerStatus,
  // Idempotency
  ProcessedStatus,
  IdempotencyCheckResult,
  IdempotencyChecker,
  // Rate limiting
  RateLimitMode,
  ManagedProvider,
  RateLimiterContext,
  LimitingFactor,
  ComposedRateLimitResult,
} from "./domain.js";

// Re-export constant
export { REDIS_KEY_PREFIXES } from "./domain.js";
