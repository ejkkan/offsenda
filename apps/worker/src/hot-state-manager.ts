/**
 * Dragonfly Hot State Manager
 *
 * Manages high-throughput state in Dragonfly for batch processing:
 * - Batch counters (sent, failed, total) for O(1) completion checks
 * - Recipient status caching to avoid PostgreSQL on hot path
 *
 * Data structures:
 * - batch:{id}:counters (hash) - { sent: N, failed: N, total: N }
 * - batch:{id}:recipients (hash) - { recipientId: JSON({ status, sentAt, providerMessageId }) }
 * - batch:{id}:pending_sync (set) - recipient IDs that need PostgreSQL sync
 *
 * TTL: 48 hours after batch completion
 */

import Redis from "ioredis";
import { config } from "./config.js";
import { log } from "./logger.js";
import {
  createInitialState,
  checkCircuit as checkCircuitDomain,
  recordSuccess as recordSuccessDomain,
  recordFailure as recordFailureDomain,
  getCircuitStatus,
  type CircuitBreakerState,
  type CircuitBreakerConfig,
} from "./domain/circuit-breaker/index.js";

export type RecipientStatus = "pending" | "queued" | "sent" | "failed" | "bounced" | "complained";

export interface RecipientState {
  status: RecipientStatus;
  sentAt?: number;
  providerMessageId?: string;
  errorMessage?: string;
}

export interface BatchCounters {
  sent: number;
  failed: number;
  total: number;
}

export interface HotStateConfig {
  /** TTL for batch data after completion (default: 48 hours) */
  completedBatchTtlMs?: number;
  /** TTL for active batch data (default: 7 days) */
  activeBatchTtlMs?: number;
  /** Redis instance (optional, for testing) */
  redis?: Redis;
  /** Circuit breaker failure threshold (default: 5) */
  circuitBreakerThreshold?: number;
  /** Circuit breaker reset timeout in ms (default: 30000) */
  circuitBreakerResetMs?: number;
  /** Circuit breaker sliding window size in ms (default: 60000) */
  circuitBreakerWindowMs?: number;
}

const DEFAULT_CONFIG: Required<Omit<HotStateConfig, "redis">> = {
  completedBatchTtlMs: 48 * 60 * 60 * 1000, // 48 hours
  activeBatchTtlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 30000,
  circuitBreakerWindowMs: 60000, // 1 minute sliding window
};

type CircuitState = "closed" | "open" | "half-open";

// Lua scripts for atomic operations

/**
 * Atomic increment of sent count and check completion
 * Returns: [newSentCount, newFailedCount, total, isComplete]
 */
const INCREMENT_SENT_SCRIPT = `
local countersKey = KEYS[1]
local recipientsKey = KEYS[2]
local pendingSyncKey = KEYS[3]
local recipientId = ARGV[1]
local stateJson = ARGV[2]
local ttl = tonumber(ARGV[3])

-- Increment sent count
local sent = redis.call('HINCRBY', countersKey, 'sent', 1)
local failed = tonumber(redis.call('HGET', countersKey, 'failed') or '0')
local total = tonumber(redis.call('HGET', countersKey, 'total') or '0')

-- Update recipient state
redis.call('HSET', recipientsKey, recipientId, stateJson)

-- Add to pending sync set
redis.call('SADD', pendingSyncKey, recipientId)

-- Refresh TTL
redis.call('PEXPIRE', countersKey, ttl)
redis.call('PEXPIRE', recipientsKey, ttl)
redis.call('PEXPIRE', pendingSyncKey, ttl)

-- Check if complete
local isComplete = 0
if total > 0 and (sent + failed) >= total then
  isComplete = 1
end

return {sent, failed, total, isComplete}
`;

/**
 * Atomic increment of failed count and check completion
 * Returns: [sentCount, newFailedCount, total, isComplete]
 */
