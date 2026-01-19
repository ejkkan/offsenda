import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { NatsClient } from "../../nats/client.js";
import { WebhookQueueProcessor } from "../../webhooks/queue-processor.js";
import { registerWebhookRoutes } from "../../webhooks/routes.js";
import { db } from "../../db.js";
import { sendConfigs } from "@batchsender/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

describe("Webhook Routes (Async Processing)", () => {
  let app: FastifyInstance;
  let natsClient: NatsClient;
  let queueProcessor: WebhookQueueProcessor;
  let testModuleId: string;

  beforeAll(async () => {
    // Initialize app and NATS
    app = Fastify({
      logger: false,
    });
    natsClient = new NatsClient();
    await natsClient.connect();
    queueProcessor = new WebhookQueueProcessor(natsClient);

    // Register webhook routes
    registerWebhookRoutes(app, queueProcessor);

    await app.ready();

    // Create test custom module
    testModuleId = randomUUID();
    await db.insert(sendConfigs).values({
      id: testModuleId,
      userId: randomUUID(),
      name: "Test Custom Module",
      module: "webhook",
      config: {
        endpoint: "https://example.com/webhook",
        webhookSecret: "test-secret",
        signatureHeader: "x-webhook-signature",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    // Cleanup
    await db.delete(sendConfigs).where(eq(sendConfigs.id, testModuleId));
    await app.close();
    await natsClient.close();
  });

  it("should handle Resend webhook without synchronous lookup", async () => {
    // Mock the enqueue function to verify it's called
    const enqueueSpy = vi.spyOn(queueProcessor, "enqueueWebhook");

    const startTime = Date.now();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: "test-message-id",
          from: "test@batchsender.com",
          to: ["recipient@example.com"],
          subject: "Test Email",
        },
      },
    });

    const responseTime = Date.now() - startTime;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    // Should respond very quickly (no DB lookups)
    expect(responseTime).toBeLessThan(100);

    // Verify webhook was enqueued
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const enqueuedEvent = enqueueSpy.mock.calls[0][0];

    // Should NOT have recipient info (no lookup performed)
    expect(enqueuedEvent.recipientId).toBeUndefined();
    expect(enqueuedEvent.batchId).toBeUndefined();
    expect(enqueuedEvent.userId).toBeUndefined();
    expect(enqueuedEvent.providerMessageId).toBe("test-message-id");

    enqueueSpy.mockRestore();
  });

  it("should handle Telnyx webhook without synchronous lookup", async () => {
    const enqueueSpy = vi.spyOn(queueProcessor, "enqueueWebhook");

    const startTime = Date.now();

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/telnyx",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        data: {
          event_type: "message.finalized",
          id: randomUUID(),
          occurred_at: new Date().toISOString(),
          payload: {
            id: "test-sms-id",
            status: "delivered",
            to: [{ phone_number: "+15551234567" }],
            from: { phone_number: "+15559876543" },
          },
        },
      },
    });

    const responseTime = Date.now() - startTime;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(responseTime).toBeLessThan(100);

    const enqueuedEvent = enqueueSpy.mock.calls[0][0];
    expect(enqueuedEvent.recipientId).toBeUndefined();
    expect(enqueuedEvent.providerMessageId).toBe("test-sms-id");

    enqueueSpy.mockRestore();
  });

  it("should handle SES webhook without synchronous lookup", async () => {
    const enqueueSpy = vi.spyOn(queueProcessor, "enqueueWebhook");

    const startTime = Date.now();

    const snsMessage = {
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Delivery",
        mail: {
          messageId: "test-ses-message-id",
          timestamp: new Date().toISOString(),
          source: "test@batchsender.com",
          destination: ["recipient@example.com"],
        },
        delivery: {
          recipients: ["recipient@example.com"],
          timestamp: new Date().toISOString(),
          smtpResponse: "250 OK",
        },
      }),
    };

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/ses",
      headers: {
        "content-type": "text/plain",
      },
      payload: JSON.stringify(snsMessage),
    });

    const responseTime = Date.now() - startTime;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(responseTime).toBeLessThan(100);

    const enqueuedEvent = enqueueSpy.mock.calls[0][0];
    expect(enqueuedEvent.recipientId).toBeUndefined();
    expect(enqueuedEvent.providerMessageId).toBe("test-ses-message-id");

    enqueueSpy.mockRestore();
  });

  it("should handle custom module webhook", async () => {
    const enqueueSpy = vi.spyOn(queueProcessor, "enqueueWebhook");

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/custom/${testModuleId}`,
      headers: {
        "content-type": "application/json",
      },
      payload: {
        event_type: "message.delivered",
        message_id: "custom-msg-id",
        timestamp: new Date().toISOString(),
        recipient: "test@example.com",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    const enqueuedEvent = enqueueSpy.mock.calls[0][0];
    expect(enqueuedEvent.provider).toBe("custom");
    expect(enqueuedEvent.moduleId).toBe(testModuleId);
    expect(enqueuedEvent.providerMessageId).toBe("custom-msg-id");
    expect(enqueuedEvent.eventType).toBe("delivered");

    enqueueSpy.mockRestore();
  });

  it("should return 404 for non-existent custom module", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/custom/non-existent-module-id",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        event_type: "message.delivered",
        message_id: "custom-msg-id",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Module not found" });
  });

  it("should verify custom module webhook signature", async () => {
    const crypto = await import("crypto");
    const payload = {
      event_type: "message.delivered",
      message_id: "custom-msg-id",
      timestamp: new Date().toISOString(),
    };
    const payloadString = JSON.stringify(payload);

    // Create valid signature
    const validSignature = crypto
      .createHmac("sha256", "test-secret")
      .update(payloadString)
      .digest("hex");

    // Valid signature should pass
    const validResponse = await app.inject({
      method: "POST",
      url: `/webhooks/custom/${testModuleId}`,
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": validSignature,
      },
      payload,
    });

    expect(validResponse.statusCode).toBe(200);

    // Invalid signature should fail
    const invalidResponse = await app.inject({
      method: "POST",
      url: `/webhooks/custom/${testModuleId}`,
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": "invalid-signature",
      },
      payload,
    });

    expect(invalidResponse.statusCode).toBe(401);
    expect(invalidResponse.json()).toEqual({ error: "Invalid signature" });
  });

  it("should map custom webhook event types correctly", async () => {
    const enqueueSpy = vi.spyOn(queueProcessor, "enqueueWebhook");

    const testCases = [
      { input: "email.delivered", expected: "delivered" },
      { input: "message.bounced", expected: "bounced" },
      { input: "send.failed", expected: "failed" },
      { input: "mail.sent", expected: "sent" },
      { input: "click.opened", expected: "opened" },
      { input: "link.clicked", expected: "clicked" },
      { input: "spam.complained", expected: "complained" },
      { input: "unknown.event", expected: "custom.event" },
    ];

    for (const testCase of testCases) {
      await app.inject({
        method: "POST",
        url: `/webhooks/custom/${testModuleId}`,
        headers: {
          "content-type": "application/json",
        },
        payload: {
          event_type: testCase.input,
          message_id: `test-${testCase.input}`,
        },
      });

      const lastCall = enqueueSpy.mock.calls[enqueueSpy.mock.calls.length - 1];
      expect(lastCall[0].eventType).toBe(testCase.expected);
    }

    enqueueSpy.mockRestore();
  });

  it("should handle concurrent webhook requests efficiently", async () => {
    const enqueueSpy = vi.spyOn(queueProcessor, "enqueueWebhook");

    const startTime = Date.now();

    // Send 10 webhooks concurrently
    const promises = Array(10).fill(null).map((_, i) =>
      app.inject({
        method: "POST",
        url: "/webhooks/resend",
        headers: {
          "content-type": "application/json",
        },
        payload: {
          type: "email.delivered",
          created_at: new Date().toISOString(),
          data: {
            email_id: `concurrent-${i}`,
            from: "test@batchsender.com",
            to: [`recipient${i}@example.com`],
          },
        },
      })
    );

    const responses = await Promise.all(promises);
    const totalTime = Date.now() - startTime;

    // All should succeed
    responses.forEach(response => {
      expect(response.statusCode).toBe(200);
    });

    // Should handle all requests quickly
    expect(totalTime).toBeLessThan(500);

    // All events should be enqueued
    expect(enqueueSpy).toHaveBeenCalledTimes(10);

    enqueueSpy.mockRestore();
  });
});