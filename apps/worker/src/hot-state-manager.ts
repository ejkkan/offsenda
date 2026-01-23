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
import {
  dragonflyMemoryUsed,
  dragonflyMemoryRatio,
  dragonflyMemoryMax,
  dragonflyCircuitBreakerState,
  batchesRejectedMemoryPressure,
} from "./metrics.js";

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

/**
 * Parse memory value from Redis INFO output
 * Handles formats like "used_memory:12345" or "maxmemory:14000000000"
 */
function parseMemoryInfo(info: string, key: string): number {
  const regex = new RegExp(`^${key}:(\\d+)`, "m");
  const match = info.match(regex);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Map circuit breaker state to numeric value for metrics
 */
function circuitStateToNumber(state: CircuitState): number {
  switch (state) {
    case "closed":
      return 0;
    case "half-open":
      return 1;
    case "open":
      return 2;
    default:
      return 0;
  }
}

// =========================================================================
// Compact State Encoding
// Reduces memory from ~240 bytes to ~50 bytes per recipient (79% reduction)
// Format: status_code:field1:field2
//   sent:   s:timestamp:providerMessageId  (e.g., "s:1705924800000:msg_abc123")
//   failed: f:errorMessage                  (e.g., "f:rate limit exceeded")
//   others: status_code                     (e.g., "p" for pending)
// =========================================================================

const STATUS_CODES: Record<RecipientStatus, string> = {
  pending: "p",
  queued: "q",
  sent: "s",
  failed: "f",
  bounced: "b",
  complained: "c",
};

const CODE_TO_STATUS: Record<string, RecipientStatus> = {
  p: "pending",
  q: "queued",
  s: "sent",
  f: "failed",
  b: "bounced",
  c: "complained",
};

/**
 * Encode recipient state to compact string format
 * ~50 bytes vs ~240 bytes for full JSON (79% reduction)
 */
function encodeState(state: RecipientState): string {
  const code = STATUS_CODES[state.status];
  if (state.status === "sent") {
    return `${code}:${state.sentAt || ""}:${state.providerMessageId || ""}`;
  }
  if (state.status === "failed" || state.status === "bounced" || state.status === "complained") {
    return `${code}:${state.errorMessage || ""}`;
  }
  return code;
}

/**
 * Decode compact string format back to RecipientState
 * Supports both new compact format and legacy JSON for backwards compatibility
 */
function decodeState(encoded: string): RecipientState {
  // Try to detect JSON format for backwards compatibility
  if (encoded.startsWith("{")) {
    try {
      return JSON.parse(encoded) as RecipientState;
    } catch {
      // Fall through to compact format parsing
    }
  }

  const [code, ...rest] = encoded.split(":");
  const status = CODE_TO_STATUS[code];

  if (!status) {
    // Unknown format, return as pending
    log.system.warn({ encoded }, "Unknown state format, treating as pending");
    return { status: "pending" };
  }

  if (status === "sent") {
    const sentAt = rest[0] ? parseInt(rest[0], 10) : undefined;
    const providerMessageId = rest.slice(1).join(":") || undefined; // Handle : in message ID
    return { status, sentAt: sentAt || undefined, providerMessageId };
  }

  if (status === "failed" || status === "bounced" || status === "complained") {
    return { status, errorMessage: rest.join(":") || undefined };
  }

  return { status };
}

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
 * Returns: status code string or nil if not found
 * Handles both compact format (s:timestamp:msgid) and legacy JSON
 */
const CHECK_RECIPIENT_STATUS_SCRIPT = `
local recipientsKey = KEYS[1]
local recipientId = ARGV[1]

local stateEncoded = redis.call('HGET', recipientsKey, recipientId)
if stateEncoded then
  -- Check if it's compact format (starts with status code letter)
  local firstChar = string.sub(stateEncoded, 1, 1)
  if firstChar == 'p' or firstChar == 'q' or firstChar == 's' or firstChar == 'f' or firstChar == 'b' or firstChar == 'c' then
    -- Compact format: return status code letter
    return firstChar
  elseif firstChar == '{' then
    -- Legacy JSON format
    local state = cjson.decode(stateEncoded)
    return state.status
  end
end

return nil
`;

/**
 * Batch record results - atomically update counters and recipient states
 * KEYS: [countersKey, recipientsKey, pendingSyncKey]
 * ARGV: [ttl, sentCount, failedCount, recipientId1, state1, recipientId2, state2, ...]
 * Returns: [newSentCount, newFailedCount, total, isComplete]
 */
const BATCH_RECORD_RESULTS_SCRIPT = `
local countersKey = KEYS[1]
local recipientsKey = KEYS[2]
local pendingSyncKey = KEYS[3]
local ttl = tonumber(ARGV[1])
local sentIncrement = tonumber(ARGV[2])
local failedIncrement = tonumber(ARGV[3])

-- Increment counters
local sent = redis.call('HINCRBY', countersKey, 'sent', sentIncrement)
local failed = redis.call('HINCRBY', countersKey, 'failed', failedIncrement)
local total = tonumber(redis.call('HGET', countersKey, 'total') or '0')

-- Update recipient states (ARGV[4] onwards: recipientId, state pairs)
local recipientArgs = {}
local syncArgs = {}
for i = 4, #ARGV, 2 do
  local recipientId = ARGV[i]
  local state = ARGV[i + 1]
  table.insert(recipientArgs, recipientId)
  table.insert(recipientArgs, state)
  table.insert(syncArgs, recipientId)
end

if #recipientArgs > 0 then
  redis.call('HMSET', recipientsKey, unpack(recipientArgs))
  redis.call('SADD', pendingSyncKey, unpack(syncArgs))
end

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

export class HotStateManager {
  private redis: Redis;
  private config: Required<Omit<HotStateConfig, "redis">>;
  private isShuttingDown = false;
  private commandsInitialized = false;

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
      // Test mode: use injected Redis
      this.redis = hotStateConfig.redis;
      this.initializeCommands();
    } else {
      // Production mode: Use CRITICAL Dragonfly instance for batch state
      // This instance has noeviction policy to prevent duplicate sends
      const dragonflyUrl = config.DRAGONFLY_CRITICAL_URL || config.DRAGONFLY_URL;
      const [host, portStr] = dragonflyUrl.split(":");
      const port = parseInt(portStr || "6379");

      this.redis = new Redis({
        host: host || "localhost",
        port,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 50, 2000),
      });

      this.redis.on("error", (error) => {
        log.system.error({ error }, "Dragonfly connection error");
      });

      this.redis.on("connect", () => {
        log.system.debug({}, "Dragonfly connected");
      });

      this.initializeCommands();
    }
  }

  /**
   * Initialize Lua commands on the Redis client
   */
  private initializeCommands(): void {
    if (this.commandsInitialized) {
      return;
    }

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

    this.redis.defineCommand("batchRecordResults", {
      numberOfKeys: 3,
      lua: BATCH_RECORD_RESULTS_SCRIPT,
    });

    this.commandsInitialized = true;
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
  // Backpressure
  // =========================================================================

  /**
   * Check if we can accept a new batch based on Dragonfly memory pressure.
   * Prevents memory exhaustion by rejecting batches when memory is near capacity.
   *
   * @param estimatedRecipients - Expected number of recipients in the batch
   * @returns Object indicating whether batch is allowed and memory status
   */
  async canAcceptBatch(estimatedRecipients: number): Promise<{
    allowed: boolean;
    reason?: string;
    memoryRatio?: number;
  }> {
    try {
      const info = await this.redis.info("memory");
      const usedMemory = parseMemoryInfo(info, "used_memory");
      const maxMemory = parseMemoryInfo(info, "maxmemory");

      if (maxMemory === 0) {
        // No max memory configured - allow batch
        return { allowed: true };
      }

      const ratio = usedMemory / maxMemory;

      // Estimate memory needed for this batch (50 bytes per recipient with compressed encoding)
      const estimatedBytes = estimatedRecipients * 50;
      const projectedRatio = (usedMemory + estimatedBytes) / maxMemory;

      // Reject if projected memory usage would exceed 85%
      if (projectedRatio > 0.85) {
        batchesRejectedMemoryPressure.inc();
        log.batch.warn(
          { estimatedRecipients, usedMemory, maxMemory, ratio, projectedRatio },
          "Batch rejected due to memory pressure"
        );
        return {
          allowed: false,
          reason: "memory_pressure",
          memoryRatio: ratio,
        };
      }

      return { allowed: true, memoryRatio: ratio };
    } catch (error) {
      // If we can't check memory, allow the batch (fail-open for non-critical check)
      // The circuit breaker will protect against actual connection issues
      log.system.warn({ error }, "Failed to check memory pressure, allowing batch");
      return { allowed: true };
    }
  }

  // =========================================================================
  // Batch Operations
  // =========================================================================

  /**
   * Initialize batch counters (called when batch processing starts).
   * Checks backpressure before accepting the batch.
   *
   * @throws Error if memory pressure is too high (batch should be delayed)
   */
  async initializeBatch(batchId: string, totalRecipients: number): Promise<void> {
    this.checkCircuit();

    // Check backpressure before accepting batch
    const check = await this.canAcceptBatch(totalRecipients);
    if (!check.allowed) {
      throw new Error(`Cannot accept batch: ${check.reason} (memory at ${((check.memoryRatio ?? 0) * 100).toFixed(1)}%)`);
    }

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
      const stateEncoded = await this.redis.hget(recipientsKey, recipientId);
      this.recordSuccess();

      if (stateEncoded) {
        const state = decodeState(stateEncoded);
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
        encodeState(state),
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
        encodeState(state),
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

  // =========================================================================
  // Batch Operations (for chunk processing)
  // =========================================================================

  /**
   * Check if multiple recipients were already processed (batch idempotency)
   * Returns map of recipientId -> status for those already in final state
   * Uses HMGET for single round-trip
   *
   * FAIL-SAFE: Throws if circuit is open to prevent duplicate sends.
   */
  async checkRecipientsProcessedBatch(
    batchId: string,
    recipientIds: string[]
  ): Promise<Map<string, RecipientStatus>> {
    if (recipientIds.length === 0) {
      return new Map();
    }

    // CRITICAL: This check must fail-safe - throw if we can't verify
    this.checkCircuit();

    const recipientsKey = this.recipientsKey(batchId);
    const result = new Map<string, RecipientStatus>();

    try {
      const states = await this.redis.hmget(recipientsKey, ...recipientIds);
      this.recordSuccess();

      for (let i = 0; i < recipientIds.length; i++) {
        const stateEncoded = states[i];
        if (stateEncoded) {
          const state = decodeState(stateEncoded);
          // Only return if in a final state
          if (state.status === "sent" || state.status === "failed" ||
              state.status === "bounced" || state.status === "complained") {
            result.set(recipientIds[i], state.status);
          }
        }
      }

      return result;
    } catch (error) {
      this.recordFailure(error as Error);
      log.system.error({ error, batchId, count: recipientIds.length }, "HotStateManager failed to check recipients batch");
      throw new Error(`Cannot verify recipient status - refusing to process to prevent duplicates: ${(error as Error).message}`);
    }
  }

  /**
   * Record batch of results atomically (sent and failed mixed)
   * Uses single Lua script for atomic counter increment + state updates
   * Returns { counters, isComplete }
   */
  async recordResultsBatch(
    batchId: string,
    results: Array<{
      recipientId: string;
      success: boolean;
      providerMessageId?: string;
      errorMessage?: string;
    }>
  ): Promise<{ counters: BatchCounters; isComplete: boolean }> {
    if (results.length === 0) {
      const counters = await this.getCounters(batchId);
      return {
        counters: counters || { sent: 0, failed: 0, total: 0 },
        isComplete: false,
      };
    }

    this.checkCircuit();

    const countersKey = this.countersKey(batchId);
    const recipientsKey = this.recipientsKey(batchId);
    const pendingSyncKey = this.pendingSyncKey(batchId);
    const ttl = this.config.activeBatchTtlMs;

    // Count successes and failures
    let sentCount = 0;
    let failedCount = 0;

    // Build args: [ttl, sentCount, failedCount, recipientId1, state1, ...]
    const args: (string | number)[] = [ttl, 0, 0]; // Placeholders for counts

    for (const r of results) {
      if (r.success) {
        sentCount++;
        const state: RecipientState = {
          status: "sent",
          sentAt: Date.now(),
          providerMessageId: r.providerMessageId,
        };
        args.push(r.recipientId, encodeState(state));
      } else {
        failedCount++;
        const state: RecipientState = {
          status: "failed",
          errorMessage: r.errorMessage,
        };
        args.push(r.recipientId, encodeState(state));
      }
    }

    // Update counts in args
    args[1] = sentCount;
    args[2] = failedCount;

    try {
      const result = await (this.redis as any).batchRecordResults(
        countersKey,
        recipientsKey,
        pendingSyncKey,
        ...args
      ) as [number, number, number, number];

      this.recordSuccess();
      const [sent, failed, total, isComplete] = result;

      log.system.debug(
        { batchId, batchSize: results.length, sentCount, failedCount, total, isComplete },
        "HotStateManager batch results recorded"
      );

      return {
        counters: { sent, failed, total },
        isComplete: isComplete === 1,
      };
    } catch (error) {
      this.recordFailure(error as Error);
      log.system.error({ error, batchId, count: results.length }, "HotStateManager failed to record batch results");
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
        const stateEncoded = states[i];
        if (stateEncoded) {
          results.set(recipientIds[i], decodeState(stateEncoded));
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
    const batchIds: Set<string> = new Set();

    try {
      let cursor = "0";
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
   * Report Dragonfly memory metrics and circuit breaker state.
   * Call this periodically (e.g., every 30 seconds) to update Prometheus metrics.
   * @param instanceLabel - Label for the Dragonfly instance (e.g., "critical" or "primary")
   */
  async reportMetrics(instanceLabel: string = "critical"): Promise<void> {
    try {
      const info = await this.redis.info("memory");
      const usedMemory = parseMemoryInfo(info, "used_memory");
      const maxMemory = parseMemoryInfo(info, "maxmemory");

      dragonflyMemoryUsed.set({ instance: instanceLabel }, usedMemory);
      dragonflyMemoryMax.set({ instance: instanceLabel }, maxMemory);

      if (maxMemory > 0) {
        dragonflyMemoryRatio.set({ instance: instanceLabel }, usedMemory / maxMemory);
      }

      // Report circuit breaker state
      const circuitState = this.circuitBreakerState.state;
      dragonflyCircuitBreakerState.set({ component: "hot-state" }, circuitStateToNumber(circuitState));

      log.system.debug(
        { instance: instanceLabel, usedMemory, maxMemory, ratio: maxMemory > 0 ? usedMemory / maxMemory : 0 },
        "Dragonfly metrics reported"
      );
    } catch (error) {
      log.system.error({ error }, "Failed to report Dragonfly metrics");
    }
  }

  /**
   * Get raw Redis client for direct access (used by backpressure checks)
   */
  getRedis(): Redis {
    return this.redis;
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