const INCREMENT_FAILED_SCRIPT = `
local countersKey = KEYS[1]
local recipientsKey = KEYS[2]
local pendingSyncKey = KEYS[3]
local recipientId = ARGV[1]
local stateJson = ARGV[2]
local ttl = tonumber(ARGV[3])

-- Increment failed count
local failed = redis.call('HINCRBY', countersKey, 'failed', 1)
local sent = tonumber(redis.call('HGET', countersKey, 'sent') or '0')
local total = tonumber(redis.call('HGET', countersKey, 'total') or '0')

-- Update recipient state
redis.call('HSET', recipientsKey, recipientId, stateJson)

-- Add to pending sync set
redis.call('SADD', pendingSyncKey, recipientId)

-- Refresh TTL
redis.call('PEXPIRE', countersKey, ttl)
redis.call('PEXPIRE', recipientsKey, ttl)
redis.call('PEXPIRE', pendingSyncKey, ttl)

-- Check if complete
local isComplete = 0
if total > 0 and (sent + failed) >= total then
  isComplete = 1
end

return {sent, failed, total, isComplete}
`;

/**
 * Check if recipient was already processed (idempotency)
 * Returns: status string or nil if not found
 */
const CHECK_RECIPIENT_STATUS_SCRIPT = `
local recipientsKey = KEYS[1]
local recipientId = ARGV[1]

local stateJson = redis.call('HGET', recipientsKey, recipientId)
if stateJson then
  local state = cjson.decode(stateJson)
  return state.status
end

return nil
`;

export class HotStateManager {
  private redis: Redis;
  private config: Required<Omit<HotStateConfig, "redis">>;
  private isShuttingDown = false;

  // Circuit breaker state using domain layer
  private circuitBreakerState: CircuitBreakerState;
  private circuitBreakerConfig: CircuitBreakerConfig;

  constructor(hotStateConfig?: HotStateConfig) {
    this.config = { ...DEFAULT_CONFIG };
    this.circuitBreakerState = createInitialState();

    if (hotStateConfig?.completedBatchTtlMs) {
      this.config.completedBatchTtlMs = hotStateConfig.completedBatchTtlMs;
    }
    if (hotStateConfig?.activeBatchTtlMs) {
      this.config.activeBatchTtlMs = hotStateConfig.activeBatchTtlMs;
    }
    if (hotStateConfig?.circuitBreakerThreshold) {
      this.config.circuitBreakerThreshold = hotStateConfig.circuitBreakerThreshold;
    }
    if (hotStateConfig?.circuitBreakerResetMs) {
      this.config.circuitBreakerResetMs = hotStateConfig.circuitBreakerResetMs;
    }
    if (hotStateConfig?.circuitBreakerWindowMs) {
      this.config.circuitBreakerWindowMs = hotStateConfig.circuitBreakerWindowMs;
    }

    // Initialize circuit breaker config from domain layer
    this.circuitBreakerConfig = {
      threshold: this.config.circuitBreakerThreshold,
      resetMs: this.config.circuitBreakerResetMs,
      windowMs: this.config.circuitBreakerWindowMs,
    };

    if (hotStateConfig?.redis) {
      this.redis = hotStateConfig.redis;
    } else {
      const dragonflyUrl = config.DRAGONFLY_URL || "localhost:6379";
      const [host, portStr] = dragonflyUrl.split(":");

      this.redis = new Redis({
        host,
        port: parseInt(portStr || "6379"),
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
        keepAlive: 30000,
        enableAutoPipelining: true,
        retryStrategy: (times) => Math.min(times * 50, 2000),
      });

      this.redis.on("error", (error) => {
        log.system.error({ error }, "HotStateManager Redis connection error");
      });
    }

    // Define Lua scripts
    this.redis.defineCommand("incrementSent", {
      numberOfKeys: 3,
      lua: INCREMENT_SENT_SCRIPT,
    });

    this.redis.defineCommand("incrementFailed", {
      numberOfKeys: 3,
      lua: INCREMENT_FAILED_SCRIPT,
    });

    this.redis.defineCommand("checkRecipientStatus", {
      numberOfKeys: 1,
      lua: CHECK_RECIPIENT_STATUS_SCRIPT,
    });
  }

  // Key helpers
  private countersKey(batchId: string): string {
    return `batch:${batchId}:counters`;
  }

  private recipientsKey(batchId: string): string {
    return `batch:${batchId}:recipients`;
  }

