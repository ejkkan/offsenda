import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebhookEventFactory } from "../../../webhooks/queue-processor.js";

describe("WebhookEventFactory", () => {
  describe("fromTelnyx", () => {
    it("should create webhook event from Telnyx delivery report", () => {
      const telnyxPayload = {
        data: {
          event_type: "message.finalized",
          id: "event-123",
          occurred_at: "2024-01-15T10:30:00Z",
          payload: {
            id: "msg-456",
            status: "delivered",
            to: [{ phone_number: "+15551234567" }],
            from: { phone_number: "+15559876543" },
          },
        },
      };

      const event = WebhookEventFactory.fromTelnyx(telnyxPayload);

      expect(event.provider).toBe("telnyx");
      expect(event.eventType).toBe("sms.delivered");
      expect(event.providerMessageId).toBe("msg-456");
      expect(event.timestamp).toBe("2024-01-15T10:30:00Z");
      expect(event.id).toContain("telnyx-msg-456");
    });

    it("should handle failed SMS status", () => {
      const telnyxPayload = {
        data: {
          event_type: "message.finalized",
          payload: {
            id: "msg-789",
            status: "failed",
            errors: [{ code: "30001", detail: "Undeliverable" }],
          },
        },
      };

      const event = WebhookEventFactory.fromTelnyx(telnyxPayload);

      expect(event.eventType).toBe("sms.failed");
      expect(event.metadata?.errors).toBeDefined();
    });
  });

  describe("fromResend", () => {
    it("should create webhook event from Resend delivered event", () => {
      const resendPayload = {
        type: "email.delivered",
        created_at: "2024-01-15T10:30:00Z",
        data: {
          email_id: "email-123",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "Test Email",
        },
      };

      const event = WebhookEventFactory.fromResend(resendPayload);

      expect(event.provider).toBe("resend");
      expect(event.eventType).toBe("delivered");
      expect(event.providerMessageId).toBe("email-123");
      expect(event.timestamp).toBe("2024-01-15T10:30:00Z");
      expect(event.metadata?.email).toBe("recipient@example.com");
    });

    it("should handle bounced email", () => {
      const resendPayload = {
        type: "email.bounced",
        created_at: "2024-01-15T10:30:00Z",
        data: {
          email_id: "email-456",
          to: ["bounced@example.com"],
        },
      };

      const event = WebhookEventFactory.fromResend(resendPayload);

      expect(event.eventType).toBe("bounced");
    });

    it("should map all event types correctly", () => {
      const eventTypes = [
        { input: "email.sent", expected: "sent" },
        { input: "email.delivered", expected: "delivered" },
        { input: "email.bounced", expected: "bounced" },
        { input: "email.complained", expected: "complained" },
        { input: "email.opened", expected: "opened" },
        { input: "email.clicked", expected: "clicked" },
      ];

      for (const { input, expected } of eventTypes) {
        const event = WebhookEventFactory.fromResend({
          type: input,
          created_at: new Date().toISOString(),
          data: { email_id: "test" },
        });
        expect(event.eventType).toBe(expected);
      }
    });
  });

  describe("fromSES", () => {
    it("should create webhook event from SES delivery notification", () => {
      const sesNotification = {
        notificationType: "Delivery",
        mail: {
          messageId: "ses-msg-123",
          timestamp: "2024-01-15T10:30:00Z",
          source: "sender@example.com",
          destination: ["recipient@example.com"],
        },
        delivery: {
          recipients: ["recipient@example.com"],
          timestamp: "2024-01-15T10:30:01Z",
        },
      };

      const event = WebhookEventFactory.fromSES(sesNotification);

      expect(event.provider).toBe("ses");
      expect(event.eventType).toBe("delivered");
      expect(event.providerMessageId).toBe("ses-msg-123");
      expect(event.metadata?.email).toBe("recipient@example.com");
    });

    it("should handle permanent bounce", () => {
      const sesNotification = {
        notificationType: "Bounce",
        mail: {
          messageId: "ses-msg-456",
          timestamp: "2024-01-15T10:30:00Z",
          destination: ["bounced@example.com"],
        },
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
        },
      };

      const event = WebhookEventFactory.fromSES(sesNotification);

      expect(event.eventType).toBe("bounced");
      expect(event.metadata?.bounceType).toBe("Permanent");
    });

    it("should handle soft bounce", () => {
      const sesNotification = {
        notificationType: "Bounce",
        mail: {
          messageId: "ses-msg-789",
          timestamp: "2024-01-15T10:30:00Z",
          destination: ["softbounce@example.com"],
        },
        bounce: {
          bounceType: "Transient",
          bounceSubType: "MailboxFull",
        },
      };

      const event = WebhookEventFactory.fromSES(sesNotification);

      expect(event.eventType).toBe("soft_bounced");
    });

    it("should handle complaint", () => {
      const sesNotification = {
        notificationType: "Complaint",
        mail: {
          messageId: "ses-msg-complaint",
          timestamp: "2024-01-15T10:30:00Z",
          destination: ["complainer@example.com"],
        },
      };

      const event = WebhookEventFactory.fromSES(sesNotification);

      expect(event.eventType).toBe("complained");
    });
  });

  describe("fromCustom", () => {
    it("should create webhook event from custom module data", () => {
      const moduleId = "custom-module-123";
      const customPayload = {
        event_type: "message.delivered",
        message_id: "custom-msg-456",
        timestamp: "2024-01-15T10:30:00Z",
        recipient: "user@example.com",
        metadata: {
          campaign_id: "campaign-789",
        },
      };

      const event = WebhookEventFactory.fromCustom(moduleId, customPayload);

      expect(event.provider).toBe("custom");
      expect(event.moduleId).toBe(moduleId);
      expect(event.providerMessageId).toBe("custom-msg-456");
      expect(event.eventType).toBe("delivered");
      expect(event.timestamp).toBe("2024-01-15T10:30:00Z");
      expect(event.id).toContain("custom-custom-module-123");
    });

    it("should map common event types correctly", () => {
      const testCases = [
        { input: "email.delivered", expected: "delivered" },
        { input: "message.bounced", expected: "bounced" },
        { input: "send.failed", expected: "failed" },
        { input: "mail.sent", expected: "sent" },
        { input: "email.opened", expected: "opened" },
        { input: "link.clicked", expected: "clicked" },
        { input: "spam.complained", expected: "complained" },
        { input: "unknown.event", expected: "custom.event" },
      ];

      for (const { input, expected } of testCases) {
        const event = WebhookEventFactory.fromCustom("test-module", {
          event_type: input,
          message_id: `msg-${input}`,
        });
        expect(event.eventType).toBe(expected);
      }
    });

    it("should handle different field naming conventions", () => {
      // Test with messageId (camelCase)
      const event1 = WebhookEventFactory.fromCustom("module-1", {
        messageId: "camel-123",
        eventType: "email.delivered",
      });
      expect(event1.providerMessageId).toBe("camel-123");
      expect(event1.eventType).toBe("delivered");

      // Test with type instead of event_type
      const event2 = WebhookEventFactory.fromCustom("module-2", {
        type: "message.bounced",
        id: "type-456",
      });
      expect(event2.providerMessageId).toBe("type-456");
      expect(event2.eventType).toBe("bounced");
    });

    it("should generate message ID if not provided", () => {
      const event = WebhookEventFactory.fromCustom("module-id", {
        event_type: "delivered",
        recipient: "test@example.com",
      });

      expect(event.providerMessageId).toContain("custom-module-id");
    });

    it("should preserve raw event data", () => {
      const customPayload = {
        event_type: "delivered",
        message_id: "raw-test",
        custom_field: "custom_value",
        nested: { data: "value" },
      };

      const event = WebhookEventFactory.fromCustom("test-module", customPayload);

      expect(event.rawEvent).toEqual(customPayload);
      expect(event.metadata?.custom_field).toBe("custom_value");
      expect(event.metadata?.nested).toEqual({ data: "value" });
    });
  });
});

describe("WebhookEvent interface", () => {
  it("should support custom provider type", () => {
    const event = WebhookEventFactory.fromCustom("test", { message_id: "123" });
    expect(event.provider).toBe("custom");
  });

  it("should support custom.event event type", () => {
    const event = WebhookEventFactory.fromCustom("test", {
      message_id: "123",
      event_type: "custom.unknown",
    });
    expect(event.eventType).toBe("custom.event");
  });

  it("should include moduleId for custom webhooks", () => {
    const event = WebhookEventFactory.fromCustom("my-module", { id: "123" });
    expect(event.moduleId).toBe("my-module");
  });
});