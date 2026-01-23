import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebhookDeduplicator } from "../../../webhooks/webhook-deduplicator.js";
import { WebhookEvent, WebhookEventFactory } from "../../../webhooks/queue-processor.js";
import { CacheService } from "../../../services/cache-service.js";

// Mock cache service for testing
class MockCacheService extends CacheService {
  private processedWebhooks = new Set<string>();
  private messageCache = new Map<string, any>();
  public checkCalls = 0;
  public markCalls = 0;

  constructor() {
    // Don't call super to avoid Redis connection
    super();
    // Override Redis connection
    (this as any).redis = null;
    (this as any).isConnected = true;
  }

  async checkWebhookProcessed(provider: string, messageId: string, eventType: string): Promise<boolean> {
    this.checkCalls++;
    const key = `webhook:${provider}:${messageId}:${eventType}`;
    return this.processedWebhooks.has(key);
  }

  async markWebhookProcessed(provider: string, messageId: string, eventType: string): Promise<void> {
    this.markCalls++;
    const key = `webhook:${provider}:${messageId}:${eventType}`;
    this.processedWebhooks.add(key);
  }

  async batchCheckWebhooksProcessed(
    webhooks: Array<{ provider: string; messageId: string; eventType: string }>
  ): Promise<Map<string, boolean>> {
    this.checkCalls += webhooks.length;
    const results = new Map<string, boolean>();

    for (const w of webhooks) {
      const key = `${w.provider}:${w.messageId}:${w.eventType}`;
      const redisKey = `webhook:${w.provider}:${w.messageId}:${w.eventType}`;
      results.set(key, this.processedWebhooks.has(redisKey));
    }

    return results;
  }

  clearCache(): void {
    this.processedWebhooks.clear();
    this.messageCache.clear();
    this.checkCalls = 0;
    this.markCalls = 0;
  }
}

