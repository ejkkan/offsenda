/**
 * Email payload builder - pure function.
 * Builds the final email job payload from config, batch payload, and legacy fields.
 */

import type {
  RecipientInfo,
  LegacyEmailFields,
  EmailJobPayload,
  EmailModuleConfig,
  EmailBatchPayload,
} from "./types.js";

export interface EmailPayloadContext {
  config: EmailModuleConfig;
  batchPayload?: EmailBatchPayload;
  legacyFields: LegacyEmailFields;
  recipient: RecipientInfo;
}

/**
 * Build an email job payload.
 *
 * Priority order for fields:
 * 1. Batch payload (per-batch customization)
 * 2. Legacy fields (backwards compatibility)
 * 3. Module config (defaults from send config)
 *
 * @param context - All sources of email configuration
 * @returns Complete email job payload
 *
 * @example
 * const payload = buildEmailPayload({
 *   config: { fromEmail: 'default@example.com' },
 *   batchPayload: { subject: 'Hello!' },
 *   legacyFields: { fromName: 'Legacy Name' },
 *   recipient: { identifier: 'user@example.com', name: 'User' }
 * });
 * // Result: { to: 'user@example.com', name: 'User', subject: 'Hello!', fromEmail: 'default@example.com', fromName: 'Legacy Name' }
 */
export function buildEmailPayload(context: EmailPayloadContext): EmailJobPayload {
  const { config, batchPayload, legacyFields, recipient } = context;

  return {
    to: recipient.identifier,
    name: recipient.name,
    variables: recipient.variables,
    fromEmail: batchPayload?.fromEmail || legacyFields.fromEmail || config.fromEmail,
    fromName: batchPayload?.fromName || legacyFields.fromName || config.fromName,
    subject: batchPayload?.subject || legacyFields.subject,
    htmlContent: batchPayload?.htmlContent || legacyFields.htmlContent,
    textContent: batchPayload?.textContent || legacyFields.textContent,
  };
}

/**
 * Validate email payload has minimum required fields.
 *
 * @param payload - Email payload to validate
 * @returns Validation result with errors if any
 */
export function validateEmailPayload(payload: EmailJobPayload): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!payload.to) {
    errors.push("Missing recipient email address (to)");
  }

  if (!payload.fromEmail) {
    errors.push("Missing sender email address (fromEmail)");
  }

  if (!payload.subject) {
    errors.push("Missing email subject");
  }

  if (!payload.htmlContent && !payload.textContent) {
    errors.push("Missing email content (htmlContent or textContent required)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
