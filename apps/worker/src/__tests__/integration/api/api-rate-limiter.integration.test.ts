import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";

/**
 * Integration tests for rate limiting via HTTP API
 *
 * Prerequisites:
 * - Worker must be running (docker-compose up or pnpm dev)
 * - Dragonfly must be running and accessible
 *
 * Run with: pnpm test:integration
 */

const WORKER_URL = process.env.WORKER_URL || "http://localhost:6001";
const TEST_API_KEY = process.env.TEST_API_KEY || "test-key";

describe("Rate Limiting Integration Tests", () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis({ host: "localhost", port: 6379 });
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("should enforce rate limits across multiple requests", async () => {
    const testIp = "203.0.113.1"; // TEST-NET-1 (documentation IP)

    // Clear any existing rate limit data for this IP
    await redis.del(`rate_limit:ip:${testIp}`);

    // Make 100 requests (at the limit)
    const results = [];
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`${WORKER_URL}/health`, {
        headers: {
          "X-Forwarded-For": testIp,
        },
      });
      results.push({
        status: response.status,
        limit: response.headers.get("X-RateLimit-Limit"),
        remaining: response.headers.get("X-RateLimit-Remaining"),
      });
    }

    // All 100 should succeed
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBe(100);

    // Last request should show remaining = 0
    const lastResult = results[results.length - 1];
    expect(lastResult.remaining).toBe("0");

    // 101st request should be rate limited
    const blockedResponse = await fetch(`${WORKER_URL}/health`, {
      headers: {
        "X-Forwarded-For": testIp,
      },
    });

    expect(blockedResponse.status).toBe(429);
    const blockedBody = await blockedResponse.json();
    expect(blockedBody.error).toBe("Too many requests");
    expect(blockedBody.retryAfter).toBeGreaterThan(0);

    // Cleanup
    await redis.del(`rate_limit:ip:${testIp}`);
  });

  it("should include rate limit headers in responses", async () => {
    const testIp = "203.0.113.2";
    await redis.del(`rate_limit:ip:${testIp}`);

    const response = await fetch(`${WORKER_URL}/health`, {
      headers: {
        "X-Forwarded-For": testIp,
      },
    });

    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("99");
    expect(response.headers.has("X-RateLimit-Reset")).toBe(true);

    await redis.del(`rate_limit:ip:${testIp}`);
  });

  it("should isolate rate limits per IP", async () => {
    const ip1 = "203.0.113.3";
    const ip2 = "203.0.113.4";

    await redis.del(`rate_limit:ip:${ip1}`);
    await redis.del(`rate_limit:ip:${ip2}`);

    // Max out IP1
    for (let i = 0; i < 100; i++) {
      await fetch(`${WORKER_URL}/health`, {
        headers: { "X-Forwarded-For": ip1 },
      });
    }

    // IP1 should be blocked
    const ip1Blocked = await fetch(`${WORKER_URL}/health`, {
      headers: { "X-Forwarded-For": ip1 },
    });
    expect(ip1Blocked.status).toBe(429);

    // IP2 should still work
    const ip2Allowed = await fetch(`${WORKER_URL}/health`, {
      headers: { "X-Forwarded-For": ip2 },
    });
    expect(ip2Allowed.status).toBe(200);

    await redis.del(`rate_limit:ip:${ip1}`);
    await redis.del(`rate_limit:ip:${ip2}`);
  });

  it("should handle concurrent requests from same IP", async () => {
    const testIp = "203.0.113.5";
    await redis.del(`rate_limit:ip:${testIp}`);

    // Send 150 requests concurrently
    const promises = Array.from({ length: 150 }, () =>
      fetch(`${WORKER_URL}/health`, {
        headers: { "X-Forwarded-For": testIp },
      })
    );

    const responses = await Promise.all(promises);
    const statusCodes = responses.map((r) => r.status);

    const successCount = statusCodes.filter((s) => s === 200).length;
    const blockedCount = statusCodes.filter((s) => s === 429).length;

    // Should allow ~100, block ~50
    expect(successCount).toBeGreaterThanOrEqual(100);
    expect(successCount).toBeLessThanOrEqual(102);
    expect(blockedCount).toBeGreaterThanOrEqual(48);

    await redis.del(`rate_limit:ip:${testIp}`);
  });

  it("should return correct retry-after header", async () => {
    const testIp = "203.0.113.6";
    await redis.del(`rate_limit:ip:${testIp}`);

    // Max out the limit
    for (let i = 0; i < 100; i++) {
      await fetch(`${WORKER_URL}/health`, {
        headers: { "X-Forwarded-For": testIp },
      });
    }

    // Get blocked
    const blocked = await fetch(`${WORKER_URL}/health`, {
      headers: { "X-Forwarded-For": testIp },
    });

    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(60); // Max 1 minute window

    await redis.del(`rate_limit:ip:${testIp}`);
  });
});
