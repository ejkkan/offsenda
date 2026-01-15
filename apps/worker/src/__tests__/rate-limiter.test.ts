import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { RateLimiterService } from "../rate-limiter.js";
import Redis from "ioredis";

describe("RateLimiterService", () => {
  let rateLimiter: RateLimiterService;
  let redis: Redis;

  beforeAll(() => {
    rateLimiter = new RateLimiterService();
    redis = new Redis({ host: "localhost", port: 6379 });
  });

  afterAll(async () => {
    await rateLimiter.close();
    await redis.quit();
  });

  beforeEach(async () => {
    // Clean up all rate limit keys before each test
    const keys = await redis.keys("rate_limit:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  it("should allow requests under limit", async () => {
    const ip = "192.168.1.1";

    // Make 50 requests (well under the 100 limit)
    for (let i = 0; i < 50; i++) {
      const result = await rateLimiter.checkLimit(ip);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(100);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  it("should block requests over limit", async () => {
    const ip = "192.168.1.2";

    // Fill up the limit
    for (let i = 0; i < 100; i++) {
      const result = await rateLimiter.checkLimit(ip);
      expect(result.allowed).toBe(true);
    }

    // Next request should be blocked
    const blockedResult = await rateLimiter.checkLimit(ip);
    expect(blockedResult.allowed).toBe(false);
    expect(blockedResult.remaining).toBe(0);
  });

  it("should return correct remaining count", async () => {
    const ip = "192.168.1.3";

    const result1 = await rateLimiter.checkLimit(ip);
    expect(result1.remaining).toBe(99); // 100 - 1

    const result2 = await rateLimiter.checkLimit(ip);
    expect(result2.remaining).toBe(98); // 100 - 2

    const result3 = await rateLimiter.checkLimit(ip);
    expect(result3.remaining).toBe(97); // 100 - 3
  });

  it("should reset counter after manual cleanup", async () => {
    const ip = "192.168.1.4";

    // Fill up the limit
    for (let i = 0; i < 100; i++) {
      await rateLimiter.checkLimit(ip);
    }

    // Verify blocked
    const blocked = await rateLimiter.checkLimit(ip);
    expect(blocked.allowed).toBe(false);

    // Manually expire the key (simulating window expiration)
    await redis.del(`rate_limit:ip:${ip}`);

    // Should allow requests again
    const allowed = await rateLimiter.checkLimit(ip);
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(99);
  });

  it("should handle concurrent requests correctly", async () => {
    const ip = "192.168.1.5";

    // Make 150 concurrent requests
    const promises = Array.from({ length: 150 }, () =>
      rateLimiter.checkLimit(ip)
    );

    const results = await Promise.all(promises);
    const allowedCount = results.filter((r) => r.allowed).length;
    const blockedCount = results.filter((r) => !r.allowed).length;

    // Should allow ~100, block ~50 (may vary slightly due to timing)
    expect(allowedCount).toBeGreaterThanOrEqual(100);
    expect(allowedCount).toBeLessThanOrEqual(102); // Allow small timing variance
    expect(blockedCount).toBeGreaterThanOrEqual(48);
    expect(blockedCount).toBeLessThanOrEqual(50);
  });

  it("should isolate different IPs", async () => {
    const ip1 = "192.168.1.6";
    const ip2 = "192.168.1.7";

    // Max out IP1
    for (let i = 0; i < 100; i++) {
      await rateLimiter.checkLimit(ip1);
    }

    // IP1 should be blocked
    const ip1Blocked = await rateLimiter.checkLimit(ip1);
    expect(ip1Blocked.allowed).toBe(false);

    // IP2 should still be allowed
    const ip2Allowed = await rateLimiter.checkLimit(ip2);
    expect(ip2Allowed.allowed).toBe(true);
    expect(ip2Allowed.remaining).toBe(99);
  });

  it("should include correct resetAt timestamp", async () => {
    const ip = "192.168.1.8";
    const beforeRequest = Date.now();

    const result = await rateLimiter.checkLimit(ip);
    const afterRequest = Date.now();

    // resetAt should be approximately 1 minute (60000ms) in the future
    expect(result.resetAt).toBeGreaterThan(beforeRequest);
    expect(result.resetAt).toBeLessThanOrEqual(afterRequest + 60000);
  });

  it("should handle health check", async () => {
    const healthy = await rateLimiter.healthCheck();
    expect(healthy).toBe(true);
  });

  it("should gracefully handle Dragonfly being down", async () => {
    // Create a mock Redis that always throws errors
    const badRedis = {
      pipeline: () => {
        throw new Error("Connection refused");
      },
      ping: async () => {
        throw new Error("Connection refused");
      },
      quit: async () => {
        // No-op
      },
    } as any;

    // Pass bad Redis instance to constructor
    const badRateLimiter = new RateLimiterService(badRedis);

    // Should fail-open (allow request) when Dragonfly is down
    const result = await badRateLimiter.checkLimit("192.168.1.9");
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(100);
    expect(result.remaining).toBe(0);
  });
});
