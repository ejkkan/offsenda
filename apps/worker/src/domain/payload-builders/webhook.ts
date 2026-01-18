/**
 * Webhook payload builder - pure function.
 */

import type {
  RecipientInfo,
  WebhookJobPayload,
  WebhookModuleConfig,
  WebhookBatchPayload,
} from "./types.js";

export interface WebhookPayloadContext {
  config: WebhookModuleConfig;
  batchPayload?: WebhookBatchPayload;
  recipient: RecipientInfo;
  /** Additional webhook data passed at job level */
  webhookData?: Record<string, unknown>;
}

/**
 * Build a webhook job payload.
 *
 * @param context - Webhook configuration context
 * @returns Complete webhook job payload
 */
export function buildWebhookPayload(context: WebhookPayloadContext): WebhookJobPayload {
  const { batchPayload, recipient, webhookData } = context;

  return {
    to: recipient.identifier,
    name: recipient.name,
    variables: recipient.variables,
    data: batchPayload?.body || webhookData,
  };
}

/**
 * Validate webhook payload has minimum required fields.
 */
export function validateWebhookPayload(payload: WebhookJobPayload): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!payload.to) {
    errors.push("Missing webhook target (to)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
