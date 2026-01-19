/**
 * Rate Limiting Types
 *
 * Defines the core types for the managed vs BYOK rate limiting flows.
 */

/**
 * Mode of operation for rate limiting
 * - managed: Uses BatchSender's shared provider accounts
 * - byok: Uses user's own provider accounts (Bring Your Own Key)
 */
export type RateLimitMode = "managed" | "byok";

/**
 * Supported providers for managed mode
 */
export type ManagedProvider = "ses" | "resend" | "telnyx" | "mock";

/**
 * Module types that support rate limiting
 */
export type ModuleType = "email" | "sms";

/**
 * Context for rate limit decisions
 * Built by managed-flow or byok-flow builders
 */
export interface RateLimiterContext {
  /** Operating mode: managed uses shared limits, byok uses per-config limits */
  mode: RateLimitMode;
  /** Provider identifier (ses, resend, telnyx, mock) */
  provider: string;
  /** Module type (email, sms) */
  module: ModuleType;
  /** Send config ID - unique per user configuration */
  sendConfigId: string;
  /** User ID who owns this send config */
  userId: string;
}

/**
 * Factor that caused rate limiting
 * Used to help users understand why their request was limited
 */
export type LimitingFactor = "system" | "provider" | "tier" | "config";

/**
 * Result of a rate limit check/acquisition
 */
export interface ComposedRateLimitResult {
  /** Whether the request is allowed to proceed */
  allowed: boolean;
  /** Which limiter blocked the request (if not allowed) */
  limitingFactor?: LimitingFactor;
  /** Estimated time to wait before retrying (ms) */
  waitTimeMs?: number;
}

/**
 * Rate limit configuration for different limiters
 */
export interface RateLimitConfig {
  /** Tokens/requests per second */
  tokensPerSecond: number;
  /** Maximum burst capacity (defaults to tokensPerSecond) */
  burstCapacity?: number;
}

/**
 * Redis key prefixes for different limiter types
 */
export const REDIS_KEY_PREFIXES = {
  /** System-wide rate limit (singleton) */
  SYSTEM: "rate_limit:system",
  /** Managed provider limits (shared by all managed users of that provider) */
  MANAGED: "rate_limit:managed",
  /** Per-config limits (unique to each sendConfig) */
  CONFIG: "rate_limit:config",
} as const;
