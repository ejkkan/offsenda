/**
 * Tests for the two-layer webhook deduplication strategy:
 *
 * Layer 1: NATS msgID (at publish time)
 *   - Catches: Provider retries of the same webhook
 *   - How: Deterministic event.id used as NATS msgID
 *   - Window: 1 hour (NATS JetStream dedup window)
 *
 * Layer 2: In-memory cache (at consume time)
 *   - Catches: Redeliveries after worker crash/restart
 *   - How: WebhookDeduplicator tracks processed events
 *   - Window: 5 minutes (in-memory TTL)
 *
 * Layer 3: PostgreSQL (at DB write time)
 *   - Catches: Everything else (final safety net)
 *   - How: Idempotent updates (UPDATE WHERE status != 'delivered')
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebhookEventFactory, WebhookEvent } from "../../../webhooks/queue-processor.js";
import { WebhookDeduplicator } from "../../../webhooks/webhook-deduplicator.js";
import { CacheService } from "../../../services/cache-service.js";

// Mock CacheService (not used by simplified deduplicator, but required for constructor)
class MockCacheService extends CacheService {
  constructor() {
    super();
    (this as any).redis = null;
    (this as any).isConnected = true;
  }
}

describe("Two-Layer Deduplication Strategy", () => {
  describe("Layer 1: NATS msgID Deduplication (Deterministic IDs)", () => {
    it("should generate identical IDs for provider webhook retries", () => {
      // Scenario: Provider (e.g., Resend) retries the same webhook 3 times
      const providerWebhook = {
        type: "email.delivered",
        created_at: "2024-01-15T10:30:00Z",
        data: {
          email_id: "resend-msg-abc123",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "Welcome Email",
        },
      };

      // Simulate 3 retries from provider
      const retry1 = WebhookEventFactory.fromResend(providerWebhook);
      const retry2 = WebhookEventFactory.fromResend(providerWebhook);
      const retry3 = WebhookEventFactory.fromResend(providerWebhook);

      // All retries should produce the same ID
      expect(retry1.id).toBe(retry2.id);
      expect(retry2.id).toBe(retry3.id);

      // NATS will reject retries 2 and 3 because msgID is the same
      // (verified in integration tests with real NATS)
    });

    it("should generate different IDs for different webhook events", () => {
      // Different message IDs = different events
      const event1 = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: "msg-001", from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });

      const event2 = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: "msg-002", from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });

      expect(event1.id).not.toBe(event2.id);
    });

    it("should generate different IDs for different event types on same message", () => {
      // Same email can have delivered AND opened events - both should be processed
      const baseData = {
        created_at: new Date().toISOString(),
        data: { email_id: "msg-001", from: "a@b.com", to: ["c@d.com"], subject: "X" },
      };

      const delivered = WebhookEventFactory.fromResend({ ...baseData, type: "email.delivered" });
      const opened = WebhookEventFactory.fromResend({ ...baseData, type: "email.opened" });
      const clicked = WebhookEventFactory.fromResend({ ...baseData, type: "email.clicked" });

      expect(delivered.id).not.toBe(opened.id);
      expect(opened.id).not.toBe(clicked.id);
      expect(delivered.id).not.toBe(clicked.id);
    });

    describe("All providers generate deterministic IDs", () => {
      it("Resend: email_id + eventType", () => {
        const event = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: { email_id: "resend-123", from: "a@b.com", to: ["c@d.com"], subject: "X" },
        });
        expect(event.id).toBe("resend-resend-123-delivered");
      });

      it("Telnyx: messageId + eventType", () => {
        const event = WebhookEventFactory.fromTelnyx({
          data: {
            event_type: "message.finalized",
            occurred_at: new Date().toISOString(),
            payload: { id: "telnyx-456", status: "delivered" },
          },
        });
        expect(event.id).toBe("telnyx-telnyx-456-sms.delivered");
      });

      it("SES: messageId + eventType", () => {
        const event = WebhookEventFactory.fromSES({
          notificationType: "Delivery",
          mail: {
            messageId: "ses-789",
            timestamp: new Date().toISOString(),
            destination: ["user@example.com"],
          },
        });
        expect(event.id).toBe("ses-ses-789-delivered");
      });

      it("Custom: moduleId + messageId + eventType", () => {
        const event = WebhookEventFactory.fromCustom("my-provider", {
          message_id: "custom-abc",
          event_type: "delivered",
        });
        expect(event.id).toBe("custom-my-provider-custom-abc-delivered");
      });
    });
  });

  describe("Layer 2: In-Memory Deduplication (Redelivery Protection)", () => {
    let deduplicator: WebhookDeduplicator;

    beforeEach(() => {
      deduplicator = new WebhookDeduplicator(new MockCacheService());
    });

    it("should catch redeliveries of already-processed events", async () => {
      // Scenario: Worker processes event, crashes, NATS redelivers
      const event = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: "msg-123", from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });

      // First processing - should be new
      const result1 = await deduplicator.deduplicateBatch([event]);
      expect(result1.stats.new).toBe(1);
      expect(result1.newEvents).toHaveLength(1);

      // Mark as processed (happens after successful DB update)
      deduplicator.markProcessed([event]);

      // Redelivery after worker restart - should be caught as duplicate
      const result2 = await deduplicator.deduplicateBatch([event]);
      expect(result2.stats.duplicates).toBe(1);
      expect(result2.stats.cacheHits).toBe(1);
      expect(result2.newEvents).toHaveLength(0);
    });

    it("should allow same message with different event types", async () => {
      // delivered and opened are separate events for the same email
      const delivered = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: "msg-123", from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });

      const opened = WebhookEventFactory.fromResend({
        type: "email.opened",
        created_at: new Date().toISOString(),
        data: { email_id: "msg-123", from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });

      // Process delivered
      const result1 = await deduplicator.deduplicateBatch([delivered]);
      expect(result1.stats.new).toBe(1);
      deduplicator.markProcessed([delivered]);

      // opened should still be new (different event type)
      const result2 = await deduplicator.deduplicateBatch([opened]);
      expect(result2.stats.new).toBe(1);
    });

    it("should isolate events by provider", async () => {
      // Same message ID from different providers = different events
      const resendEvent: WebhookEvent = {
        id: "resend-msg-123-delivered",
        provider: "resend",
        eventType: "delivered",
        providerMessageId: "msg-123",
        timestamp: new Date().toISOString(),
      };

      const sesEvent: WebhookEvent = {
        id: "ses-msg-123-delivered",
        provider: "ses",
        eventType: "delivered",
        providerMessageId: "msg-123",
        timestamp: new Date().toISOString(),
      };

      // Process Resend event
      const result1 = await deduplicator.deduplicateBatch([resendEvent]);
      expect(result1.stats.new).toBe(1);
      deduplicator.markProcessed([resendEvent]);

      // SES event with same messageId should still be new
      const result2 = await deduplicator.deduplicateBatch([sesEvent]);
      expect(result2.stats.new).toBe(1);
    });
  });

  describe("Layers Working Together", () => {
    let deduplicator: WebhookDeduplicator;

    beforeEach(() => {
      deduplicator = new WebhookDeduplicator(new MockCacheService());
    });

    it("scenario: provider retries + worker redelivery", async () => {
      /**
       * Timeline:
       * T0: Provider sends webhook
       * T1: Worker receives, processes, marks as processed
       * T2: Provider retries (same webhook) - NATS rejects (Layer 1)
       * T3: Worker crashes
       * T4: NATS redelivers original message - Memory cache catches (Layer 2)
       */

      const webhookPayload = {
        type: "email.delivered",
        created_at: "2024-01-15T10:30:00Z",
        data: {
          email_id: "provider-msg-xyz",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "Test",
        },
      };

      // T0-T1: First processing
      const originalEvent = WebhookEventFactory.fromResend(webhookPayload);
      const result1 = await deduplicator.deduplicateBatch([originalEvent]);
      expect(result1.stats.new).toBe(1);
      deduplicator.markProcessed([originalEvent]);

      // T2: Provider retry generates same ID (NATS would reject)
      const providerRetry = WebhookEventFactory.fromResend(webhookPayload);
      expect(providerRetry.id).toBe(originalEvent.id);
      // In real system: NATS returns ack.duplicate = true

      // T4: NATS redelivery (same event object) - caught by memory cache
      const result2 = await deduplicator.deduplicateBatch([originalEvent]);
      expect(result2.stats.duplicates).toBe(1);
      expect(result2.stats.cacheHits).toBe(1);
    });

    it("scenario: different events for same recipient should all process", async () => {
      /**
       * Email lifecycle: sent -> delivered -> opened -> clicked
       * All should be processed as separate events
       */

      const basePayload = {
        created_at: new Date().toISOString(),
        data: {
          email_id: "email-lifecycle-123",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "Test",
        },
      };

      const eventTypes = ["email.sent", "email.delivered", "email.opened", "email.clicked"];
      const events = eventTypes.map(type =>
        WebhookEventFactory.fromResend({ ...basePayload, type })
      );

      // All events have different IDs
      const ids = new Set(events.map(e => e.id));
      expect(ids.size).toBe(4);

      // Process each event
      for (const event of events) {
        const result = await deduplicator.deduplicateBatch([event]);
        expect(result.stats.new).toBe(1);
        deduplicator.markProcessed([event]);
      }

      // Re-checking any event should be duplicate
      for (const event of events) {
        const result = await deduplicator.deduplicateBatch([event]);
        expect(result.stats.duplicates).toBe(1);
      }
    });

    it("scenario: batch processing with mixed duplicates", async () => {
      /**
       * Batch arrives with:
       * - 3 new events
       * - 2 duplicates of previously processed events
       */

      // Pre-process some events
      const processed1 = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: "already-processed-1", from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });
      const processed2 = WebhookEventFactory.fromResend({
        type: "email.bounced",
        created_at: new Date().toISOString(),
        data: { email_id: "already-processed-2", from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });
      deduplicator.markProcessed([processed1, processed2]);

      // Create batch with new events + duplicates
      const batch = [
        // New events
        WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: { email_id: "new-event-1", from: "a@b.com", to: ["c@d.com"], subject: "X" },
        }),
        WebhookEventFactory.fromResend({
          type: "email.opened",
          created_at: new Date().toISOString(),
          data: { email_id: "new-event-2", from: "a@b.com", to: ["c@d.com"], subject: "X" },
        }),
        WebhookEventFactory.fromResend({
          type: "email.clicked",
          created_at: new Date().toISOString(),
          data: { email_id: "new-event-3", from: "a@b.com", to: ["c@d.com"], subject: "X" },
        }),
        // Duplicates (redeliveries)
        processed1,
        processed2,
      ];

      const result = await deduplicator.deduplicateBatch(batch);

      expect(result.stats.total).toBe(5);
      expect(result.stats.new).toBe(3);
      expect(result.stats.duplicates).toBe(2);
      expect(result.newEvents).toHaveLength(3);
      expect(result.duplicates).toHaveLength(2);
    });
  });

  describe("Edge Cases", () => {
    let deduplicator: WebhookDeduplicator;

    beforeEach(() => {
      deduplicator = new WebhookDeduplicator(new MockCacheService());
    });

    it("should handle empty batches", async () => {
      const result = await deduplicator.deduplicateBatch([]);
      expect(result.stats.total).toBe(0);
      expect(result.stats.new).toBe(0);
      expect(result.stats.duplicates).toBe(0);
    });

    it("should handle events with undefined/null fields gracefully", async () => {
      const event: WebhookEvent = {
        id: "test-event-123",
        provider: "resend",
        eventType: "delivered",
        providerMessageId: "msg-123",
        timestamp: new Date().toISOString(),
        // metadata, recipientId, batchId, etc. are undefined
      };

      const result = await deduplicator.deduplicateBatch([event]);
      expect(result.stats.new).toBe(1);
    });

    it("should handle very long message IDs", async () => {
      const longId = "x".repeat(1000);
      const event = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: longId, from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });

      expect(event.id).toContain(longId);

      const result = await deduplicator.deduplicateBatch([event]);
      expect(result.stats.new).toBe(1);
    });
  });
});
