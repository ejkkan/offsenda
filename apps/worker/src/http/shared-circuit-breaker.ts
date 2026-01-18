import Redis from "ioredis";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Circuit breaker states
 */
export type CircuitState = "closed" | "open" | "half-open";

/**
 * Circuit breaker configuration
 */
export interface SharedCircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;

  /** Number of successes in half-open to close circuit */
  successThreshold: number;

  /** Time to wait before attempting half-open (ms) */
  resetTimeoutMs: number;

  /** Window for counting failures (ms) */
  failureWindowMs: number;

  /** Key prefix for Redis */
  keyPrefix: string;
}

const DEFAULT_CONFIG: SharedCircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  resetTimeoutMs: 30000,
  failureWindowMs: 60000,
  keyPrefix: "circuit",
};

/**
 * Shared Circuit Breaker using Dragonfly/Redis
 *
 * All pods share the same circuit state, ensuring consistent behavior
 * across the cluster.
 */
export class SharedCircuitBreaker {
  private redis: Redis;
  private config: SharedCircuitBreakerConfig;

  constructor(redis?: Redis, circuitConfig?: Partial<SharedCircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...circuitConfig };

    if (redis) {
      this.redis = redis;
    } else {
      const redisUrl = config.DRAGONFLY_URL || "localhost:6379";
      const [host, portStr] = redisUrl.split(":");

      this.redis = new Redis({
        host,
        port: parseInt(portStr || "6379"),
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
        keepAlive: 30000,
        enableAutoPipelining: true,
      });

      this.redis.on("error", (error) => {
        log.system.error({ error }, "Circuit breaker Redis connection error");
      });
    }
  }

  private getKey(host: string): string {
    return `${this.config.keyPrefix}:${host}`;
  }

  /**
   * Get current circuit state for a host
   */
  async getState(host: string): Promise<CircuitState> {
    const key = this.getKey(host);
    const now = Date.now();

    try {
      const data = await this.redis.hgetall(key);

      if (!data || !data.state) {
        return "closed";
      }

      // Check if open circuit should transition to half-open
      if (data.state === "open") {
        const lastFailureTime = parseInt(data.lastFailureTime || "0");
        if (now - lastFailureTime >= this.config.resetTimeoutMs) {
          // Transition to half-open
          await this.redis.hset(key, "state", "half-open", "successes", "0");
          return "half-open";
        }
      }

      return data.state as CircuitState;
    } catch (error) {
      // Fail open - allow requests if Redis is down
      log.system.error({ error, host }, "Circuit breaker state check failed, allowing request");
      return "closed";
    }
  }

  /**
   * Check if circuit is open (request should be blocked)
   */
  async isOpen(host: string): Promise<boolean> {
    const state = await this.getState(host);
    return state === "open";
  }

  /**
   * Record a successful request
   */
  async recordSuccess(host: string): Promise<void> {
    const key = this.getKey(host);

    try {
      const state = await this.getState(host);

      if (state === "half-open") {
        // Increment successes and check threshold
        const successes = await this.redis.hincrby(key, "successes", 1);

        if (successes >= this.config.successThreshold) {
          // Close the circuit
          await this.redis.del(key);
          log.system.info({ host }, "Circuit breaker closed (shared)");
        }
      } else if (state === "closed") {
        // Reset failure count on success
        await this.redis.hdel(key, "failures", "failureTimestamps");
      }
    } catch (error) {
      log.system.error({ error, host }, "Circuit breaker recordSuccess failed");
    }
  }

  /**
   * Record a failed request
   */
  async recordFailure(host: string): Promise<void> {
    const key = this.getKey(host);
    const now = Date.now();
    const windowStart = now - this.config.failureWindowMs;

    try {
      const pipeline = this.redis.pipeline();

      // Set last failure time
      pipeline.hset(key, "lastFailureTime", now.toString());

      // Add failure timestamp to sorted set for windowed counting
      const failureKey = `${key}:failures`;
      pipeline.zadd(failureKey, now, `${now}-${Math.random().toString(36).slice(2, 8)}`);

      // Remove old failures outside window
      pipeline.zremrangebyscore(failureKey, "-inf", windowStart);

      // Count failures in window
      pipeline.zcard(failureKey);

      // Set expiry
      pipeline.expire(key, Math.ceil(this.config.failureWindowMs / 1000) * 2);
      pipeline.expire(failureKey, Math.ceil(this.config.failureWindowMs / 1000) * 2);

      const results = await pipeline.exec();

      if (!results) {
        return;
      }

      // Get failure count (from zcard result)
      const failureCount = results[3][1] as number;

      // Check if we should open the circuit
      const currentState = await this.redis.hget(key, "state");

      if (currentState !== "open" && failureCount >= this.config.failureThreshold) {
        await this.redis.hset(key, "state", "open");
        log.system.warn({ host, failures: failureCount }, "Circuit breaker opened (shared)");
      } else if (!currentState) {
        // Initialize state if not set
        await this.redis.hset(key, "state", "closed");
      }
    } catch (error) {
      log.system.error({ error, host }, "Circuit breaker recordFailure failed");
    }
  }

  /**
   * Reset circuit breaker for a specific host
   */
  async reset(host: string): Promise<void> {
    const key = this.getKey(host);
    const failureKey = `${key}:failures`;

    try {
      await this.redis.del(key, failureKey);
      log.system.info({ host }, "Circuit breaker reset (shared)");
    } catch (error) {
      log.system.error({ error, host }, "Circuit breaker reset failed");
    }
  }

  /**
   * Reset all circuit breakers
   */
  async resetAll(): Promise<void> {
    try {
      const pattern = `${this.config.keyPrefix}:*`;
      let cursor = "0";

      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;

        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } while (cursor !== "0");

      log.system.info({}, "All circuit breakers reset (shared)");
    } catch (error) {
      log.system.error({ error }, "Circuit breaker resetAll failed");
    }
  }

  /**
   * Get status of all circuit breakers (for monitoring)
   */
  async getStatus(): Promise<Map<string, { state: CircuitState; failures: number }>> {
    const status = new Map<string, { state: CircuitState; failures: number }>();

    try {
      const pattern = `${this.config.keyPrefix}:*`;
      let cursor = "0";

      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = nextCursor;

        for (const key of keys) {
          // Skip failure sorted set keys
          if (key.endsWith(":failures")) continue;

          const host = key.replace(`${this.config.keyPrefix}:`, "");
          const data = await this.redis.hgetall(key);
          const failureKey = `${key}:failures`;
          const failures = await this.redis.zcard(failureKey);

          status.set(host, {
            state: (data.state as CircuitState) || "closed",
            failures,
          });
        }
      } while (cursor !== "0");
    } catch (error) {
      log.system.error({ error }, "Circuit breaker getStatus failed");
    }

    return status;
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// Singleton instance
let sharedCircuitBreaker: SharedCircuitBreaker | null = null;

export function getSharedCircuitBreaker(): SharedCircuitBreaker {
  if (!sharedCircuitBreaker) {
    sharedCircuitBreaker = new SharedCircuitBreaker();
  }
  return sharedCircuitBreaker;
}
