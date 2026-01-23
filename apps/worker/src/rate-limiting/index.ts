/**
 * Rate Limiting Module
 *
 * Clean entry point for the rate limiting system with managed vs BYOK flows.
 *
 * Usage:
 * ```typescript
 * import { acquireRateLimit } from './rate-limiting';
 *
 * const result = await acquireRateLimit(sendConfig, userId, timeout);
 * if (!result.allowed) {
 *   throw new Error(`Rate limit exceeded (${result.limitingFactor})`);
 * }
 * ```
 */

import type { EmailModuleConfig, SmsModuleConfig, SendConfigData } from "@batchsender/db";
import type { EmbeddedSendConfig } from "../nats/queue-service.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { LIMITS } from "../limits.js";
import { getRateLimitRegistry, closeRateLimitRegistry } from "./rate-limit-registry.js";
import { buildManagedContext, isEmailManagedMode, isSmsManagedMode } from "./managed-flow.js";
import { buildByokContext } from "./byok-flow.js";
import type { RateLimiterContext, ComposedRateLimitResult, ModuleType } from "./types.js";

// Re-export types for consumers
export type { RateLimiterContext, ComposedRateLimitResult, LimitingFactor } from "./types.js";
export { REDIS_KEY_PREFIXES } from "./types.js";
export { getRateLimitRegistry, closeRateLimitRegistry } from "./rate-limit-registry.js";

/**
 * Determine if a module config is in managed mode
 */
function isManagedMode(module: ModuleType, moduleConfig: SendConfigData): boolean {
  if (module === "email") {
    return isEmailManagedMode(moduleConfig as EmailModuleConfig);
  }
  if (module === "sms") {
    return isSmsManagedMode(moduleConfig as SmsModuleConfig);
  }
  // Other modules (webhook, push) don't have managed mode
  return false;
}

/**
 * Get the default rate limit for a send config based on mode and provider
 *
 * Uses provider-aware defaults from LIMITS instead of a hardcoded value.
 * This ensures safe defaults that won't overwhelm external providers.
 */
function getDefaultRateLimit(sendConfig: EmbeddedSendConfig): number {
  const module = sendConfig.module;
  const moduleConfig = sendConfig.config as EmailModuleConfig | SmsModuleConfig;

  // Webhook module has its own default
  if (module === "webhook") {
    return LIMITS.providerDefaults.webhook.perSecond;
  }

  // Managed mode uses shared infrastructure default
  if (isManagedMode(module as ModuleType, moduleConfig)) {
    return LIMITS.providerDefaults.managed.perSecond;
  }

  // BYOK mode: use provider-specific default
  const provider = (moduleConfig as EmailModuleConfig).provider;
  if (provider === "ses") {
    return LIMITS.providerDefaults.ses.perSecond;
  }
  if (provider === "resend") {
    return LIMITS.providerDefaults.resend.perSecond;
  }

  // Fallback for unknown providers (conservative)
  return LIMITS.providerDefaults.webhook.perSecond;
}

/**
 * Build the appropriate rate limiter context based on module config
 */
function buildContext(
  sendConfig: EmbeddedSendConfig,
  userId: string
): RateLimiterContext {
  const module = sendConfig.module as ModuleType;
  const moduleConfig = sendConfig.config;

  if (isManagedMode(module, moduleConfig)) {
    return buildManagedContext(module, sendConfig.id, userId);
  }

  return buildByokContext(module, moduleConfig as EmailModuleConfig | SmsModuleConfig, sendConfig.id, userId);
}

/**
 * Acquire rate limit for a send operation
 *
 * This is the main entry point for rate limiting. It:
 * 1. Determines if the operation is managed or BYOK
 * 2. Builds the appropriate context
 * 3. Acquires tokens from all applicable limiters
 *
 * For managed mode: MIN(system, provider, config)
 * For BYOK mode: MIN(system, config)
 *
 * @param sendConfig - The send configuration (contains mode, provider info)
 * @param userId - The user making the request
 * @param timeout - Maximum time to wait for rate limit (ms)
 * @returns Result indicating if allowed and any limiting factor
 */
export async function acquireRateLimit(
  sendConfig: EmbeddedSendConfig,
  userId: string,
  timeout: number = 1000
): Promise<ComposedRateLimitResult> {
  // Skip if rate limiting is disabled or in high-throughput test mode
  if (config.DISABLE_RATE_LIMIT || config.HIGH_THROUGHPUT_TEST_MODE) {
    return { allowed: true };
  }

  // Get the per-config rate limit (from sendConfig)
  // Use new requestsPerSecond field, fallback to deprecated perSecond, then provider default
  const configRateLimit = sendConfig.rateLimit?.requestsPerSecond
    ?? sendConfig.rateLimit?.perSecond
    ?? getDefaultRateLimit(sendConfig);

  // Build context based on managed vs BYOK
  const context = buildContext(sendConfig, userId);

  log.rateLimit.debug(
    { mode: context.mode, provider: context.provider, configId: sendConfig.id },
    "Acquiring rate limit"
  );

  // Acquire from registry
  const registry = getRateLimitRegistry();
  const result = await registry.acquire(context, configRateLimit, timeout);

  if (!result.allowed) {
    log.rateLimit.warn(
      {
        mode: context.mode,
        provider: context.provider,
        configId: sendConfig.id,
        limitingFactor: result.limitingFactor,
      },
      "Rate limit blocked"
    );
  }

  return result;
}

/**
 * Get rate limit status for monitoring
 */
export async function getRateLimitStatus(
  sendConfig: EmbeddedSendConfig,
  userId: string
): Promise<Record<string, { tokens: number; capacity: number; rate: number }>> {
  if (config.DISABLE_RATE_LIMIT) {
    return {};
  }

  const context = buildContext(sendConfig, userId);
  const configRateLimit = sendConfig.rateLimit?.requestsPerSecond
    ?? sendConfig.rateLimit?.perSecond
    ?? getDefaultRateLimit(sendConfig);
  const registry = getRateLimitRegistry();

  return registry.getStatus(context, configRateLimit);
}
