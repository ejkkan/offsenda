/**
 * Payload builders - pure functions for building job payloads.
 *
 * These are fully unit-testable with no side effects or dependencies.
 */

export * from "./types.js";
export * from "./email.js";
export * from "./sms.js";
export * from "./push.js";
export * from "./webhook.js";

import type { JobPayload, RecipientInfo, LegacyEmailFields, BatchPayload } from "./types.js";
import { buildEmailPayload } from "./email.js";
import { buildSmsPayload } from "./sms.js";
import { buildPushPayload } from "./push.js";
import { buildWebhookPayload } from "./webhook.js";

export type ModuleType = "email" | "sms" | "push" | "webhook";

export interface SendConfig {
  id: string;
  module: ModuleType;
  config: Record<string, unknown>;
  rateLimit?: { perSecond: number };
}

export interface PayloadBuildContext {
  sendConfig: SendConfig;
  batchPayload?: BatchPayload;
  legacyFields: LegacyEmailFields;
  recipient: RecipientInfo;
  webhookData?: Record<string, unknown>;
}

/**
 * Build a job payload based on module type.
 * Factory function that delegates to module-specific builders.
 *
 * @param context - Complete context for building payload
 * @returns Job payload for the specific module type
 */
export function buildJobPayload(context: PayloadBuildContext): JobPayload {
  const { sendConfig, batchPayload, legacyFields, recipient, webhookData } = context;

  switch (sendConfig.module) {
    case "email":
      return buildEmailPayload({
        config: sendConfig.config as any,
        batchPayload: batchPayload as any,
        legacyFields,
        recipient,
      });

    case "sms":
      return buildSmsPayload({
        config: sendConfig.config as any,
        batchPayload: batchPayload as any,
        recipient,
      });

    case "push":
      return buildPushPayload({
        config: sendConfig.config as any,
        batchPayload: batchPayload as any,
        recipient,
      });

    case "webhook":
      return buildWebhookPayload({
        config: sendConfig.config as any,
        batchPayload: batchPayload as any,
        recipient,
        webhookData,
      });

    default:
      throw new Error(`Unknown module type: ${sendConfig.module}`);
  }
}
