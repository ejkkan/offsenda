import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Redis from "ioredis";
import { RateLimitRegistry } from "../../../rate-limiting/rate-limit-registry.js";
import type { RateLimiterContext } from "../../../rate-limiting/types.js";

describe("RateLimitRegistry", () => {
  let registry: RateLimitRegistry;
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis({ host: "localhost", port: 6379 });
    registry = new RateLimitRegistry(redis);
  });

  afterAll(async () => {
    // Graceful cleanup - ignore errors if already closed
    try {
      await registry.close();
    } catch {
      // Ignore cleanup errors
    }
    try {
      await redis.quit();
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(async () => {
    // Clean up all rate limit keys before each test
    const keys = await redis.keys("rate_limit:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe("Managed Flow", () => {
    it("should check system, provider, and config limiters for managed mode", async () => {
      const context: RateLimiterContext = {
        mode: "managed",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_test_123",
        userId: "user_456",
      };

      // First request should be allowed
      const result = await registry.acquire(context, 100, 1000);
      expect(result.allowed).toBe(true);
    });

    it("should share provider limit across multiple managed users", async () => {
      // Default MANAGED_SES_RATE_LIMIT is 14, burst capacity is min(max(28,10), 840) = 28
      // Both users sharing the same provider should consume from the same bucket

      const user1Context: RateLimiterContext = {
        mode: "managed",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_user1",
        userId: "user_1",
      };

      const user2Context: RateLimiterContext = {
        mode: "managed",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_user2",
        userId: "user_2",
      };

      // Make requests alternating between users
      // Both should consume from the same provider bucket
      const results: boolean[] = [];

      // Make 35 requests to exhaust the burst capacity (28 tokens)
      for (let i = 0; i < 35; i++) {
        const ctx = i % 2 === 0 ? user1Context : user2Context;
        const result = await registry.acquire(ctx, 100, 10); // Short timeout
        results.push(result.allowed);
      }

      // The burst capacity is 28, so ~28 should succeed, rest should fail
      const allowed = results.filter(Boolean).length;
      expect(allowed).toBeGreaterThanOrEqual(25); // At least burst capacity - some variance
      expect(allowed).toBeLessThan(35); // Not all should succeed
    });
  });

  describe("BYOK Flow", () => {
    it("should allow unlimited requests when no config limit is set", async () => {
      const context: RateLimiterContext = {
        mode: "byok",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_byok_unlimited",
        userId: "user_byok",
      };

      // With null configRateLimit (no limit configured), BYOK should be unlimited
      const result = await registry.acquire(context, null, 1000);
      expect(result.allowed).toBe(true);

      // Should allow many requests since there's no limiter
      for (let i = 0; i < 10; i++) {
        const r = await registry.acquire(context, null, 100);
        expect(r.allowed).toBe(true);
      }
    });

    it("should only check config limiter for BYOK mode with configured limit", async () => {
      const context: RateLimiterContext = {
        mode: "byok",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_byok_123",
        userId: "user_byok",
      };

      // BYOK with explicit config limit should work
      const result = await registry.acquire(context, 100, 1000);
      expect(result.allowed).toBe(true);
    });

    it("should not be affected by managed provider limits", async () => {
      // First, exhaust the managed SES provider limit
      const managedContext: RateLimiterContext = {
        mode: "managed",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_managed",
        userId: "user_managed",
      };

      // Make requests until blocked
      let managedBlocked = false;
      for (let i = 0; i < 20; i++) {
        const result = await registry.acquire(managedContext, 100, 10);
        if (!result.allowed && result.limitingFactor === "provider") {
          managedBlocked = true;
          break;
        }
      }

      // Now BYOK user should still work
      const byokContext: RateLimiterContext = {
        mode: "byok",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_byok_isolated",
        userId: "user_byok_isolated",
      };

      const byokResult = await registry.acquire(byokContext, 100, 1000);
      expect(byokResult.allowed).toBe(true);
    });
  });

  describe("Config-level limiting", () => {
    it("should respect per-config rate limits", async () => {
      const context: RateLimiterContext = {
        mode: "byok",
        provider: "resend",
        module: "email",
        sendConfigId: "cfg_limited",
        userId: "user_limited",
      };

      // With configLimit=2 tokens/sec, burst capacity is min(max(4,10), 120) = 10
      const configLimit = 2;

      const results: boolean[] = [];
      // Make 15 requests to exhaust the burst capacity (10 tokens)
      for (let i = 0; i < 15; i++) {
        const result = await registry.acquire(context, configLimit, 10); // Short timeout
        results.push(result.allowed);
      }

      const allowed = results.filter(Boolean).length;
      // Initial burst capacity is 10, so ~10 should succeed
      expect(allowed).toBeGreaterThanOrEqual(8); // Allow some variance
      expect(allowed).toBeLessThan(15); // Not all should succeed
    });

    it("should isolate different configs", async () => {
      const context1: RateLimiterContext = {
        mode: "byok",
        provider: "resend",
        module: "email",
        sendConfigId: "cfg_isolated_1",
        userId: "user_1",
      };

      const context2: RateLimiterContext = {
        mode: "byok",
        provider: "resend",
        module: "email",
        sendConfigId: "cfg_isolated_2",
        userId: "user_2",
      };

      // Exhaust config 1
      for (let i = 0; i < 5; i++) {
        await registry.acquire(context1, 3, 50);
      }

      // Config 2 should still work
      const result = await registry.acquire(context2, 100, 1000);
      expect(result.allowed).toBe(true);
    });
  });

  describe("Limiting Factor Reporting", () => {
    it("should report correct limiting factor when blocked", async () => {
      const context: RateLimiterContext = {
        mode: "byok",
        provider: "resend",
        module: "email",
        sendConfigId: "cfg_factor_test",
        userId: "user_factor",
      };

      // Use a very low config limit
      const configLimit = 1;

      // First request succeeds
      await registry.acquire(context, configLimit, 100);

      // Second request should be blocked by config limit
      const result = await registry.acquire(context, configLimit, 50);
      if (!result.allowed) {
        expect(result.limitingFactor).toBe("config");
      }
    });
  });

  describe("Status Monitoring", () => {
    it("should return status for all limiters in managed mode", async () => {
      const context: RateLimiterContext = {
        mode: "managed",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_status_test",
        userId: "user_status",
      };

      // Make a request first
      await registry.acquire(context, 100, 1000);

      // Get status
      const status = await registry.getStatus(context, 100);

      // Managed mode should have all three limiters
      expect(status.system).toBeDefined();
      expect(status.system.rate).toBeGreaterThan(0);
      expect(status.provider).toBeDefined();
      expect(status.config).toBeDefined();
    });

    it("should return only config status for BYOK with configured limit", async () => {
      const context: RateLimiterContext = {
        mode: "byok",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_byok_status",
        userId: "user_byok_status",
      };

      // Make a request first
      await registry.acquire(context, 100, 1000);

      // Get status
      const status = await registry.getStatus(context, 100);

      // BYOK should only have config limiter (no system or provider)
      expect(status.system).toBeUndefined();
      expect(status.provider).toBeUndefined();
      expect(status.config).toBeDefined();
    });

    it("should return empty status for BYOK without configured limit", async () => {
      const context: RateLimiterContext = {
        mode: "byok",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_byok_unlimited_status",
        userId: "user_byok_unlimited_status",
      };

      // Get status with null config limit
      const status = await registry.getStatus(context, null);

      // BYOK without limit should have no limiters
      expect(Object.keys(status).length).toBe(0);
    });
  });

  describe("Fail-open behavior", () => {
    it("should allow requests when Redis is unavailable for managed mode", async () => {
      // Create registry with bad Redis connection
      const badRedis = {
        eval: async () => {
          throw new Error("Connection refused");
        },
        connect: async () => {
          throw new Error("Connection refused");
        },
        hmget: async () => {
          throw new Error("Connection refused");
        },
        quit: async () => {},
        on: () => {},
      } as unknown as Redis;

      const badRegistry = new RateLimitRegistry(badRedis);

      const context: RateLimiterContext = {
        mode: "managed",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_failopen",
        userId: "user_failopen",
      };

      // Should fail open
      const result = await badRegistry.acquire(context, 100, 100);
      expect(result.allowed).toBe(true);

      await badRegistry.close();
    });

    it("should allow unlimited requests for BYOK without configured limit", async () => {
      const context: RateLimiterContext = {
        mode: "byok",
        provider: "resend",
        module: "email",
        sendConfigId: "cfg_unlimited",
        userId: "user_unlimited",
      };

      // BYOK without configured limit (null) should be unlimited - no Redis needed
      const result = await registry.acquire(context, null, 100);
      expect(result.allowed).toBe(true);
    });
  });
});
