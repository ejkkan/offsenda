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

    while (Date.now() - startTime < timeout) {
      if (await this.tryAcquire()) {
        return true;
      }

      // Wait a bit before retrying (adaptive backoff)
      const elapsed = Date.now() - startTime;
      const waitTime = Math.min(50, timeout - elapsed);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    log.rateLimit.warn({
      provider: this.provider,
      timeout,
      limit: this.tokensPerSecond
    }, "Rate limit timeout - no tokens available");

    return false;
  }

  /**
   * Try to acquire a token (non-blocking)
   * Returns true if successful, false if rate limited
   */
  private async tryAcquire(): Promise<boolean> {
    const now = Date.now();
    const key = `${this.keyPrefix}:bucket`;

    try {
      // Lua script for atomic token bucket operation
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
          return 1  -- Success
        else
          -- Not enough tokens, update state anyway
          redis.call('HMSET', key, 'tokens', tokens, 'last_update', now)
          redis.call('EXPIRE', key, 10)
          return 0  -- Rate limited
        end
      `;

      const result = await this.redis.eval(
        script,
        1,
        key,
        now.toString(),
        this.tokensPerSecond.toString(),
        this.burstCapacity.toString()
      ) as number;

      return result === 1;

    } catch (error) {
      // Fail open - allow request if rate limiter is down
      log.rateLimit.error({
        error,
        provider: this.provider
      }, "Provider rate limit check failed, allowing request");
      return true;
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
