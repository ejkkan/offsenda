/**
 * Types for payload building.
 * Shared across all module-specific payload builders.
 *
 * Module and batch config types are imported from @batchsender/db (single source of truth).
 * Local types define the payload builder interfaces.
 */

// Import shared types from source of truth
import type {
  EmailModuleConfig,
  SmsModuleConfig,
  PushModuleConfig,
  WebhookModuleConfig,
  EmailBatchPayload,
  SmsBatchPayload,
  PushBatchPayload,
  WebhookBatchPayload,
  BatchPayload,
} from "@batchsender/db";

// Re-export for backwards compatibility
export type {
  EmailModuleConfig,
  SmsModuleConfig,
  PushModuleConfig,
  WebhookModuleConfig,
  EmailBatchPayload,
  SmsBatchPayload,
  PushBatchPayload,
  WebhookBatchPayload,
  BatchPayload,
};

// =============================================================================
// LOCAL TYPES - Specific to payload building logic
// =============================================================================

export interface RecipientInfo {
  identifier: string;
  name?: string;
  variables?: Record<string, string>;
}

export interface LegacyEmailFields {
  fromEmail?: string;
  fromName?: string;
  subject?: string;
  htmlContent?: string;
  textContent?: string;
}

export interface BaseJobPayload {
  to: string;
  name?: string;
  variables?: Record<string, string>;
}

export interface EmailJobPayload extends BaseJobPayload {
  fromEmail?: string;
  fromName?: string;
  subject?: string;
  htmlContent?: string;
  textContent?: string;
}

export interface SmsJobPayload extends BaseJobPayload {
  fromNumber?: string;
  message?: string;
}

export interface PushJobPayload extends BaseJobPayload {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface WebhookJobPayload extends BaseJobPayload {
  data?: Record<string, unknown>;
}

export type JobPayload = EmailJobPayload | SmsJobPayload | PushJobPayload | WebhookJobPayload;
