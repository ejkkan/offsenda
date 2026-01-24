/**
 * Managed Flow Context Builder
 *
 * Builds rate limiter context for platform services where users use
 * BatchSender's managed provider accounts (SES, Resend, Telnyx).
 *
 * Rate limit composition: MIN(system, managed_provider, tier, sendConfig)
 * All users using the same service SHARE the provider limit.
 */

import type { EmailModuleConfig, SmsModuleConfig } from "@batchsender/db";
import type { RateLimiterContext, ManagedProvider, ModuleType } from "./types.js";

/**
 * Get the managed provider from email config
 */
function getEmailServiceProvider(moduleConfig: EmailModuleConfig): ManagedProvider {
  return moduleConfig.service;
}

/**
 * Get the managed provider from SMS config
 * Currently only Telnyx is supported
 */
function getSmsServiceProvider(_moduleConfig: SmsModuleConfig): ManagedProvider {
  return "telnyx";
}

/**
 * Build rate limiter context for managed email flow
 */
export function buildManagedEmailContext(
  moduleConfig: EmailModuleConfig,
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  return {
    mode: "managed",
    provider: getEmailServiceProvider(moduleConfig),
    module: "email",
    sendConfigId,
    userId,
  };
}

/**
 * Build rate limiter context for managed SMS flow
 */
export function buildManagedSmsContext(
  moduleConfig: SmsModuleConfig,
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  return {
    mode: "managed",
    provider: getSmsServiceProvider(moduleConfig),
    module: "sms",
    sendConfigId,
    userId,
  };
}

/**
 * Build rate limiter context for any managed module
 */
export function buildManagedContext(
  module: ModuleType,
  moduleConfig: EmailModuleConfig | SmsModuleConfig,
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  if (module === "email") {
    return buildManagedEmailContext(moduleConfig as EmailModuleConfig, sendConfigId, userId);
  }
  return buildManagedSmsContext(moduleConfig as SmsModuleConfig, sendConfigId, userId);
}

/**
 * Email and SMS modules are always in managed mode now
 * (BYOK is handled via the Webhook module)
 */
export function isEmailManagedMode(_moduleConfig: EmailModuleConfig): boolean {
  return true;
}

/**
 * Email and SMS modules are always in managed mode now
 * (BYOK is handled via the Webhook module)
 */
export function isSmsManagedMode(_moduleConfig: SmsModuleConfig): boolean {
  return true;
}