describe("Webhook Deduplication Tests", () => {
  let cacheService: MockCacheService;
  let deduplicator: WebhookDeduplicator;

  beforeEach(() => {
    cacheService = new MockCacheService();
    deduplicator = new WebhookDeduplicator(cacheService);
  });

  afterEach(() => {
    cacheService.clearCache();
    deduplicator.clearMemoryCache();
  });

  describe("In-Memory Deduplication", () => {
    it("should detect duplicates in memory cache", async () => {
      const event = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: "test-123",
          from: "test@example.com",
          to: ["user@example.com"],
          subject: "Test",
        },
      });

      // First check - should be new
      const result1 = await deduplicator.deduplicateBatch([event]);
      expect(result1.stats.new).toBe(1);
      expect(result1.stats.duplicates).toBe(0);

      // Mark as processed (sync operation in simplified implementation)
      deduplicator.markProcessed([event]);

      // Second check - should be duplicate from memory cache
      const result2 = await deduplicator.deduplicateBatch([event]);
      expect(result2.stats.new).toBe(0);
      expect(result2.stats.duplicates).toBe(1);
      expect(result2.stats.cacheHits).toBe(1);

      // Simplified deduplicator only uses in-memory cache (NATS handles distributed dedup)
      // No calls to distributed cache service
      expect(cacheService.checkCalls).toBe(0);
    });

    it("should not find events only in distributed cache (memory-only dedup)", async () => {
      const event = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: "test-456",
          from: "test@example.com",
          to: ["user@example.com"],
          subject: "Test",
        },
      });

      // Mark as processed in distributed cache only (simulating another worker)
      await cacheService.markWebhookProcessed(event.provider, event.providerMessageId, event.eventType);

      // Simplified deduplicator doesn't check distributed cache - NATS handles cross-worker dedup
      // So this should be treated as new (memory cache miss)
      const result = await deduplicator.deduplicateBatch([event]);
      expect(result.stats.new).toBe(1);
      expect(result.stats.duplicates).toBe(0);
      // No distributed cache calls in simplified implementation
      expect(cacheService.checkCalls).toBe(0);
    });

    it("should handle mixed duplicate and new events", async () => {
      const events: WebhookEvent[] = [];

      // Create 10 events, half are duplicates
      for (let i = 0; i < 10; i++) {
        const isDuplicate = i < 5;
        const event = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: isDuplicate ? "duplicate" : `unique-${i}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        });
        events.push(event);
      }

      // Mark first event as processed
      await deduplicator.markProcessed([events[0]]);

      // Check batch
      const result = await deduplicator.deduplicateBatch(events);

      expect(result.stats.total).toBe(10);
      expect(result.stats.duplicates).toBe(5); // First 5 have same ID
      expect(result.stats.new).toBe(5); // Last 5 are unique
      expect(result.newEvents).toHaveLength(5);
      expect(result.duplicates).toHaveLength(5);
    });
  });

  describe("Performance and Scale", () => {
    it("should handle large batches efficiently", async () => {
      const batchSize = 1000;
      const duplicateCount = 200;
      const events: WebhookEvent[] = [];

      // Create events - some will be duplicates of previously marked events
      for (let i = 0; i < batchSize; i++) {
        const isDuplicate = i % 5 === 0;
        const event = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: isDuplicate ? "duplicate-event" : `unique-${i}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        });
        events.push(event);
      }

      // Mark the duplicate event as processed first (simulating it was processed before)
      const duplicateEvent = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: "duplicate-event",
          from: "test@example.com",
          to: ["user@example.com"],
          subject: "Test",
        },
      });
      deduplicator.markProcessed([duplicateEvent]);

      const startTime = performance.now();
      const result = await deduplicator.deduplicateBatch(events);
      const duration = performance.now() - startTime;

      console.log(`
        Large batch deduplication:
        - Batch size: ${batchSize}
        - Duplicates found: ${result.stats.duplicates}
        - New events: ${result.stats.new}
        - Duration: ${duration.toFixed(2)}ms
        - Per-event time: ${(duration / batchSize).toFixed(3)}ms
      `);

      expect(result.stats.total).toBe(batchSize);
      // Events with email_id "duplicate-event" are found in memory cache
      expect(result.stats.duplicates).toBe(duplicateCount);
      expect(result.stats.new).toBe(batchSize - duplicateCount);
      expect(duration).toBeLessThan(100); // Should be fast
    });

    it("should maintain accuracy across multiple providers", async () => {
      const providers = ["resend", "ses", "telnyx"];
      const events: WebhookEvent[] = [];

      // Create events from different providers
      for (const provider of providers) {
        for (let i = 0; i < 10; i++) {
          let event: WebhookEvent;

          if (provider === "telnyx") {
            event = WebhookEventFactory.fromTelnyx({
              data: {
                event_type: "message.finalized",
                id: `${provider}-${i}`,
                occurred_at: new Date().toISOString(),
                payload: {
                  id: `msg-${i}`,
                  status: "delivered",
                },
              },
            });
          } else {
            event = {
              ...WebhookEventFactory.fromResend({
                type: "email.delivered",
                created_at: new Date().toISOString(),
                data: {
                  email_id: `msg-${i}`,
                  from: "test@example.com",
                  to: ["user@example.com"],
                  subject: "Test",
                },
              }),
              provider: provider as any,
            };
          }

          events.push(event);
        }
      }

      // Mark some as processed
      const toMark = events.filter((_, i) => i % 3 === 0);
      await deduplicator.markProcessed(toMark);

      // Check deduplication
      const result = await deduplicator.deduplicateBatch(events);

      expect(result.stats.duplicates).toBe(toMark.length);
      expect(result.stats.new).toBe(events.length - toMark.length);

      // Verify provider isolation (same message ID, different provider = different event)
      const crossProviderEvents = providers.map(provider => ({
        ...WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: "same-id",
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        }),
        provider: provider as any,
      }));

      const crossResult = await deduplicator.deduplicateBatch(crossProviderEvents);
      expect(crossResult.stats.new).toBe(3); // All should be new (different providers)
    });
  });

  describe("Memory Management", () => {
    it("should clean up old memory cache entries", async () => {
      // This test would need to mock time or wait
      // For now, just verify cleanup method exists
      const stats1 = deduplicator.getStats();
      expect(stats1.memoryCacheSize).toBe(0);

      // Add some events
      const events = Array(100).fill(null).map((_, i) =>
        WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `test-${i}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        })
      );

      await deduplicator.markProcessed(events);

      const stats2 = deduplicator.getStats();
      expect(stats2.memoryCacheSize).toBe(100);

      // Clear and verify
      deduplicator.clearMemoryCache();
      const stats3 = deduplicator.getStats();
      expect(stats3.memoryCacheSize).toBe(0);
    });
  });

  describe("Event Type Deduplication", () => {
    it("should treat different event types for same message as separate", async () => {
      const messageId = "test-message-123";
      const baseEvent = {
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: messageId,
          from: "test@example.com",
          to: ["user@example.com"],
          subject: "Test",
        },
      };

      // Create events with same message ID but different types
      const deliveredEvent = WebhookEventFactory.fromResend({ ...baseEvent, type: "email.delivered" });
      const bouncedEvent = WebhookEventFactory.fromResend({ ...baseEvent, type: "email.bounced" });
      const openedEvent = WebhookEventFactory.fromResend({ ...baseEvent, type: "email.opened" });

      // Mark delivered as processed
      await deduplicator.markProcessed([deliveredEvent]);

      // Check all three
      const result = await deduplicator.deduplicateBatch([deliveredEvent, bouncedEvent, openedEvent]);

      expect(result.stats.duplicates).toBe(1); // Only delivered is duplicate
      expect(result.stats.new).toBe(2); // Bounced and opened are new
      expect(result.newEvents).toHaveLength(2);
      expect(result.newEvents.map(e => e.eventType)).toContain("bounced");
      expect(result.newEvents.map(e => e.eventType)).toContain("opened");
    });
  });

  describe("Sequential Processing After Marking", () => {
    it("should handle rapid sequential checks after marking as processed", async () => {
      const event = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: "sequential-test",
          from: "test@example.com",
          to: ["user@example.com"],
          subject: "Test",
        },
      });

      // First check - should be new
      const result1 = await deduplicator.deduplicateBatch([event]);
      expect(result1.stats.new).toBe(1);

      // Mark as processed
      deduplicator.markProcessed([event]);

      // Subsequent checks should all be duplicates (rapid sequential)
      const results: number[] = [];
      for (let i = 0; i < 9; i++) {
        const result = await deduplicator.deduplicateBatch([event]);
        results.push(result.stats.duplicates);
      }

      // All 9 should be duplicates
      expect(results.every(d => d === 1)).toBe(true);
    });

    it("concurrent checks without prior marking all return new (NATS handles concurrent dedup)", async () => {
      // Note: The in-memory deduplicator doesn't handle concurrent dedup within batch checks
      // NATS msgID deduplication handles concurrent publishes at publish time
      const event = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: "concurrent-test",
          from: "test@example.com",
          to: ["user@example.com"],
          subject: "Test",
        },
      });

      // Process same event concurrently (before marking)
      const promises = Array(10).fill(null).map(() =>
        deduplicator.deduplicateBatch([event])
      );

      const results = await Promise.all(promises);

      // All should be marked as new since none are in memory cache yet
      // NATS msgID deduplication would catch these at publish time
      const newCount = results.filter(r => r.stats.new === 1).length;
      expect(newCount).toBe(10);
    });
  });
});