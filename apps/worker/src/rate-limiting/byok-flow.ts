/**
 * BYOK Flow Context Builder
 *
 * Builds rate limiter context for BYOK (Bring Your Own Key) mode where
 * users provide their own provider credentials.
 *
 * Rate limit composition: MIN(system, tier, sendConfig)
 * No shared provider limit - user has their own account capacity.
 */

import type { EmailModuleConfig, SmsModuleConfig } from "@batchsender/db";
import type { RateLimiterContext, ModuleType } from "./types.js";

/**
 * Get the provider string from email config
 */
function getEmailProvider(moduleConfig: EmailModuleConfig): string {
  // In BYOK mode, provider is explicitly set
  return moduleConfig.provider || "resend";
}

/**
 * Get the provider string from SMS config
 */
function getSmsProvider(moduleConfig: SmsModuleConfig): string {
  return moduleConfig.provider;
}

/**
 * Build rate limiter context for BYOK email flow
 */
export function buildByokEmailContext(
  moduleConfig: EmailModuleConfig,
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  return {
    mode: "byok",
    provider: getEmailProvider(moduleConfig),
    module: "email",
    sendConfigId,
    userId,
  };
}

/**
 * Build rate limiter context for BYOK SMS flow
 */
export function buildByokSmsContext(
  moduleConfig: SmsModuleConfig,
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  return {
    mode: "byok",
    provider: getSmsProvider(moduleConfig),
    module: "sms",
    sendConfigId,
    userId,
  };
}

/**
 * Build rate limiter context for any BYOK module
 */
export function buildByokContext(
  module: ModuleType,
  moduleConfig: EmailModuleConfig | SmsModuleConfig,
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  if (module === "email") {
    return buildByokEmailContext(moduleConfig as EmailModuleConfig, sendConfigId, userId);
  }
  return buildByokSmsContext(moduleConfig as SmsModuleConfig, sendConfigId, userId);
}
