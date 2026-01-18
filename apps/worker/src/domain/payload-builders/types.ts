/**
 * Types for payload building.
 * Shared across all module-specific payload builders.
 */

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

// Module configs (simplified for payload building)
export interface EmailModuleConfig {
  mode?: string;
  fromEmail?: string;
  fromName?: string;
}

export interface SmsModuleConfig {
  fromNumber?: string;
}

export interface PushModuleConfig {
  // Push-specific config
}

export interface WebhookModuleConfig {
  url?: string;
}

// Batch payloads
export interface EmailBatchPayload {
  fromEmail?: string;
  fromName?: string;
  subject?: string;
  htmlContent?: string;
  textContent?: string;
}

export interface SmsBatchPayload {
  message?: string;
  fromNumber?: string;
}

export interface PushBatchPayload {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface WebhookBatchPayload {
  body?: Record<string, unknown>;
}

export type BatchPayload = EmailBatchPayload | SmsBatchPayload | PushBatchPayload | WebhookBatchPayload;
