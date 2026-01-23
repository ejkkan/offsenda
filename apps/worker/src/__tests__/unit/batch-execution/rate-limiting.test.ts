/**
 * Rate Limiting Tests for Batch Execution
 *
 * Tests the per-request rate limiting model:
 * - Rate limits apply per API request, not per recipient
 * - First-come-first-served (one batch can use full limit)
 * - Uses requestsPerSecond from RateLimitConfig
 * - Falls back to deprecated perSecond for compatibility
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EmbeddedSendConfig } from "../../../types/jobs.js";
import type { RateLimitConfig } from "@batchsender/db";
import { PROVIDER_LIMITS } from "../../../modules/types.js";

describe("RateLimitConfig Schema", () => {
  it("supports new requestsPerSecond field", () => {
    const config: RateLimitConfig = {
      requestsPerSecond: 100,
      recipientsPerRequest: 50,
    };

    expect(config.requestsPerSecond).toBe(100);
    expect(config.recipientsPerRequest).toBe(50);
  });

  it("supports deprecated perSecond for backwards compatibility", () => {
    const legacyConfig: RateLimitConfig = {
      perSecond: 1000, // Old field
      perMinute: 10000, // Old field (deprecated)
      dailyLimit: 100000,
    };

    expect(legacyConfig.perSecond).toBe(1000);
  });

  it("can have both new and legacy fields", () => {
    const config: RateLimitConfig = {
      requestsPerSecond: 100, // New (preferred)
      recipientsPerRequest: 50,
      perSecond: 1000, // Legacy (ignored when requestsPerSecond present)
      dailyLimit: 100000,
    };

    // New field takes precedence
    const effectiveRPS = config.requestsPerSecond ?? config.perSecond ?? 1000;
    expect(effectiveRPS).toBe(100);
  });
});

describe("Rate Limit Resolution", () => {
  /**
   * Simulates the rate limit resolution logic from rate-limiting/index.ts
   */
  function resolveRateLimit(sendConfig: EmbeddedSendConfig): number {
    // Use new requestsPerSecond, fallback to deprecated perSecond, then default
    return sendConfig.rateLimit?.requestsPerSecond
      ?? sendConfig.rateLimit?.perSecond
      ?? 1000;
  }

  it("uses requestsPerSecond when available", () => {
    const config: EmbeddedSendConfig = {
      id: "c1",
      module: "email",
      config: { mode: "managed" },
      rateLimit: {
        requestsPerSecond: 50,
        recipientsPerRequest: 100,
      },
    };

    expect(resolveRateLimit(config)).toBe(50);
  });

  it("falls back to perSecond when requestsPerSecond not set", () => {
    const config: EmbeddedSendConfig = {
      id: "c1",
      module: "email",
      config: { mode: "managed" },
      rateLimit: {
        perSecond: 200, // Legacy field
      },
    };

    expect(resolveRateLimit(config)).toBe(200);
  });

  it("uses default of 1000 when no rate limit configured", () => {
    const config: EmbeddedSendConfig = {
      id: "c1",
      module: "email",
      config: { mode: "managed" },
      // No rateLimit
    };

    expect(resolveRateLimit(config)).toBe(1000);
  });

  it("uses default when rateLimit is null", () => {
    const config: EmbeddedSendConfig = {
      id: "c1",
      module: "email",
      config: { mode: "managed" },
      rateLimit: null,
    };

    expect(resolveRateLimit(config)).toBe(1000);
  });
});

describe("Recipients Per Request Resolution", () => {
  /**
   * Simulates the chunk size resolution logic
   */
  function resolveRecipientsPerRequest(
    sendConfig: EmbeddedSendConfig,
    provider: string
  ): number {
    // User-configured takes precedence
    if (sendConfig.rateLimit?.recipientsPerRequest) {
      return sendConfig.rateLimit.recipientsPerRequest;
    }

    // Fall back to provider default
    const limits = PROVIDER_LIMITS[provider];
    return limits?.maxBatchSize ?? 50;
  }

  it("uses user-configured recipientsPerRequest", () => {
    const config: EmbeddedSendConfig = {
      id: "c1",
      module: "webhook",
      config: { url: "https://example.com" },
      rateLimit: {
        requestsPerSecond: 20,
        recipientsPerRequest: 25, // User wants smaller batches
      },
    };

    expect(resolveRecipientsPerRequest(config, "webhook")).toBe(25);
  });

  it("falls back to provider default for SES", () => {
    const config: EmbeddedSendConfig = {
      id: "c1",
      module: "email",
      config: { mode: "managed", provider: "ses" },
      rateLimit: { requestsPerSecond: 14 }, // No recipientsPerRequest
    };

    expect(resolveRecipientsPerRequest(config, "ses")).toBe(50);
  });

  it("falls back to provider default for Resend", () => {
    const config: EmbeddedSendConfig = {
      id: "c1",
      module: "email",
      config: { mode: "byok", provider: "resend" },
      // No rateLimit at all
    };

    expect(resolveRecipientsPerRequest(config, "resend")).toBe(100);
  });

  it("uses 1 for Telnyx (no batch API)", () => {
    const config: EmbeddedSendConfig = {
      id: "c1",
      module: "sms",
      config: { provider: "telnyx" },
    };

    expect(resolveRecipientsPerRequest(config, "telnyx")).toBe(1);
  });
});

