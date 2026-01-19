import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventBuffer } from "../../webhooks/event-buffer.js";
import { WebhookDeduplicator } from "../../webhooks/webhook-deduplicator.js";
import { WebhookEnricher } from "../../webhooks/webhook-enricher.js";
import { WebhookBatchProcessor } from "../../webhooks/webhook-batch-processor.js";
import { DatabaseBatchUpdater } from "../../webhooks/database-batch-updater.js";
import { WebhookEvent, WebhookEventFactory } from "../../webhooks/queue-processor.js";
import { CacheService } from "../../services/cache-service.js";
import * as clickhouse from "../../clickhouse.js";

// Mock implementations
class FailingCacheService extends CacheService {
  private failureCount = 0;
  private maxFailures = 0;
  public failures = 0;

  constructor() {
    super();
    (this as any).redis = null;
    (this as any).isConnected = true;
  }

  setFailures(count: number) {
    this.maxFailures = count;
    this.failureCount = 0;
  }

  async checkWebhookProcessed(): Promise<boolean> {
    if (this.failureCount < this.maxFailures) {
      this.failureCount++;
      this.failures++;
      throw new Error("Cache unavailable");
    }
    return false;
  }

  async markWebhookProcessed(): Promise<void> {
    if (this.failureCount < this.maxFailures) {
      this.failureCount++;
      this.failures++;
      throw new Error("Cache unavailable");
    }
  }

  async batchCheckWebhooksProcessed(
    webhooks: Array<{ provider: string; messageId: string; eventType: string }>
  ): Promise<Map<string, boolean>> {
    if (this.failureCount < this.maxFailures) {
      this.failureCount++;
      this.failures++;
      throw new Error("Cache unavailable");
    }
    const results = new Map<string, boolean>();
    webhooks.forEach(w => {
      const key = `${w.provider}:${w.messageId}:${w.eventType}`;
      results.set(key, false);
    });
    return results;
  }

  async getCachedMessageLookup(): Promise<any> {
    if (this.failureCount < this.maxFailures) {
      this.failureCount++;
      this.failures++;
      throw new Error("Cache unavailable");
    }
    return null;
  }

  async cacheMessageLookup(): Promise<void> {
    if (this.failureCount < this.maxFailures) {
      this.failureCount++;
      this.failures++;
      throw new Error("Cache unavailable");
    }
  }
}

// Mock ClickHouse lookup
vi.mock("../../clickhouse.js", () => ({
  lookupByProviderMessageId: vi.fn(),
  logEmailEvent: vi.fn(),
}));

