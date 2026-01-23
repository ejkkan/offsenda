/**
 * Event Types - Shared across worker modules
 *
 * Single source of truth for event-related types used in:
 * - ClickHouse logging
 * - Webhook processing
 * - Buffered logger
 */

import type { ModuleType } from "@batchsender/db";

// Re-export ModuleType from source of truth
export type { ModuleType } from "@batchsender/db";

/**
 * Core event types for recipient lifecycle tracking
 */
export type CoreEventType =
  | "queued"
  | "sent"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "soft_bounced"
  | "complained"
  | "failed";

/**
 * SMS-specific event types
 */
export type SmsEventType =
  | "sms.delivered"
  | "sms.failed";

/**
 * Custom module event types
 */
export type CustomEventType =
  | "custom.event";

/**
 * All event types (email, SMS, custom)
 */
export type EventType = CoreEventType | SmsEventType | CustomEventType;

/**
 * @deprecated Use EventType instead
 */
export type EmailEventType = EventType;

/**
 * Event record for ClickHouse logging
 */
export interface EmailEvent {
  event_type: EventType;
  module_type?: ModuleType;
  batch_id: string;
  recipient_id: string;
  user_id: string;
  email: string;
  provider_message_id?: string;
  metadata?: Record<string, unknown>;
  error_message?: string;
}

/**
 * Webhook event from email providers (Resend, SES, Telnyx)
 */
export interface WebhookEvent {
  /** Event type from provider */
  type: string;
  /** Provider-specific message ID */
  providerMessageId: string;
  /** Timestamp of the event */
  timestamp: Date;
  /** Provider name */
  provider: string;
  /** Additional metadata from provider */
  metadata?: Record<string, unknown>;
}

/**
 * Batch of webhook events for processing
 */
export interface WebhookBatch {
  events: WebhookEvent[];
  receivedAt: Date;
}
