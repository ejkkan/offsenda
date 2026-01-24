/**
 * BYOK Flow Context Builder
 *
 * Builds rate limiter context for BYOK (Bring Your Own Key) mode where
 * users provide their own endpoint (webhook) or credentials.
 *
 * In the simplified model, BYOK is primarily used for:
 * - Webhook module: User's custom HTTP endpoints
 *
 * Rate limit composition: only user's configured limit (per sendConfig)
 * No shared provider limit - user controls their own endpoint capacity.
 */

import type { SendConfigData } from "@batchsender/db";
import type { RateLimiterContext, ModuleType } from "./types.js";

/**
 * Build rate limiter context for BYOK webhook flow
 */
export function buildByokWebhookContext(
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  return {
    mode: "byok",
    provider: "webhook",
    module: "email", // Webhooks are treated as email module for rate limiting purposes
    sendConfigId,
    userId,
  };
}

/**
 * Build rate limiter context for any BYOK module
 *
 * In the simplified model, only webhook module uses BYOK.
 * Email/SMS are always managed (platform services).
 */
export function buildByokContext(
  _module: ModuleType,
  _moduleConfig: SendConfigData,
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  // All BYOK contexts use the webhook pattern
  return buildByokWebhookContext(sendConfigId, userId);
}

// Legacy exports for backwards compatibility
// These are kept for tests but will always return webhook context

/**
 * @deprecated Use buildByokWebhookContext instead
 * Email module is now platform-only (managed mode)
 */
export function buildByokEmailContext(
  _moduleConfig: unknown,
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  return buildByokWebhookContext(sendConfigId, userId);
}

/**
 * @deprecated Use buildByokWebhookContext instead
 * SMS module is now platform-only (managed mode)
 */
export function buildByokSmsContext(
  _moduleConfig: unknown,
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  return buildByokWebhookContext(sendConfigId, userId);
}
