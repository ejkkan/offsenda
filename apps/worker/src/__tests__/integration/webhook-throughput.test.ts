import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { EventBuffer } from "../../webhooks/event-buffer.js";
import { WebhookEvent, WebhookEventFactory } from "../../webhooks/queue-processor.js";
import { performance } from "perf_hooks";

describe("Webhook Processing Throughput Tests", () => {
  let processedEvents: WebhookEvent[] = [];
  let processingTimes: number[] = [];

  beforeEach(() => {
    processedEvents = [];
    processingTimes = [];
  });

  describe("EventBuffer Performance", () => {
    it("should handle 10k events/second throughput", async () => {
      const targetEventsPerSecond = 10_000;
      const testDurationMs = 1000;
      let eventsSent = 0;

      const buffer = new EventBuffer({
        maxSize: 100,
        flushIntervalMs: 50,
        onFlush: async (events) => {
          processedEvents.push(...events);
        },
      });

      const startTime = performance.now();

      // Generate events as fast as possible
      while (performance.now() - startTime < testDurationMs) {
        const event = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `test-${eventsSent}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        });

        await buffer.add(event);
        eventsSent++;
      }

      // Wait for final flush
      await buffer.close();

      const actualDurationMs = performance.now() - startTime;
      const eventsPerSecond = (eventsSent / actualDurationMs) * 1000;

      console.log(`
        EventBuffer Performance:
        - Events sent: ${eventsSent}
        - Events processed: ${processedEvents.length}
        - Duration: ${actualDurationMs.toFixed(2)}ms
        - Throughput: ${eventsPerSecond.toFixed(0)} events/second
      `);

      expect(processedEvents.length).toBe(eventsSent);
      expect(eventsPerSecond).toBeGreaterThan(targetEventsPerSecond);
    });

    it("should maintain low latency under high load", async () => {
      const buffer = new EventBuffer({
        maxSize: 100,
        flushIntervalMs: 10,
        onFlush: async (events) => {
          const flushTime = performance.now();
          processedEvents.push(...events);
          processingTimes.push(performance.now() - flushTime);
        },
      });

      // Send 1000 events rapidly
      const events = Array(1000).fill(null).map((_, i) =>
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

      const startTime = performance.now();

      for (const event of events) {
        await buffer.add(event);
      }

      await buffer.close();

      const totalTime = performance.now() - startTime;
      const avgFlushTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
      const maxFlushTime = Math.max(...processingTimes);

      console.log(`
        Latency under load:
        - Total time: ${totalTime.toFixed(2)}ms
        - Avg flush time: ${avgFlushTime.toFixed(2)}ms
        - Max flush time: ${maxFlushTime.toFixed(2)}ms
        - Flushes: ${processingTimes.length}
      `);

      expect(avgFlushTime).toBeLessThan(5); // Avg flush should be < 5ms
      expect(maxFlushTime).toBeLessThan(20); // Max flush should be < 20ms
    });

    it("should handle backpressure gracefully", async () => {
      let slowProcessingCount = 0;
      const buffer = new EventBuffer({
        maxSize: 10,
        flushIntervalMs: 1000,
        onFlush: async (events) => {
          // Simulate slow processing every 3rd batch
          if (++slowProcessingCount % 3 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          processedEvents.push(...events);
        },
      });

      const startTime = performance.now();
      const events = [];

      // Generate 100 events
      for (let i = 0; i < 100; i++) {
        events.push(WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `test-${i}`,
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        }));
      }

      // Add all events
      for (const event of events) {
        await buffer.add(event);
      }

      await buffer.close();

      const duration = performance.now() - startTime;

      console.log(`
        Backpressure handling:
        - Events: ${events.length}
        - Processed: ${processedEvents.length}
        - Duration: ${duration.toFixed(2)}ms
        - Slow batches: ${Math.floor(slowProcessingCount / 3)}
      `);

      expect(processedEvents.length).toBe(100);
      expect(duration).toBeLessThan(2000); // Should complete within 2 seconds
    });
  });

  describe("Batch Processing Performance", () => {
    it("should process different event types efficiently", async () => {
      const eventTypes = ["delivered", "bounced", "complained", "opened", "clicked"];
      const eventsPerType = 1000;

      const events: WebhookEvent[] = [];

      // Generate mixed event types
      for (let i = 0; i < eventsPerType; i++) {
        for (const eventType of eventTypes) {
          const resendType = `email.${eventType}` as any;
          events.push(WebhookEventFactory.fromResend({
            type: resendType,
            created_at: new Date().toISOString(),
            data: {
              email_id: `test-${eventType}-${i}`,
              from: "test@example.com",
              to: [`user${i}@example.com`],
              subject: "Test",
            },
          }));
        }
      }

      // Shuffle events
      events.sort(() => Math.random() - 0.5);

      const buffer = new EventBuffer({
        maxSize: 500,
        flushIntervalMs: 100,
        onFlush: async (batch) => {
          const startTime = performance.now();

          // Group by type (simulating real processing)
          const grouped = batch.reduce((acc, event) => {
            const type = event.eventType;
            if (!acc[type]) acc[type] = [];
            acc[type].push(event);
            return acc;
          }, {} as Record<string, WebhookEvent[]>);

          processingTimes.push(performance.now() - startTime);
          processedEvents.push(...batch);
        },
      });

      const startTime = performance.now();

      for (const event of events) {
        await buffer.add(event);
      }

      await buffer.close();

      const totalTime = performance.now() - startTime;
      const totalEvents = eventTypes.length * eventsPerType;
      const throughput = (totalEvents / totalTime) * 1000;

      console.log(`
        Mixed event type processing:
        - Total events: ${totalEvents}
        - Processing time: ${totalTime.toFixed(2)}ms
        - Throughput: ${throughput.toFixed(0)} events/second
        - Batches processed: ${processingTimes.length}
      `);

      expect(processedEvents.length).toBe(totalEvents);
      expect(throughput).toBeGreaterThan(5000); // Should handle > 5k mixed events/second
    });
  });

  describe("Memory Efficiency", () => {
    it("should not leak memory under sustained load", async () => {
      const initialMemory = process.memoryUsage().heapUsed;
      const iterations = 10;
      const eventsPerIteration = 1000;

      for (let i = 0; i < iterations; i++) {
        const buffer = new EventBuffer({
          maxSize: 100,
          flushIntervalMs: 50,
          onFlush: async (events) => {
            // Process and discard
          },
        });

        // Generate and process events
        for (let j = 0; j < eventsPerIteration; j++) {
          const event = WebhookEventFactory.fromResend({
            type: "email.delivered",
            created_at: new Date().toISOString(),
            data: {
              email_id: `test-${i}-${j}`,
              from: "test@example.com",
              to: ["user@example.com"],
              subject: "Test",
            },
          });

          await buffer.add(event);
        }

        await buffer.close();

        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;
      const memoryGrowthMB = memoryGrowth / (1024 * 1024);

      console.log(`
        Memory efficiency:
        - Initial memory: ${(initialMemory / 1024 / 1024).toFixed(2)} MB
        - Final memory: ${(finalMemory / 1024 / 1024).toFixed(2)} MB
        - Memory growth: ${memoryGrowthMB.toFixed(2)} MB
        - Events processed: ${iterations * eventsPerIteration}
      `);

      // Memory growth should be minimal (< 50MB for 10k events)
      expect(memoryGrowthMB).toBeLessThan(50);
    });
  });

  describe("Concurrent Processing", () => {
    it("should handle concurrent webhook streams", async () => {
      const providers = ["resend", "ses", "telnyx"];
      const eventsPerProvider = 1000;
      const buffers: EventBuffer[] = [];

      // Create a buffer for each provider
      for (const provider of providers) {
        const buffer = new EventBuffer({
          maxSize: 50,
          flushIntervalMs: 20,
          onFlush: async (events) => {
            processedEvents.push(...events);
          },
        });
        buffers.push(buffer);
      }

      const startTime = performance.now();

      // Send events to all buffers concurrently
      const promises = providers.map(async (provider, idx) => {
        const buffer = buffers[idx];

        for (let i = 0; i < eventsPerProvider; i++) {
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
            event = WebhookEventFactory.fromResend({
              type: "email.delivered",
              created_at: new Date().toISOString(),
              data: {
                email_id: `${provider}-${i}`,
                from: "test@example.com",
                to: ["user@example.com"],
                subject: "Test",
              },
            });
          }

          await buffer.add(event);
        }
      });

      await Promise.all(promises);

      // Close all buffers
      await Promise.all(buffers.map(b => b.close()));

      const totalTime = performance.now() - startTime;
      const totalEvents = providers.length * eventsPerProvider;
      const throughput = (totalEvents / totalTime) * 1000;

      console.log(`
        Concurrent provider processing:
        - Providers: ${providers.length}
        - Events per provider: ${eventsPerProvider}
        - Total events: ${totalEvents}
        - Processing time: ${totalTime.toFixed(2)}ms
        - Combined throughput: ${throughput.toFixed(0)} events/second
      `);

      expect(processedEvents.length).toBe(totalEvents);
      expect(throughput).toBeGreaterThan(10000); // Should handle > 10k events/second combined
    });
  });
});