describe("Webhook System Resilience Tests", () => {
  let cacheService: FailingCacheService;
  let processedEvents: WebhookEvent[] = [];
  let processingErrors: Error[] = [];

  beforeEach(() => {
    cacheService = new FailingCacheService();
    processedEvents = [];
    processingErrors = [];
    vi.clearAllMocks();
  });

  describe("Cache Failure Resilience", () => {
    it("should continue processing when cache is unavailable", async () => {
      // Set cache to fail completely
      cacheService.setFailures(1000);

      const deduplicator = new WebhookDeduplicator(cacheService);
      const enricher = new WebhookEnricher(cacheService);
      const dbUpdater = new DatabaseBatchUpdater();

      // Mock database updater to track calls
      const mockProcessDeliveries = vi.fn().mockResolvedValue({
        recipientsUpdated: 10,
        batchesUpdated: 1,
        errors: 0,
      });
      dbUpdater.processDeliveries = mockProcessDeliveries;

      const processor = new WebhookBatchProcessor(deduplicator, enricher, dbUpdater);

      // Create test events
      const events = Array(10).fill(null).map((_, i) =>
        WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `test-${i}`,
            from: "test@example.com",
            to: [`user${i}@example.com`],
            subject: "Test",
          },
        })
      );

      // Add recipient IDs to simulate enriched events
      events.forEach((e, i) => {
        e.recipientId = `recipient-${i}`;
        e.batchId = `batch-1`;
        e.userId = `user-1`;
      });

      // Process batch - should not throw despite cache failures
      const result = await processor.processBatch(events);

      expect(result.processed).toBe(10);
      expect(result.errors).toBe(0);
      expect(mockProcessDeliveries).toHaveBeenCalledWith(events);
      expect(cacheService.failures).toBeGreaterThan(0);
    });

    it("should recover when cache comes back online", async () => {
      // Cache fails for first 3 operations, then recovers
      cacheService.setFailures(3);

      const buffer = new EventBuffer({
        maxSize: 5,
        flushIntervalMs: 100,
        onFlush: async (events) => {
          processedEvents.push(...events);
        },
      });

      // Send 10 events
      for (let i = 0; i < 10; i++) {
        const event = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `test-${i}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        });

        await buffer.add(event);
      }

      await buffer.close();

      expect(processedEvents).toHaveLength(10);
      expect(cacheService.failures).toBe(3);
    });
  });

  describe("Database Failure Resilience", () => {
    it("should handle database update failures gracefully", async () => {
      const deduplicator = new WebhookDeduplicator(cacheService);
      const enricher = new WebhookEnricher(cacheService);
      const dbUpdater = new DatabaseBatchUpdater();

      // Mock database updater to fail
      dbUpdater.processDeliveries = vi.fn().mockRejectedValue(new Error("Database connection lost"));

      const processor = new WebhookBatchProcessor(deduplicator, enricher, dbUpdater);

      const events = [
        WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: "test-1",
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        }),
      ];

      events[0].recipientId = "recipient-1";
      events[0].batchId = "batch-1";
      events[0].userId = "user-1";

      // Should throw but not crash
      await expect(processor.processBatch(events)).rejects.toThrow("Database connection lost");
    });

    it("should handle partial database update failures", async () => {
      const deduplicator = new WebhookDeduplicator(cacheService);
      const enricher = new WebhookEnricher(cacheService);
      const dbUpdater = new DatabaseBatchUpdater();

      // Mock mixed success/failure
      let callCount = 0;
      dbUpdater.processDeliveries = vi.fn().mockImplementation(async (events) => {
        callCount++;
        if (callCount === 1) {
          return { recipientsUpdated: events.length, batchesUpdated: 1, errors: 0 };
        }
        throw new Error("Database timeout");
      });

      dbUpdater.processBounces = vi.fn().mockResolvedValue({
        recipientsUpdated: 0,
        batchesUpdated: 0,
        errors: 1,
      });

      const processor = new WebhookBatchProcessor(deduplicator, enricher, dbUpdater);

      // Create mixed events
      const events = [
        WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: { email_id: "test-1", from: "test@example.com", to: ["user@example.com"], subject: "Test" },
        }),
        WebhookEventFactory.fromResend({
          type: "email.bounced",
          created_at: new Date().toISOString(),
          data: { email_id: "test-2", from: "test@example.com", to: ["user@example.com"], subject: "Test" },
        }),
      ];

      events.forEach((e, i) => {
        e.recipientId = `recipient-${i}`;
        e.batchId = "batch-1";
        e.userId = "user-1";
      });

      const result = await processor.processBatch(events);

      expect(result.processed).toBe(2); // Both processed
      expect(dbUpdater.processDeliveries).toHaveBeenCalled();
      expect(dbUpdater.processBounces).toHaveBeenCalled();
    });
  });

  describe("ClickHouse Lookup Failures", () => {
    it("should skip events when ClickHouse lookups fail", async () => {
      const mockLookup = vi.mocked(clickhouse.lookupByProviderMessageId);
      mockLookup.mockRejectedValue(new Error("ClickHouse connection timeout"));

      const enricher = new WebhookEnricher(cacheService);

      const events = [
        WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: "test-no-recipient",
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        }),
      ];

      const result = await enricher.enrichBatch(events);

      expect(result.skippedEvents).toHaveLength(1);
      expect(result.enrichedEvents).toHaveLength(0);
      expect(result.stats.skipped).toBe(1);
      expect(mockLookup).toHaveBeenCalledWith("test-no-recipient");
    });

    it("should use cache when available and ClickHouse fails", async () => {
      const mockLookup = vi.mocked(clickhouse.lookupByProviderMessageId);
      mockLookup.mockRejectedValue(new Error("ClickHouse down"));

      // Override cache to work and return cached data
      cacheService.getCachedMessageLookup = vi.fn().mockResolvedValue({
        recipientId: "cached-recipient-1",
        batchId: "cached-batch-1",
        userId: "cached-user-1",
      });

      const enricher = new WebhookEnricher(cacheService);

      const events = [
        WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: "test-cached",
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        }),
      ];

      const result = await enricher.enrichBatch(events);

      expect(result.enrichedEvents).toHaveLength(1);
      expect(result.enrichedEvents[0].recipientId).toBe("cached-recipient-1");
      expect(result.stats.cacheHits).toBe(1);
      expect(mockLookup).not.toHaveBeenCalled(); // Should not try ClickHouse
    });
  });

  describe("Buffer Overflow and Backpressure", () => {
    it("should handle buffer overflow gracefully", async () => {
      let slowProcessingActive = true;
      const buffer = new EventBuffer({
        maxSize: 5,
        flushIntervalMs: 10000, // Long timeout to force size-based flushes
        onFlush: async (events) => {
          if (slowProcessingActive) {
            // Simulate very slow processing
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          processedEvents.push(...events);
        },
      });

      // Rapidly send many events
      const sendPromises = [];
      for (let i = 0; i < 20; i++) {
        const event = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `test-${i}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        });

        sendPromises.push(buffer.add(event));
      }

      // Wait for all sends
      await Promise.all(sendPromises);

      // Stop slow processing
      slowProcessingActive = false;

      // Close and wait
      await buffer.close();

      expect(processedEvents).toHaveLength(20);
    });

    it("should re-queue events on processing failure", async () => {
      let failNext = true;
      const buffer = new EventBuffer({
        maxSize: 5,
        flushIntervalMs: 50,
        onFlush: async (events) => {
          if (failNext) {
            failNext = false;
            throw new Error("Processing failed");
          }
          processedEvents.push(...events);
        },
      });

      // Send events
      for (let i = 0; i < 5; i++) {
        const event = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `test-${i}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        });

        await buffer.add(event);
      }

      // First flush will fail
      try {
        await buffer.flush();
      } catch (error) {
        expect(error).toBeTruthy();
      }

      // Buffer should still have the events
      expect(buffer.size()).toBe(5);

      // Second flush should succeed
      await buffer.flush();

      expect(processedEvents).toHaveLength(5);
      expect(buffer.size()).toBe(0);
    });
  });

  describe("Worker Shutdown and Recovery", () => {
    it("should process remaining events on graceful shutdown", async () => {
      const buffer = new EventBuffer({
        maxSize: 100, // High limit to prevent auto-flush
        flushIntervalMs: 10000, // Long timeout
        onFlush: async (events) => {
          processedEvents.push(...events);
        },
      });

      // Add events but don't flush
      for (let i = 0; i < 10; i++) {
        const event = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `test-${i}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        });

        await buffer.add(event);
      }

      expect(processedEvents).toHaveLength(0); // Nothing flushed yet
      expect(buffer.size()).toBe(10);

      // Graceful shutdown
      await buffer.close();

      // All events should be processed
      expect(processedEvents).toHaveLength(10);
      expect(buffer.size()).toBe(0);

      // Should reject new events after close
      const newEvent = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: "after-close", from: "test@example.com", to: ["user@example.com"], subject: "Test" },
      });

      const added = await buffer.add(newEvent);
      expect(added).toBe(false);
    });
  });

  describe("Concurrent Processing Errors", () => {
    it("should handle concurrent processing with mixed failures", async () => {
      const deduplicator = new WebhookDeduplicator(cacheService);
      const enricher = new WebhookEnricher(cacheService);
      const dbUpdater = new DatabaseBatchUpdater();

      // Mock to fail randomly
      let processCount = 0;
      const mockProcessDeliveries = vi.fn().mockImplementation(async () => {
        processCount++;
        if (processCount % 2 === 0) {
          throw new Error("Random database failure");
        }
        return { recipientsUpdated: 1, batchesUpdated: 1, errors: 0 };
      });

      dbUpdater.processDeliveries = mockProcessDeliveries;

      const processor = new WebhookBatchProcessor(deduplicator, enricher, dbUpdater);

      // Process multiple batches concurrently
      const promises = [];
      for (let batch = 0; batch < 5; batch++) {
        const events = [
          WebhookEventFactory.fromResend({
            type: "email.delivered",
            created_at: new Date().toISOString(),
            data: {
              email_id: `test-${batch}`,
              from: "test@example.com",
              to: ["user@example.com"],
              subject: "Test",
            },
          }),
        ];

        events[0].recipientId = `recipient-${batch}`;
        events[0].batchId = `batch-${batch}`;
        events[0].userId = "user-1";

        promises.push(
          processor.processBatch(events).catch(err => {
            processingErrors.push(err);
            return { processed: 0, errors: 1, duplicates: 0, duration: 0 };
          })
        );
      }

      const results = await Promise.all(promises);

      // Some should succeed, some should fail
      const successes = results.filter(r => r.processed > 0).length;
      const failures = results.filter(r => r.errors > 0).length;

      expect(successes).toBeGreaterThan(0);
      expect(failures).toBeGreaterThan(0);
      expect(successes + failures).toBe(5);
    });
  });

  describe("Memory Pressure", () => {
    it("should handle memory pressure gracefully", async () => {
      const hugePayload = "x".repeat(1024 * 1024); // 1MB string

      const buffer = new EventBuffer({
        maxSize: 10,
        flushIntervalMs: 50,
        onFlush: async (events) => {
          // Simulate processing that clears memory
          processedEvents.push(...events.map(e => ({
            ...e,
            metadata: undefined, // Clear large data
          })));
        },
      });

      // Send events with large payloads
      for (let i = 0; i < 50; i++) {
        const event = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `test-${i}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        });

        // Add large metadata
        event.metadata = { hugeData: hugePayload };

        await buffer.add(event);
      }

      await buffer.close();

      expect(processedEvents).toHaveLength(50);

      // Verify memory is released (metadata cleared)
      processedEvents.forEach(event => {
        expect(event.metadata).toBeUndefined();
      });
    });
  });
});