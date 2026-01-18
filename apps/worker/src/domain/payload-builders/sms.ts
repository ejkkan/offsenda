/**
 * SMS payload builder - pure function.
 */

import type {
  RecipientInfo,
  SmsJobPayload,
  SmsModuleConfig,
  SmsBatchPayload,
} from "./types.js";

export interface SmsPayloadContext {
  config: SmsModuleConfig;
  batchPayload?: SmsBatchPayload;
  recipient: RecipientInfo;
}

/**
 * Build an SMS job payload.
 *
 * @param context - SMS configuration context
 * @returns Complete SMS job payload
 */
export function buildSmsPayload(context: SmsPayloadContext): SmsJobPayload {
  const { config, batchPayload, recipient } = context;

  return {
    to: recipient.identifier,
    name: recipient.name,
    variables: recipient.variables,
    fromNumber: batchPayload?.fromNumber || config.fromNumber,
    message: batchPayload?.message,
  };
}

/**
 * Validate SMS payload has minimum required fields.
 */
export function validateSmsPayload(payload: SmsJobPayload): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!payload.to) {
    errors.push("Missing recipient phone number (to)");
  }

  if (!payload.message) {
    errors.push("Missing SMS message");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
