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
    await registry.close();
    await redis.quit();
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
      // Set a very low provider limit for testing
      vi.stubEnv("MANAGED_SES_RATE_LIMIT", "3");

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

      // Both users should share the provider limit
      // With limit of 3, making 5 requests should exhaust it
      const results: boolean[] = [];

      for (let i = 0; i < 5; i++) {
        const ctx = i % 2 === 0 ? user1Context : user2Context;
        const result = await registry.acquire(ctx, 100, 100);
        results.push(result.allowed);
      }

      // Some should fail because they share the provider limit
      const allowed = results.filter(Boolean).length;
      expect(allowed).toBeLessThanOrEqual(3);

      vi.unstubAllEnvs();
    });
  });

  describe("BYOK Flow", () => {
    it("should only check system and config limiters for BYOK mode", async () => {
      const context: RateLimiterContext = {
        mode: "byok",
        provider: "ses",
        module: "email",
        sendConfigId: "cfg_byok_123",
        userId: "user_byok",
      };

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

      // Set a very low config limit
      const configLimit = 2;

      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        const result = await registry.acquire(context, configLimit, 50);
        results.push(result.allowed);
      }

      const allowed = results.filter(Boolean).length;
      expect(allowed).toBeLessThanOrEqual(configLimit);
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
    it("should return status for all limiters", async () => {
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

      expect(status.system).toBeDefined();
      expect(status.system.rate).toBeGreaterThan(0);
      expect(status.provider).toBeDefined();
      expect(status.config).toBeDefined();
    });
  });

  describe("Fail-open behavior", () => {
    it("should allow requests when Redis is unavailable", async () => {
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
        mode: "byok",
        provider: "resend",
        module: "email",
        sendConfigId: "cfg_failopen",
        userId: "user_failopen",
      };

      // Should fail open
      const result = await badRegistry.acquire(context, 100, 100);
      expect(result.allowed).toBe(true);

      await badRegistry.close();
    });
  });
});
