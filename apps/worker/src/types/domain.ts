/**
 * Domain Pattern Types - Shared across worker modules
 *
 * Single source of truth for domain pattern types used in:
 * - Circuit breaker
 * - Idempotency checking
 * - Rate limiting
 */

// =============================================================================
// CIRCUIT BREAKER
// =============================================================================

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure?: number;
  nextRetry?: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  failures: number;
  isOpen: boolean;
  nextRetryIn?: number;
}

// =============================================================================
// IDEMPOTENCY
// =============================================================================

export type ProcessedStatus = "sent" | "failed" | "bounced" | "complained";

export interface IdempotencyCheckResult {
  alreadyProcessed: boolean;
  status?: ProcessedStatus;
}

export interface IdempotencyChecker {
  check(batchId: string, recipientId: string): Promise<IdempotencyCheckResult>;
  markProcessed(batchId: string, recipientId: string, status: ProcessedStatus): Promise<void>;
}

// =============================================================================
// RATE LIMITING
// =============================================================================

/**
 * Mode of operation for rate limiting
 * - managed: Uses BatchSender's shared provider accounts
 * - byok: Uses user's own provider accounts (Bring Your Own Key)
 */
export type RateLimitMode = "managed" | "byok";

/**
 * Supported providers for managed mode (platform services)
 */
export type ManagedProvider = "ses" | "resend" | "telnyx";

/**
 * Context for rate limit decisions
 */
export interface RateLimiterContext {
  mode: RateLimitMode;
  provider: string;
  module: "email" | "sms";
  sendConfigId: string;
  userId: string;
}

/**
 * Factor that caused rate limiting
 */
export type LimitingFactor = "system" | "provider" | "tier" | "config";

/**
 * Result of a rate limit check
 */
export interface ComposedRateLimitResult {
  allowed: boolean;
  limitingFactor?: LimitingFactor;
  waitTimeMs?: number;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  tokensPerSecond: number;
  burstCapacity?: number;
}

/**
 * Redis key prefixes for rate limiters
 */
export const REDIS_KEY_PREFIXES = {
  SYSTEM: "rate_limit:system",
  MANAGED: "rate_limit:managed",
  CONFIG: "rate_limit:config",
} as const;
