import { describe, it, expect } from "vitest";
import { WebhookEventFactory } from "../../../webhooks/queue-processor.js";

describe("WebhookEventFactory", () => {
  describe("Deterministic ID Generation", () => {
    describe("fromResend", () => {
      it("should generate same ID for same input (enables NATS deduplication)", () => {
        const resendEvent = {
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: "msg-123",
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        };

        const event1 = WebhookEventFactory.fromResend(resendEvent);
        const event2 = WebhookEventFactory.fromResend(resendEvent);

        expect(event1.id).toBe(event2.id);
        expect(event1.id).toBe("resend-msg-123-delivered");
      });

      it("should generate different IDs for different event types", () => {
        const baseEvent = {
          created_at: new Date().toISOString(),
          data: {
            email_id: "msg-123",
            from: "test@example.com",
            to: ["user@example.com"],
            subject: "Test",
          },
        };

        const delivered = WebhookEventFactory.fromResend({ ...baseEvent, type: "email.delivered" });
        const bounced = WebhookEventFactory.fromResend({ ...baseEvent, type: "email.bounced" });
        const opened = WebhookEventFactory.fromResend({ ...baseEvent, type: "email.opened" });

        expect(delivered.id).toBe("resend-msg-123-delivered");
        expect(bounced.id).toBe("resend-msg-123-bounced");
        expect(opened.id).toBe("resend-msg-123-opened");
        expect(delivered.id).not.toBe(bounced.id);
        expect(delivered.id).not.toBe(opened.id);
      });

      it("should generate different IDs for different message IDs", () => {
        const event1 = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: { email_id: "msg-111", from: "a@b.com", to: ["c@d.com"], subject: "X" },
        });

        const event2 = WebhookEventFactory.fromResend({
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: { email_id: "msg-222", from: "a@b.com", to: ["c@d.com"], subject: "X" },
        });

        expect(event1.id).not.toBe(event2.id);
      });

      it("should handle unknown event types with 'failed' fallback", () => {
        const event = WebhookEventFactory.fromResend({
          type: "email.unknown_type",
          created_at: new Date().toISOString(),
          data: { email_id: "msg-123", from: "a@b.com", to: ["c@d.com"], subject: "X" },
        });

        expect(event.id).toBe("resend-msg-123-failed");
        expect(event.eventType).toBe("failed");
      });
    });

    describe("fromTelnyx", () => {
      it("should generate same ID for same input", () => {
        const telnyxData = {
          data: {
            event_type: "message.finalized",
            occurred_at: new Date().toISOString(),
            payload: {
              id: "telnyx-msg-456",
              status: "delivered",
            },
          },
        };

        const event1 = WebhookEventFactory.fromTelnyx(telnyxData);
        const event2 = WebhookEventFactory.fromTelnyx(telnyxData);

        expect(event1.id).toBe(event2.id);
        expect(event1.id).toBe("telnyx-telnyx-msg-456-sms.delivered");
      });

      it("should generate different IDs for delivered vs failed status", () => {
        const deliveredData = {
          data: {
            event_type: "message.finalized",
            occurred_at: new Date().toISOString(),
            payload: { id: "msg-789", status: "delivered" },
          },
        };

        const failedData = {
          data: {
            event_type: "message.finalized",
            occurred_at: new Date().toISOString(),
            payload: { id: "msg-789", status: "failed" },
          },
        };

        const delivered = WebhookEventFactory.fromTelnyx(deliveredData);
        const failed = WebhookEventFactory.fromTelnyx(failedData);

        expect(delivered.id).toBe("telnyx-msg-789-sms.delivered");
        expect(failed.id).toBe("telnyx-msg-789-sms.failed");
        expect(delivered.id).not.toBe(failed.id);
      });

      it("should handle message.sent event type", () => {
        const sentData = {
          data: {
            event_type: "message.sent",
            occurred_at: new Date().toISOString(),
            payload: { id: "msg-123", status: "sent" },
          },
        };

        const event = WebhookEventFactory.fromTelnyx(sentData);
        expect(event.id).toBe("telnyx-msg-123-sent");
        expect(event.eventType).toBe("sent");
      });
    });

    describe("fromSES", () => {
      it("should generate same ID for same input", () => {
        const sesNotification = {
          notificationType: "Delivery",
          mail: {
            messageId: "ses-msg-789",
            timestamp: new Date().toISOString(),
            destination: ["user@example.com"],
          },
        };

        const event1 = WebhookEventFactory.fromSES(sesNotification);
        const event2 = WebhookEventFactory.fromSES(sesNotification);

        expect(event1.id).toBe(event2.id);
        expect(event1.id).toBe("ses-ses-msg-789-delivered");
      });

      it("should generate different IDs for different notification types", () => {
        const mail = {
          messageId: "ses-msg-123",
          timestamp: new Date().toISOString(),
          destination: ["user@example.com"],
        };

        const delivery = WebhookEventFactory.fromSES({
          notificationType: "Delivery",
          mail,
        });

        const bounce = WebhookEventFactory.fromSES({
          notificationType: "Bounce",
          mail,
          bounce: { bounceType: "Permanent" },
        });

        const complaint = WebhookEventFactory.fromSES({
          notificationType: "Complaint",
          mail,
        });

        expect(delivery.id).toBe("ses-ses-msg-123-delivered");
        expect(bounce.id).toBe("ses-ses-msg-123-bounced");
        expect(complaint.id).toBe("ses-ses-msg-123-complained");
      });

      it("should distinguish permanent vs transient bounces", () => {
        const mail = {
          messageId: "ses-msg-123",
          timestamp: new Date().toISOString(),
          destination: ["user@example.com"],
        };

        const permanentBounce = WebhookEventFactory.fromSES({
          notificationType: "Bounce",
          mail,
          bounce: { bounceType: "Permanent" },
        });

        const transientBounce = WebhookEventFactory.fromSES({
          notificationType: "Bounce",
          mail,
          bounce: { bounceType: "Transient" },
        });

        expect(permanentBounce.id).toBe("ses-ses-msg-123-bounced");
        expect(transientBounce.id).toBe("ses-ses-msg-123-soft_bounced");
        expect(permanentBounce.eventType).toBe("bounced");
        expect(transientBounce.eventType).toBe("soft_bounced");
      });
    });

    describe("fromCustom", () => {
      it("should generate same ID for same input", () => {
        const customData = {
          message_id: "custom-msg-123",
          event_type: "delivered",
          timestamp: new Date().toISOString(),
        };

        const event1 = WebhookEventFactory.fromCustom("my-module", customData);
        const event2 = WebhookEventFactory.fromCustom("my-module", customData);

        expect(event1.id).toBe(event2.id);
        expect(event1.id).toBe("custom-my-module-custom-msg-123-delivered");
      });

      it("should generate different IDs for different modules", () => {
        const data = { message_id: "msg-123", event_type: "delivered" };

        const event1 = WebhookEventFactory.fromCustom("module-a", data);
        const event2 = WebhookEventFactory.fromCustom("module-b", data);

        expect(event1.id).not.toBe(event2.id);
      });

      it("should handle various message ID field names", () => {
        const withMessageId = WebhookEventFactory.fromCustom("mod", { message_id: "id1", event_type: "sent" });
        const withMessageIdCamel = WebhookEventFactory.fromCustom("mod", { messageId: "id2", event_type: "sent" });
        const withId = WebhookEventFactory.fromCustom("mod", { id: "id3", event_type: "sent" });

        expect(withMessageId.id).toContain("id1");
        expect(withMessageIdCamel.id).toContain("id2");
        expect(withId.id).toContain("id3");
      });

      it("should map various event type strings to standard types", () => {
        const cases = [
          { input: "delivered", expected: "delivered" },
          { input: "message_delivered", expected: "delivered" },
          { input: "bounced", expected: "bounced" },
          { input: "hard_bounced", expected: "bounced" },
          { input: "failed", expected: "failed" },
          { input: "send_failed", expected: "failed" },
          { input: "sent", expected: "sent" },
          { input: "opened", expected: "opened" },
          { input: "clicked", expected: "clicked" },
          { input: "complained", expected: "complained" },
        ];

        for (const { input, expected } of cases) {
          const event = WebhookEventFactory.fromCustom("mod", {
            message_id: `msg-${input}`,
            event_type: input,
          });
          expect(event.eventType).toBe(expected);
        }
      });

      it("should use custom.event for unknown event types", () => {
        const event = WebhookEventFactory.fromCustom("mod", {
          message_id: "msg-123",
          event_type: "some_unknown_event",
        });

        expect(event.eventType).toBe("custom.event");
        expect(event.id).toContain("custom.event");
      });
    });
  });

  describe("ID Uniqueness Across Providers", () => {
    it("should generate unique IDs for same message ID across different providers", () => {
      const messageId = "shared-msg-id-123";

      const resendEvent = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: messageId, from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });

      const sesEvent = WebhookEventFactory.fromSES({
        notificationType: "Delivery",
        mail: { messageId, timestamp: new Date().toISOString(), destination: ["c@d.com"] },
      });

      const customEvent = WebhookEventFactory.fromCustom("custom-provider", {
        message_id: messageId,
        event_type: "delivered",
      });

      // All IDs should be different due to provider prefix
      expect(resendEvent.id).not.toBe(sesEvent.id);
      expect(sesEvent.id).not.toBe(customEvent.id);
      expect(resendEvent.id).not.toBe(customEvent.id);

      // Each should contain the provider prefix
      expect(resendEvent.id).toMatch(/^resend-/);
      expect(sesEvent.id).toMatch(/^ses-/);
      expect(customEvent.id).toMatch(/^custom-/);
    });
  });

  describe("NATS Deduplication Compatibility", () => {
    it("should produce stable IDs that work with NATS msgID deduplication", () => {
      // Simulate provider retrying the same webhook multiple times
      const providerRetries = 5;
      const webhookPayload = {
        type: "email.delivered",
        created_at: "2024-01-15T10:30:00Z", // Fixed timestamp
        data: {
          email_id: "provider-msg-abc123",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "Important Email",
        },
      };

      const ids = new Set<string>();
      for (let i = 0; i < providerRetries; i++) {
        const event = WebhookEventFactory.fromResend(webhookPayload);
        ids.add(event.id);
      }

      // All retries should produce the same ID
      expect(ids.size).toBe(1);
    });

    it("should NOT include timestamp in ID (would break deduplication)", () => {
      const event = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: "msg-123", from: "a@b.com", to: ["c@d.com"], subject: "X" },
      });

      // ID should not contain numbers that look like timestamps
      expect(event.id).not.toMatch(/\d{10,}/); // No Unix timestamps
      expect(event.id).not.toMatch(/\d{4}-\d{2}-\d{2}/); // No ISO dates
    });
  });
});