  private pendingSyncKey(batchId: string): string {
    return `batch:${batchId}:pending_sync`;
  }

  // =========================================================================
  // Circuit Breaker (using domain layer)
  // =========================================================================

  /**
   * Check if circuit allows the operation
   * Throws if circuit is open (fail-safe for critical operations)
   */
  private checkCircuit(): void {
    const now = Date.now();
    const result = checkCircuitDomain(this.circuitBreakerState, this.circuitBreakerConfig, now);

    if (result.newState) {
      const oldState = this.circuitBreakerState.state;
      this.circuitBreakerState = result.newState;
      if (oldState === "open" && result.newState.state === "half-open") {
        log.system.info({}, "HotStateManager circuit breaker half-open, testing connection");
      }
    }

    if (!result.canProceed) {
      throw new Error("HotStateManager circuit breaker is open - Dragonfly unavailable");
    }
  }

  /**
   * Record a successful operation
   */
  private recordSuccess(): void {
    const oldState = this.circuitBreakerState.state;
    this.circuitBreakerState = recordSuccessDomain(this.circuitBreakerState);

    if (oldState === "half-open" && this.circuitBreakerState.state === "closed") {
      log.system.info({}, "HotStateManager circuit breaker closed, connection restored");
    }
  }

  /**
   * Record a failed operation (may trip circuit)
   */
  private recordFailure(error: Error): void {
    const now = Date.now();
    const oldState = this.circuitBreakerState.state;
    this.circuitBreakerState = recordFailureDomain(this.circuitBreakerState, this.circuitBreakerConfig, now);

    if (oldState === "half-open" && this.circuitBreakerState.state === "open") {
      log.system.error({ error }, "HotStateManager circuit breaker reopened after test failure");
    } else if (oldState === "closed" && this.circuitBreakerState.state === "open") {
      log.system.error(
        {
          failures: this.circuitBreakerState.failureTimestamps.length,
          threshold: this.circuitBreakerConfig.threshold,
          windowMs: this.circuitBreakerConfig.windowMs,
        },
        "HotStateManager circuit breaker opened"
      );
    }
  }

  /**
   * Get circuit breaker status for monitoring
   */
  getCircuitState(): { state: string; failures: number; lastFailure: number; windowMs: number; isAvailable: boolean } {
    const status = getCircuitStatus(this.circuitBreakerState, this.circuitBreakerConfig, Date.now());
    return {
      state: status.state,
      failures: status.failures,
      lastFailure: status.lastFailure,
      windowMs: status.windowMs,
      isAvailable: status.isAvailable,
    };
  }

  /**
   * Check if Dragonfly is available (circuit closed or half-open)
   */
  isAvailable(): boolean {
    const status = getCircuitStatus(this.circuitBreakerState, this.circuitBreakerConfig, Date.now());
    return status.isAvailable;
  }

  // =========================================================================
  // Batch Operations
  // =========================================================================

  /**
   * Initialize batch counters (called when batch processing starts)
   */
  async initializeBatch(batchId: string, totalRecipients: number): Promise<void> {
    this.checkCircuit();

    const countersKey = this.countersKey(batchId);
    const ttl = this.config.activeBatchTtlMs;

    try {
      await this.redis.pipeline()
        .hset(countersKey, {
          sent: "0",
          failed: "0",
          total: String(totalRecipients),
        })
        .pexpire(countersKey, ttl)
        .exec();

      this.recordSuccess();
      log.system.debug({ batchId, totalRecipients }, "HotStateManager batch initialized");
    } catch (error) {
      this.recordFailure(error as Error);
      log.system.error({ error, batchId }, "HotStateManager failed to initialize batch");
      throw error;
    }
  }

