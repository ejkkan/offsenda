/**
 * Provider-Specific Rate Limiter
 *
 * Implements distributed rate limiting for email providers using token bucket algorithm.
 * Respects provider-specific sending limits (e.g., AWS SES 14 messages/second).
 *
 * Uses Redis/Dragonfly for distributed coordination across multiple worker instances.
 */

import Redis from "ioredis";
import { config } from "./config.js";
import { log } from "./logger.js";

export interface ProviderRateLimiterConfig {
  provider: string;           // Provider name (ses, resend, mock)
  tokensPerSecond: number;    // Rate limit (e.g., 14 for AWS SES)
  burstCapacity?: number;     // Max tokens to accumulate (default: tokensPerSecond)
  redis?: Redis;              // Optional Redis instance (for testing)
}

export class ProviderRateLimiter {
  private redis: Redis;
  private provider: string;
  private tokensPerSecond: number;
  private burstCapacity: number;
  private keyPrefix: string;

  constructor(config: ProviderRateLimiterConfig) {
    this.provider = config.provider;
    this.tokensPerSecond = config.tokensPerSecond;
    this.burstCapacity = config.burstCapacity || config.tokensPerSecond;
    this.keyPrefix = `provider_rate_limit:${this.provider}`;

    if (config.redis) {
      this.redis = config.redis;
    } else {
      // Use global config for Dragonfly/Redis connection
      const dragonflyUrl = (config as any).DRAGONFLY_URL || process.env.DRAGONFLY_URL || "localhost:6379";
      this.redis = new Redis({
        host: dragonflyUrl.split(":")[0] || "localhost",
        port: parseInt(dragonflyUrl.split(":")[1] || "6379"),
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 50, 2000),
      });

      this.redis.on("error", (error) => {
        log.rateLimit.error({ error, provider: this.provider }, "Provider rate limiter error");
      });
    }
  }

  /**
   * Acquire a token to send an email
   * Uses token bucket algorithm with Redis for distributed rate limiting
   *
   * @param timeout - Max time to wait for a token (ms), default 5000
   * @returns true if token acquired, false if timeout
   */
  async acquire(timeout: number = 5000): Promise<boolean> {
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < timeout) {
      const result = await this.tryAcquireWithWait();
      if (result.acquired) {
        return true;
      }

      // Calculate optimal wait time based on token refill rate
      // Instead of busy-waiting every 50ms, wait for tokens to actually refill
      const tokensNeeded = 1 - result.currentTokens;
      const refillTimeMs = (tokensNeeded / this.tokensPerSecond) * 1000;

      // Add small jitter to prevent thundering herd
      const jitter = Math.random() * 10;
      const waitTime = Math.min(
        Math.max(refillTimeMs, 10) + jitter,
        timeout - (Date.now() - startTime)
      );

      if (waitTime <= 0) break;

      await new Promise(resolve => setTimeout(resolve, waitTime));
      attempt++;
    }

    log.rateLimit.warn({
      provider: this.provider,
      timeout,
      limit: this.tokensPerSecond,
      attempts: attempt
    }, "Rate limit timeout - no tokens available");

    return false;
  }

  /**
   * Acquire multiple tokens at once (for bulk operations)
   *
   * @param count - Number of tokens to acquire
   * @param timeout - Max time to wait (ms)
   * @returns Number of tokens actually acquired (may be less than requested)
   */
  async acquireBulk(count: number, timeout: number = 5000): Promise<number> {
    const startTime = Date.now();
    let acquired = 0;

    while (acquired < count && Date.now() - startTime < timeout) {
      const result = await this.tryAcquireBulk(count - acquired);
      acquired += result.acquired;

      if (acquired >= count) {
        return acquired;
      }

      // Wait for more tokens
      const tokensNeeded = 1;
      const refillTimeMs = (tokensNeeded / this.tokensPerSecond) * 1000;
      const jitter = Math.random() * 10;
      const waitTime = Math.min(
        Math.max(refillTimeMs, 10) + jitter,
        timeout - (Date.now() - startTime)
      );

      if (waitTime <= 0) break;

      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    return acquired;
  }

  /**
   * Try to acquire a token (non-blocking)
   * Returns true if successful, false if rate limited
   */
  private async tryAcquire(): Promise<boolean> {
    const result = await this.tryAcquireWithWait();
    return result.acquired;
  }

  /**
   * Try to acquire a token and return current token count for wait calculation
   */
  private async tryAcquireWithWait(): Promise<{ acquired: boolean; currentTokens: number }> {
    const now = Date.now();
    const key = `${this.keyPrefix}:bucket`;

    try {
      // Lua script for atomic token bucket operation
      // Returns: [acquired (0/1), current_tokens]
      const script = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local rate = tonumber(ARGV[2])
        local capacity = tonumber(ARGV[3])

        -- Get current bucket state
        local bucket = redis.call('HMGET', key, 'tokens', 'last_update')
        local tokens = tonumber(bucket[1]) or capacity
        local last_update = tonumber(bucket[2]) or now

        -- Calculate tokens to add based on time elapsed
        local elapsed = (now - last_update) / 1000  -- Convert to seconds
        local tokens_to_add = elapsed * rate
        tokens = math.min(capacity, tokens + tokens_to_add)

        -- Try to consume one token
        if tokens >= 1 then
          tokens = tokens - 1
          redis.call('HMSET', key, 'tokens', tokens, 'last_update', now)
          redis.call('EXPIRE', key, 10)  -- Auto-expire after 10 seconds of inactivity
          return {1, tokens}  -- Success
        else
          -- Not enough tokens, update state anyway
          redis.call('HMSET', key, 'tokens', tokens, 'last_update', now)
          redis.call('EXPIRE', key, 10)
          return {0, tokens}  -- Rate limited
        end
      `;

      const result = await this.redis.eval(
        script,
        1,
        key,
        now.toString(),
        this.tokensPerSecond.toString(),
        this.burstCapacity.toString()
      ) as [number, number];

      return {
        acquired: result[0] === 1,
        currentTokens: result[1],
      };

    } catch (error) {
      // Fail open - allow request if rate limiter is down
      log.rateLimit.error({
        error,
        provider: this.provider
      }, "Provider rate limit check failed, allowing request");
      return { acquired: true, currentTokens: this.burstCapacity };
    }
  }

  /**
   * Try to acquire multiple tokens at once (for bulk operations)
   */
  private async tryAcquireBulk(maxCount: number): Promise<{ acquired: number; remaining: number }> {
    const now = Date.now();
    const key = `${this.keyPrefix}:bucket`;

    try {
      // Lua script for bulk token acquisition
      // Returns: [acquired_count, remaining_tokens]
      const script = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local rate = tonumber(ARGV[2])
        local capacity = tonumber(ARGV[3])
        local max_count = tonumber(ARGV[4])

        -- Get current bucket state
        local bucket = redis.call('HMGET', key, 'tokens', 'last_update')
        local tokens = tonumber(bucket[1]) or capacity
        local last_update = tonumber(bucket[2]) or now

        -- Calculate tokens to add based on time elapsed
        local elapsed = (now - last_update) / 1000  -- Convert to seconds
        local tokens_to_add = elapsed * rate
        tokens = math.min(capacity, tokens + tokens_to_add)

        -- Consume as many tokens as possible (up to max_count)
        local to_consume = math.min(math.floor(tokens), max_count)
        tokens = tokens - to_consume

        redis.call('HMSET', key, 'tokens', tokens, 'last_update', now)
        redis.call('EXPIRE', key, 10)

        return {to_consume, tokens}
      `;

      const result = await this.redis.eval(
        script,
        1,
        key,
        now.toString(),
        this.tokensPerSecond.toString(),
        this.burstCapacity.toString(),
        maxCount.toString()
      ) as [number, number];

      return {
        acquired: result[0],
        remaining: result[1],
      };

    } catch (error) {
      // Fail open - allow all requests if rate limiter is down
      log.rateLimit.error({
        error,
        provider: this.provider
      }, "Provider bulk rate limit check failed, allowing all requests");
      return { acquired: maxCount, remaining: this.burstCapacity };
    }
  }

  /**
   * Get current rate limit status (for monitoring)
   */
  async getStatus(): Promise<{
    tokens: number;
    capacity: number;
    rate: number;
  }> {
    const key = `${this.keyPrefix}:bucket`;
    const now = Date.now();

    try {
      const bucket = await this.redis.hmget(key, 'tokens', 'last_update');
      const tokens = parseFloat(bucket[0] || String(this.burstCapacity));
      const lastUpdate = parseFloat(bucket[1] || String(now));

      // Calculate current tokens (including refill)
      const elapsed = (now - lastUpdate) / 1000;
      const tokensToAdd = elapsed * this.tokensPerSecond;
      const currentTokens = Math.min(this.burstCapacity, tokens + tokensToAdd);

      return {
        tokens: Math.floor(currentTokens),
        capacity: this.burstCapacity,
        rate: this.tokensPerSecond,
      };
    } catch (error) {
      log.rateLimit.error({ error, provider: this.provider }, "Failed to get rate limit status");
      return {
        tokens: this.burstCapacity,
        capacity: this.burstCapacity,
        rate: this.tokensPerSecond,
      };
    }
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