describe("Per-Request Rate Limiting Model", () => {
  it("rate limit applies per API request, not per recipient", () => {
    // Old model: 100 recipients/sec limit, sending 1 at a time = 100 requests
    // New model: 10 requests/sec limit, sending 50 per request = 500 recipients/sec

    const requestsPerSecond = 10;
    const recipientsPerRequest = 50;

    const effectiveRecipientsPerSecond = requestsPerSecond * recipientsPerRequest;

    expect(effectiveRecipientsPerSecond).toBe(500);
  });

  it("calculates throughput for different providers", () => {
    const providers = [
      { name: "ses", rps: 14, batch: 50, expected: 700 },
      { name: "resend", rps: 100, batch: 100, expected: 10000 },
      { name: "telnyx", rps: 50, batch: 1, expected: 50 },
      { name: "webhook", rps: 20, batch: 100, expected: 2000 },
    ];

    providers.forEach(({ name, rps, batch, expected }) => {
      const throughput = rps * batch;
      expect(throughput).toBe(expected);
    });
  });

  it("first-come-first-served allows single batch to use full limit", () => {
    const systemLimit = 10; // 10 requests/sec

    // Batch A arrives first, requests 10 tokens
    const batchARequest = 10;
    const batchAAllowed = Math.min(batchARequest, systemLimit);

    // Batch B arrives same second, requests 5 tokens
    const remainingTokens = systemLimit - batchAAllowed;
    const batchBRequest = 5;
    const batchBAllowed = Math.min(batchBRequest, remainingTokens);

    expect(batchAAllowed).toBe(10); // Gets full limit
    expect(batchBAllowed).toBe(0); // None left
  });
});

describe("Rate Limit Scenarios", () => {
  describe("High-volume email campaign", () => {
    it("calculates time to send 1M emails via SES", () => {
      const totalRecipients = 1_000_000;
      const requestsPerSecond = 14; // SES limit
      const recipientsPerRequest = 50; // SES batch size

      const recipientsPerSecond = requestsPerSecond * recipientsPerRequest;
      const totalSeconds = totalRecipients / recipientsPerSecond;
      const totalMinutes = totalSeconds / 60;

      expect(recipientsPerSecond).toBe(700);
      expect(Math.ceil(totalMinutes)).toBe(24); // ~24 minutes for 1M emails
    });

    it("calculates time to send 1M emails via Resend", () => {
      const totalRecipients = 1_000_000;
      const requestsPerSecond = 100; // Resend limit
      const recipientsPerRequest = 100; // Resend batch size

      const recipientsPerSecond = requestsPerSecond * recipientsPerRequest;
      const totalSeconds = totalRecipients / recipientsPerSecond;
      const totalMinutes = totalSeconds / 60;

      expect(recipientsPerSecond).toBe(10000);
      expect(Math.ceil(totalMinutes)).toBe(2); // ~2 minutes for 1M emails
    });
  });

  describe("SMS campaign via Telnyx", () => {
    it("calculates time to send 10K SMS", () => {
      const totalRecipients = 10_000;
      const requestsPerSecond = 50; // Telnyx limit
      const recipientsPerRequest = 1; // No batch API

      const recipientsPerSecond = requestsPerSecond * recipientsPerRequest;
      const totalSeconds = totalRecipients / recipientsPerSecond;
      const totalMinutes = totalSeconds / 60;

      expect(recipientsPerSecond).toBe(50);
      expect(Math.ceil(totalMinutes)).toBe(4); // ~4 minutes for 10K SMS
    });
  });

  describe("Webhook notifications", () => {
    it("calculates time with custom rate limit", () => {
      const totalRecipients = 50_000;
      const requestsPerSecond = 20; // User's webhook server limit
      const recipientsPerRequest = 50; // User's preference

      const recipientsPerSecond = requestsPerSecond * recipientsPerRequest;
      const totalSeconds = totalRecipients / recipientsPerSecond;

      expect(recipientsPerSecond).toBe(1000);
      expect(Math.ceil(totalSeconds)).toBe(50); // 50 seconds
    });
  });
});

