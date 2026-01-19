/**
 * Managed Flow Context Builder
 *
 * Builds rate limiter context for managed mode where users share
 * BatchSender's provider accounts (SES, Resend, Telnyx).
 *
 * Rate limit composition: MIN(system, managed_provider, tier, sendConfig)
 * All managed users SHARE the provider limit.
 */

import type { EmailModuleConfig, SmsModuleConfig } from "@batchsender/db";
import type { RateLimiterContext, ManagedProvider, ModuleType } from "./types.js";
import { config } from "../config.js";

/**
 * Determine the managed provider for email based on environment config
 */
function getManagedEmailProvider(): ManagedProvider {
  const provider = config.EMAIL_PROVIDER;
  if (provider === "ses" || provider === "resend" || provider === "mock") {
    return provider;
  }
  return "resend"; // Default fallback
}

/**
 * Determine the managed provider for SMS based on environment config
 */
function getManagedSmsProvider(): ManagedProvider {
  const provider = config.SMS_PROVIDER;
  if (provider === "telnyx" || provider === "mock") {
    return provider;
  }
  return "telnyx"; // Default fallback
}

/**
 * Build rate limiter context for managed email flow
 */
export function buildManagedEmailContext(
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  return {
    mode: "managed",
    provider: getManagedEmailProvider(),
    module: "email",
    sendConfigId,
    userId,
  };
}

/**
 * Build rate limiter context for managed SMS flow
 */
export function buildManagedSmsContext(
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  return {
    mode: "managed",
    provider: getManagedSmsProvider(),
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
  sendConfigId: string,
  userId: string
): RateLimiterContext {
  if (module === "email") {
    return buildManagedEmailContext(sendConfigId, userId);
  }
  return buildManagedSmsContext(sendConfigId, userId);
}

/**
 * Check if an email config is in managed mode
 */
export function isEmailManagedMode(moduleConfig: EmailModuleConfig): boolean {
  return moduleConfig.mode === "managed";
}

/**
 * Check if an SMS config is in managed mode
 * For backward compatibility: configs without mode field are considered BYOK
 * since they must specify provider credentials
 */
export function isSmsManagedMode(moduleConfig: SmsModuleConfig): boolean {
  const cfg = moduleConfig as SmsModuleConfig & { mode?: string };
  return cfg.mode === "managed";
}
