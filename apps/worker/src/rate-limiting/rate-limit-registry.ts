/**
 * Rate Limit Registry
 *
 * Manages all rate limiters and provides composable rate limit checks.
 * Implements different limiter compositions for managed vs BYOK flows.
 */

import Redis from "ioredis";
import { config } from "../config.js";
import { log } from "../logger.js";
import type {
  RateLimiterContext,
  ComposedRateLimitResult,
  LimitingFactor,
  RateLimitConfig,
  ManagedProvider,
} from "./types.js";
import { REDIS_KEY_PREFIXES } from "./types.js";

interface TokenBucketState {
  tokens: number;
  lastUpdate: number;
}

/**
 * Manages rate limiters with composable checks for managed and BYOK flows
 *
 * Uses a simple Redis connection - the Dragonfly Operator handles HA/failover
 * behind the service endpoint.
 */
export class RateLimitRegistry {
  private redis: Redis;
  private isConnected = false;

  constructor(redis?: Redis) {
    if (redis) {
      // Test mode: use injected Redis
      this.redis = redis;
      this.isConnected = true;
    } else {
      // Production mode: simple Redis connection
      // Dragonfly Operator handles HA behind the service
      const [host, portStr] = config.DRAGONFLY_URL.split(":");
      const port = parseInt(portStr || "6379");

      this.redis = new Redis({
        host: host || "localhost",
        port,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        lazyConnect: true,
      });

      this.redis.on("error", (error) => {
        log.rateLimit.error({ error }, "Dragonfly connection error");
      });

      this.redis.on("connect", () => {
        log.rateLimit.debug({}, "Dragonfly connected");
      });
    }
  }

  /**
   * Acquire rate limit tokens for a request using composable checks
   *
   * For managed flow: checks system -> provider -> config
   * For BYOK flow: checks system -> config (no shared provider limit)
   */
  async acquire(
    context: RateLimiterContext,
    configRateLimit: number,
    timeout: number = 5000
  ): Promise<ComposedRateLimitResult> {
    // Ensure connection
    if (!this.isConnected) {
      try {
        await this.redis.connect();
        this.isConnected = true;
      } catch {
        // Fail open if Redis unavailable
        log.rateLimit.warn({ context }, "Rate limit registry unavailable, allowing request");
        return { allowed: true };
      }
    }

    const startTime = Date.now();

    // Build the list of limiters to check based on mode
    const limiters = this.buildLimiterChain(context, configRateLimit);

    // Try to acquire from all limiters
    while (Date.now() - startTime < timeout) {
      const result = await this.tryAcquireAll(limiters);

      if (result.allowed) {
        return result;
      }

      // Calculate wait time based on the limiting factor
      const waitTime = Math.min(
        result.waitTimeMs || 5, // Reduced from 50ms for faster throughput
        timeout - (Date.now() - startTime)
      );

      if (waitTime <= 0) break;

      // Add jitter to prevent thundering herd
      const jitter = Math.random() * 10;
      await new Promise((resolve) => setTimeout(resolve, waitTime + jitter));
    }

    // Timeout - return last failure reason
    return {
      allowed: false,
      limitingFactor: "system",
      waitTimeMs: 0,
    };
  }

  /**
   * Build the chain of limiters based on context
   */
  private buildLimiterChain(
    context: RateLimiterContext,
    configRateLimit: number
  ): Array<{ key: string; config: RateLimitConfig; factor: LimitingFactor }> {
    const limiters: Array<{ key: string; config: RateLimitConfig; factor: LimitingFactor }> = [];

    // 1. System-wide limiter (always present)
    limiters.push({
      key: `${REDIS_KEY_PREFIXES.SYSTEM}:bucket`,
      config: { tokensPerSecond: config.SYSTEM_RATE_LIMIT },
      factor: "system",
    });

    // 2. Managed provider limiter (only for managed mode)
    if (context.mode === "managed") {
      const providerLimit = this.getManagedProviderLimit(context.provider as ManagedProvider);
      limiters.push({
        key: `${REDIS_KEY_PREFIXES.MANAGED}:${context.provider}:bucket`,
        config: { tokensPerSecond: providerLimit },
        factor: "provider",
      });
    }

    // 3. Per-config limiter (always present)
    limiters.push({
      key: `${REDIS_KEY_PREFIXES.CONFIG}:${context.sendConfigId}:bucket`,
      config: { tokensPerSecond: configRateLimit },
      factor: "config",
    });

    return limiters;
  }

  /**
   * Get the rate limit for a managed provider
   */
  private getManagedProviderLimit(provider: ManagedProvider): number {
    switch (provider) {
      case "ses":
        return config.MANAGED_SES_RATE_LIMIT;
      case "resend":
        return config.MANAGED_RESEND_RATE_LIMIT;
      case "telnyx":
        return config.MANAGED_TELNYX_RATE_LIMIT;
      case "mock":
        return config.MANAGED_MOCK_RATE_LIMIT;
      default:
        return 100; // Safe default
    }
  }

