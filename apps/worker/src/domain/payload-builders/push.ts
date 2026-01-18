/**
 * Push notification payload builder - pure function.
 */

import type {
  RecipientInfo,
  PushJobPayload,
  PushModuleConfig,
  PushBatchPayload,
} from "./types.js";

export interface PushPayloadContext {
  config: PushModuleConfig;
  batchPayload?: PushBatchPayload;
  recipient: RecipientInfo;
}

/**
 * Build a push notification job payload.
 *
 * @param context - Push configuration context
 * @returns Complete push job payload
 */
export function buildPushPayload(context: PushPayloadContext): PushJobPayload {
  const { batchPayload, recipient } = context;

  return {
    to: recipient.identifier,
    name: recipient.name,
    variables: recipient.variables,
    title: batchPayload?.title,
    body: batchPayload?.body,
    data: batchPayload?.data,
  };
}

/**
 * Validate push payload has minimum required fields.
 */
export function validatePushPayload(payload: PushJobPayload): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!payload.to) {
    errors.push("Missing recipient device token (to)");
  }

  if (!payload.title && !payload.body) {
    errors.push("Missing push notification content (title or body required)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
