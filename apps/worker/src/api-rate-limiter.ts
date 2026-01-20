/**
 * API Rate Limiter
 *
 * Rate limits incoming HTTP API requests by IP address.
 * Uses sliding window log algorithm with Redis/Dragonfly.
 *
 * This is SEPARATE from message processing rate limiting (see rate-limiting/ directory).
 *
 * Rate limiting architecture:
 * - API requests: This file (per IP, requests/minute)
 * - Message processing: rate-limiting/index.ts (per provider/config, messages/second)
 */

import Redis from "ioredis";
import { config } from "./config.js";
import { log } from "./logger.js";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix timestamp (ms)
}

export class RateLimiterService {
  private redis: Redis;
  private requestsPerMinute: number;
  private windowMs: number = 60000; // 1 minute

  constructor(redis?: Redis) {
    if (redis) {
      // Use provided Redis instance (for testing)
      this.redis = redis;
    } else {
      // Create new Redis connection
      this.redis = new Redis({
        host: config.DRAGONFLY_URL.split(":")[0],
        port: parseInt(config.DRAGONFLY_URL.split(":")[1] || "6379"),
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        reconnectOnError: (err) => {
          return err.message.includes("READONLY");
        },
        lazyConnect: false,
        keepAlive: 30000,
        enableAutoPipelining: true,
      });

      this.redis.on("error", (error) => {
        log.rateLimit.error({ error }, "Dragonfly connection error");
      });

      this.redis.on("connect", () => {
        log.rateLimit.info({}, "Connected to Dragonfly");
      });
    }

    this.requestsPerMinute = config.RATE_LIMIT_PER_IP;
  }

  /**
   * Check if request should be allowed for given IP
   * Uses sliding window log algorithm with Redis sorted sets
   */
  async checkLimit(ip: string): Promise<RateLimitResult> {
    const key = `rate_limit:ip:${ip}`;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    try {
      const pipeline = this.redis.pipeline();

      // 1. Remove expired entries
      pipeline.zremrangebyscore(key, "-inf", windowStart);

      // 2. Count requests in current window
      pipeline.zcard(key);

      // 3. Add current request with unique identifier
      const requestId = `${now}-${Math.random().toString(36).slice(2, 11)}`;
      pipeline.zadd(key, now, requestId);

      // 4. Set expiry (2x window for safety)
      pipeline.expire(key, Math.ceil(this.windowMs / 1000) * 2);

      const results = await pipeline.exec();

      if (!results) {
        throw new Error("Pipeline returned null");
      }

      // Get count from zcard result (before adding current request)
      const count = results[1][1] as number;
      const allowed = count < this.requestsPerMinute;
      const remaining = Math.max(0, this.requestsPerMinute - count - 1);
      const resetAt = now + this.windowMs;

      if (!allowed) {
        log.rateLimit.warn({ ip, count, limit: this.requestsPerMinute }, "Rate limit exceeded");
      }

      return {
        allowed,
        limit: this.requestsPerMinute,
        remaining,
        resetAt,
      };
    } catch (error) {
      // Fail open - allow request if rate limiter is down
      log.rateLimit.error({ error, ip }, "Rate limit check failed, allowing request");
      return {
        allowed: true,
        limit: this.requestsPerMinute,
        remaining: 0,
        resetAt: now + this.windowMs,
      };
    }
  }

  /**
   * Health check for Dragonfly connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch (error) {
      log.rateLimit.error({ error }, "Dragonfly health check failed");
      return false;
    }
  }

  /**
   * Graceful shutdown
   */
  async close(): Promise<void> {
    log.rateLimit.info({}, "Closing Dragonfly connection");
    await this.redis.quit();
  }
}