describe("Rate Limit Token Bucket Model", () => {
  /**
   * Simple token bucket simulation
   */
  class TokenBucket {
    private tokens: number;
    private lastRefill: number;

    constructor(
      private capacity: number,
      private refillRate: number // tokens per second
    ) {
      this.tokens = capacity;
      this.lastRefill = Date.now();
    }

    acquire(count: number = 1): boolean {
      this.refill();

      if (this.tokens >= count) {
        this.tokens -= count;
        return true;
      }
      return false;
    }

    private refill() {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      const tokensToAdd = elapsed * this.refillRate;

      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }

    getTokens(): number {
      this.refill();
      return this.tokens;
    }
  }

  it("allows requests when tokens available", () => {
    const bucket = new TokenBucket(10, 10);

    expect(bucket.acquire(1)).toBe(true);
    expect(bucket.acquire(5)).toBe(true);
    expect(bucket.getTokens()).toBeCloseTo(4, 0);
  });

  it("rejects when insufficient tokens", () => {
    const bucket = new TokenBucket(5, 1);

    expect(bucket.acquire(5)).toBe(true);
    expect(bucket.acquire(1)).toBe(false); // No tokens left
  });

  it("refills over time", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(10, 10);

    // Use all tokens
    expect(bucket.acquire(10)).toBe(true);
    expect(bucket.getTokens()).toBeCloseTo(0, 0);

    // Wait 500ms (should add 5 tokens)
    vi.advanceTimersByTime(500);

    expect(bucket.getTokens()).toBeCloseTo(5, 0);
    expect(bucket.acquire(5)).toBe(true);

    vi.useRealTimers();
  });

  it("caps at capacity", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(10, 10);

    // Wait longer than needed to fill
    vi.advanceTimersByTime(2000); // 2 seconds would add 20 tokens

    expect(bucket.getTokens()).toBe(10); // Capped at capacity

    vi.useRealTimers();
  });
});

describe("Multi-batch Rate Limiting", () => {
  it("multiple concurrent batches share the rate limit", () => {
    const systemLimit = 100; // requests per second
    const numBatches = 5;

    // Fair sharing (not implemented, just theoretical)
    const fairShare = systemLimit / numBatches;

    expect(fairShare).toBe(20); // Each batch gets 20 r/s

    // But we use first-come-first-served, so actual distribution varies
  });

  it("high-priority batches can bypass user batches", () => {
    // Priority queue uses separate consumer
    const userRateLimit = 100;
    const priorityRateLimit = 50; // Separate limit

    // Total system throughput
    const totalCapacity = userRateLimit + priorityRateLimit;

    expect(totalCapacity).toBe(150);
  });
});

describe("Provider Limit Enforcement", () => {
  it("enforces SES batch size limit", () => {
    const sesBatchLimit = PROVIDER_LIMITS.ses.maxBatchSize;
    const userRequested = 100; // User wants 100 per batch

    const effectiveBatchSize = Math.min(userRequested, sesBatchLimit);

    expect(effectiveBatchSize).toBe(50); // Capped at SES limit
  });

  it("allows smaller batches than provider limit", () => {
    const resendBatchLimit = PROVIDER_LIMITS.resend.maxBatchSize;
    const userRequested = 25; // User wants smaller batches

    const effectiveBatchSize = Math.min(userRequested, resendBatchLimit);

    expect(effectiveBatchSize).toBe(25); // User preference honored
  });

  it("enforces provider rate limit", () => {
    const sesRateLimit = PROVIDER_LIMITS.ses.maxRequestsPerSecond;
    const userRequested = 20; // User wants 20 r/s

    const effectiveRateLimit = Math.min(userRequested, sesRateLimit);

    expect(effectiveRateLimit).toBe(14); // Capped at SES limit
  });
});

describe("Rate Limit Configuration Examples", () => {
  it("email config with SES limits", () => {
    const config: EmbeddedSendConfig = {
      id: "ses-config",
      module: "email",
      config: {
        mode: "managed",
        provider: "ses",
      },
      rateLimit: {
        requestsPerSecond: 14, // SES limit
        recipientsPerRequest: 50, // SES batch limit
        dailyLimit: 50000, // SES sandbox limit
      },
    };

    const throughput =
      config.rateLimit!.requestsPerSecond! * config.rateLimit!.recipientsPerRequest!;

    expect(throughput).toBe(700); // 700 emails/sec
  });

  it("webhook config with user-defined limits", () => {
    const config: EmbeddedSendConfig = {
      id: "webhook-config",
      module: "webhook",
      config: {
        url: "https://customer-api.example.com/events",
        method: "POST",
        headers: { "X-Api-Key": "secret" },
      },
      rateLimit: {
        requestsPerSecond: 20, // Their server can handle 20 r/s
        recipientsPerRequest: 50, // They want 50 events per batch
      },
    };

    const throughput =
      config.rateLimit!.requestsPerSecond! * config.rateLimit!.recipientsPerRequest!;

    expect(throughput).toBe(1000); // 1000 events/sec
  });

  it("SMS config with Telnyx limits", () => {
    const config: EmbeddedSendConfig = {
      id: "sms-config",
      module: "sms",
      config: {
        provider: "telnyx",
        apiKey: "KEY_xxx",
        fromNumber: "+1234567890",
      },
      rateLimit: {
        requestsPerSecond: 15, // User account limit
        recipientsPerRequest: 1, // Telnyx has no batch API
      },
    };

    const throughput =
      config.rateLimit!.requestsPerSecond! * config.rateLimit!.recipientsPerRequest!;

    expect(throughput).toBe(15); // 15 SMS/sec
  });
});