  /**
   * Try to acquire tokens from all limiters atomically
   * If any limiter fails, none are consumed
   */
  private async tryAcquireAll(
    limiters: Array<{ key: string; config: RateLimitConfig; factor: LimitingFactor }>
  ): Promise<ComposedRateLimitResult> {
    const now = Date.now();

    try {
      // Lua script for atomic multi-bucket acquisition
      // Checks all buckets first, only consumes if all have tokens
      const script = `
        local now = tonumber(ARGV[1])
        local num_buckets = tonumber(ARGV[2])

        -- First pass: check all buckets
        local states = {}
        for i = 1, num_buckets do
          local key = KEYS[i]
          local rate = tonumber(ARGV[2 + (i-1)*2 + 1])
          local capacity = tonumber(ARGV[2 + (i-1)*2 + 2])

          local bucket = redis.call('HMGET', key, 'tokens', 'last_update')
          local tokens = tonumber(bucket[1]) or capacity
          local last_update = tonumber(bucket[2]) or now

          -- Calculate tokens to add
          local elapsed = (now - last_update) / 1000
          local tokens_to_add = elapsed * rate
          tokens = math.min(capacity, tokens + tokens_to_add)

          states[i] = { key = key, tokens = tokens, rate = rate, capacity = capacity }

          -- If any bucket is empty, return failure with bucket index
          if tokens < 1 then
            return {0, i, tokens}
          end
        end

        -- Second pass: all buckets have tokens, consume from all
        for i = 1, num_buckets do
          local state = states[i]
          local new_tokens = state.tokens - 1
          redis.call('HMSET', state.key, 'tokens', new_tokens, 'last_update', now)
          redis.call('EXPIRE', state.key, 10)
        end

        return {1, 0, 0}
      `;

      // Build args: now, num_buckets, then (rate, capacity) pairs for each bucket
      const args: (string | number)[] = [now, limiters.length];
      for (const limiter of limiters) {
        args.push(limiter.config.tokensPerSecond);
        // Allow 2-second burst capacity for faster ramp-up, minimum 1000
        const burstCapacity = limiter.config.burstCapacity ||
          Math.max(limiter.config.tokensPerSecond * 2, 1000);
        args.push(burstCapacity);
      }

      const result = (await this.redis.eval(
        script,
        limiters.length,
        ...limiters.map((l) => l.key),
        ...args
      )) as [number, number, number];

      if (result[0] === 1) {
        return { allowed: true };
      }

      // Find which limiter failed
      const failedIndex = result[1] - 1;
      const currentTokens = result[2];
      const failedLimiter = limiters[failedIndex];

      // Calculate wait time based on refill rate
      const tokensNeeded = 1 - currentTokens;
      const waitTimeMs = (tokensNeeded / failedLimiter.config.tokensPerSecond) * 1000;

      return {
        allowed: false,
        limitingFactor: failedLimiter.factor,
        waitTimeMs: Math.max(10, waitTimeMs),
      };
    } catch (error) {
      // Fail open on Redis errors
      log.rateLimit.error({ error }, "Rate limit check failed, allowing request");
      return { allowed: true };
    }
  }

  /**
   * Get current status of all limiters for a context (for monitoring)
   */
  async getStatus(
    context: RateLimiterContext,
    configRateLimit: number
  ): Promise<Record<string, { tokens: number; capacity: number; rate: number }>> {
    const limiters = this.buildLimiterChain(context, configRateLimit);
    const status: Record<string, { tokens: number; capacity: number; rate: number }> = {};

    for (const limiter of limiters) {
      try {
        const bucket = await this.redis.hmget(limiter.key, "tokens", "last_update");
        const capacity = limiter.config.burstCapacity || limiter.config.tokensPerSecond;
        const tokens = parseFloat(bucket[0] || String(capacity));
        const lastUpdate = parseFloat(bucket[1] || String(Date.now()));

        // Calculate current tokens including refill
        const elapsed = (Date.now() - lastUpdate) / 1000;
        const tokensToAdd = elapsed * limiter.config.tokensPerSecond;
        const currentTokens = Math.min(capacity, tokens + tokensToAdd);

        status[limiter.factor] = {
          tokens: Math.floor(currentTokens),
          capacity,
          rate: limiter.config.tokensPerSecond,
        };
      } catch {
        status[limiter.factor] = {
          tokens: limiter.config.tokensPerSecond,
          capacity: limiter.config.tokensPerSecond,
          rate: limiter.config.tokensPerSecond,
        };
      }
    }

    return status;
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
    this.isConnected = false;
  }
}

// Singleton instance
let registryInstance: RateLimitRegistry | null = null;

/**
 * Get the singleton rate limit registry instance
 */
export function getRateLimitRegistry(): RateLimitRegistry {
  if (!registryInstance) {
    registryInstance = new RateLimitRegistry();
  }
  return registryInstance;
}

/**
 * Close the singleton registry (for cleanup)
 */
export async function closeRateLimitRegistry(): Promise<void> {
  if (registryInstance) {
    await registryInstance.close();
    registryInstance = null;
  }
}