  /**
   * Check if recipient was already processed (for idempotency)
   * Returns the current status if processed, null otherwise
   *
   * FAIL-SAFE: Throws if circuit is open to prevent duplicate sends.
   * It's better to delay processing than to risk sending duplicates.
   */
  async checkRecipientProcessed(batchId: string, recipientId: string): Promise<RecipientStatus | null> {
    // CRITICAL: This check must fail-safe - throw if we can't verify
    // Allowing processing when we can't check could cause duplicate sends
    this.checkCircuit();

    const recipientsKey = this.recipientsKey(batchId);

    try {
      const stateJson = await this.redis.hget(recipientsKey, recipientId);
      this.recordSuccess();

      if (stateJson) {
        const state = JSON.parse(stateJson) as RecipientState;
        // If already in a final state, return it
        if (state.status === "sent" || state.status === "failed" || state.status === "bounced" || state.status === "complained") {
          return state.status;
        }
      }
      return null;
    } catch (error) {
      this.recordFailure(error as Error);
      log.system.error({ error, batchId, recipientId }, "HotStateManager failed to check recipient status");
      // FAIL-SAFE: Throw to prevent potential duplicate send
      throw new Error(`Cannot verify recipient status - refusing to process to prevent duplicates: ${(error as Error).message}`);
    }
  }

  /**
   * Record successful send and check completion (atomic)
   * Returns { counters, isComplete }
   */
  async recordSent(
    batchId: string,
    recipientId: string,
    providerMessageId?: string
  ): Promise<{ counters: BatchCounters; isComplete: boolean }> {
    this.checkCircuit();

    const countersKey = this.countersKey(batchId);
    const recipientsKey = this.recipientsKey(batchId);
    const pendingSyncKey = this.pendingSyncKey(batchId);
    const ttl = this.config.activeBatchTtlMs;

    const state: RecipientState = {
      status: "sent",
      sentAt: Date.now(),
      providerMessageId,
    };

    try {
      const result = await (this.redis as any).incrementSent(
        countersKey,
        recipientsKey,
        pendingSyncKey,
        recipientId,
        JSON.stringify(state),
        ttl
      ) as [number, number, number, number];

      this.recordSuccess();
      const [sent, failed, total, isComplete] = result;

      return {
        counters: { sent, failed, total },
        isComplete: isComplete === 1,
      };
    } catch (error) {
      this.recordFailure(error as Error);
      log.system.error({ error, batchId, recipientId }, "HotStateManager failed to record sent");
      throw error;
    }
  }

  /**
   * Record failed send and check completion (atomic)
   * Returns { counters, isComplete }
   */
  async recordFailed(
    batchId: string,
    recipientId: string,
    errorMessage?: string
  ): Promise<{ counters: BatchCounters; isComplete: boolean }> {
    this.checkCircuit();

    const countersKey = this.countersKey(batchId);
    const recipientsKey = this.recipientsKey(batchId);
    const pendingSyncKey = this.pendingSyncKey(batchId);
    const ttl = this.config.activeBatchTtlMs;

    const state: RecipientState = {
      status: "failed",
      errorMessage,
    };

    try {
      const result = await (this.redis as any).incrementFailed(
        countersKey,
        recipientsKey,
        pendingSyncKey,
        recipientId,
        JSON.stringify(state),
        ttl
      ) as [number, number, number, number];

      this.recordSuccess();
      const [sent, failed, total, isComplete] = result;

      return {
        counters: { sent, failed, total },
        isComplete: isComplete === 1,
      };
    } catch (error) {
      this.recordFailure(error as Error);
      log.system.error({ error, batchId, recipientId }, "HotStateManager failed to record failed");
      throw error;
    }
  }

  /**
   * Get batch counters (O(1) operation)
   */
  async getCounters(batchId: string): Promise<BatchCounters | null> {
    const countersKey = this.countersKey(batchId);

    try {
      const data = await this.redis.hgetall(countersKey);
      if (!data || !data.total) {
        return null;
      }

      return {
        sent: parseInt(data.sent || "0"),
        failed: parseInt(data.failed || "0"),
        total: parseInt(data.total || "0"),
      };
    } catch (error) {
      log.system.error({ error, batchId }, "HotStateManager failed to get counters");
      return null;
    }
  }

  /**
   * Check if batch is complete (O(1) operation)
   */
  async isBatchComplete(batchId: string): Promise<boolean> {
    const counters = await this.getCounters(batchId);
    if (!counters) {
      return false;
    }
    return counters.total > 0 && (counters.sent + counters.failed) >= counters.total;
  }

