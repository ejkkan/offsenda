/**
 * Rate Limiting Types
 *
 * Re-exports from shared types for backwards compatibility.
 * Import from "../types" instead for new code.
 */

// Re-export all rate limiting types from shared types
export type {
  RateLimitMode,
  ManagedProvider,
  RateLimiterContext,
  LimitingFactor,
  ComposedRateLimitResult,
  RateLimitConfig,
} from "../types/domain.js";

export { REDIS_KEY_PREFIXES } from "../types/domain.js";

// Re-export ModuleType for backwards compatibility (limited to rate limiting context)
export type ModuleType = "email" | "sms";