  /**
   * Get recipients pending sync to PostgreSQL
   */
  async getPendingSyncRecipients(batchId: string, limit: number = 1000): Promise<string[]> {
    const pendingSyncKey = this.pendingSyncKey(batchId);

    try {
      // Get up to limit recipients
      const members = await this.redis.srandmember(pendingSyncKey, limit);
      return members || [];
    } catch (error) {
      log.system.error({ error, batchId }, "HotStateManager failed to get pending sync recipients");
      return [];
    }
  }

  /**
   * Get recipient states for syncing to PostgreSQL
   */
  async getRecipientStates(batchId: string, recipientIds: string[]): Promise<Map<string, RecipientState>> {
    if (recipientIds.length === 0) {
      return new Map();
    }

    const recipientsKey = this.recipientsKey(batchId);
    const results = new Map<string, RecipientState>();

    try {
      const states = await this.redis.hmget(recipientsKey, ...recipientIds);

      for (let i = 0; i < recipientIds.length; i++) {
        const stateJson = states[i];
        if (stateJson) {
          results.set(recipientIds[i], JSON.parse(stateJson));
        }
      }

      return results;
    } catch (error) {
      log.system.error({ error, batchId }, "HotStateManager failed to get recipient states");
      return results;
    }
  }

  /**
   * Remove recipients from pending sync after successful PostgreSQL sync
   */
  async markSynced(batchId: string, recipientIds: string[]): Promise<void> {
    if (recipientIds.length === 0) {
      return;
    }

    const pendingSyncKey = this.pendingSyncKey(batchId);

    try {
      await this.redis.srem(pendingSyncKey, ...recipientIds);
    } catch (error) {
      log.system.error({ error, batchId }, "HotStateManager failed to mark recipients synced");
    }
  }

  /**
   * Set TTL for completed batch (shorter retention)
   */
  async markBatchCompleted(batchId: string): Promise<void> {
    const countersKey = this.countersKey(batchId);
    const recipientsKey = this.recipientsKey(batchId);
    const pendingSyncKey = this.pendingSyncKey(batchId);
    const ttl = this.config.completedBatchTtlMs;

    try {
      await this.redis.pipeline()
        .pexpire(countersKey, ttl)
        .pexpire(recipientsKey, ttl)
        .pexpire(pendingSyncKey, ttl)
        .exec();

      log.system.debug({ batchId, ttlHours: ttl / 3600000 }, "HotStateManager batch marked completed");
    } catch (error) {
      log.system.error({ error, batchId }, "HotStateManager failed to mark batch completed");
    }
  }

  /**
   * Get all active batch IDs (for sync service)
   */
  async getActiveBatchIds(): Promise<string[]> {
    try {
      let cursor = "0";
      const batchIds: Set<string> = new Set();

      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", "batch:*:pending_sync", "COUNT", 100);
        cursor = nextCursor;

        for (const key of keys) {
          // Extract batch ID from key: batch:{id}:pending_sync
          const match = key.match(/^batch:([^:]+):pending_sync$/);
          if (match) {
            batchIds.add(match[1]);
          }
        }
      } while (cursor !== "0");

      return Array.from(batchIds);
    } catch (error) {
      log.system.error({ error }, "HotStateManager failed to get active batch IDs");
      return [];
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch (error) {
      log.system.error({ error }, "HotStateManager health check failed");
      return false;
    }
  }

  /**
   * Get stats for monitoring
   */
  async getStats(): Promise<{
    activeBatches: number;
    connected: boolean;
  }> {
    const connected = await this.healthCheck();
    const activeBatches = connected ? (await this.getActiveBatchIds()).length : 0;

    return {
      activeBatches,
      connected,
    };
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    this.isShuttingDown = true;
    await this.redis.quit();
    log.system.info({}, "HotStateManager closed");
  }
}

// Singleton instance
let hotStateManager: HotStateManager | null = null;

/**
 * Get or create the singleton HotStateManager instance
 */
export function getHotStateManager(config?: HotStateConfig): HotStateManager {
  if (!hotStateManager) {
    hotStateManager = new HotStateManager(config);
  }
  return hotStateManager;
}
