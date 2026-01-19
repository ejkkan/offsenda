import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { NatsClient } from "../../nats/client.js";
import { NatsQueueService } from "../../nats/queue-service.js";
import { WebhookQueueProcessor, WebhookEventFactory } from "../../webhooks/queue-processor.js";
import { NatsWebhookWorker } from "../../nats/webhook-worker.js";
import { db } from "../../db.js";
import { batches, recipients, sendConfigs, users } from "@batchsender/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

describe("Webhook Queue Processing Flow", () => {
  let natsClient: NatsClient;
  let queueService: NatsQueueService;
  let queueProcessor: WebhookQueueProcessor;
  let webhookWorker: NatsWebhookWorker;
  let testBatchId: string;
  let testRecipientId: string;
  let testUserId: string;
  let testProviderMessageId: string;

  beforeAll(async () => {
    // Initialize NATS
    natsClient = new NatsClient();
    await natsClient.connect();
    queueService = new NatsQueueService(natsClient);
    queueProcessor = new WebhookQueueProcessor(natsClient);
    webhookWorker = new NatsWebhookWorker(natsClient);

    // Create test data - use proper UUIDs for PostgreSQL
    testUserId = randomUUID();
    testBatchId = randomUUID();
    testRecipientId = randomUUID();
    testProviderMessageId = randomUUID();

    // Insert test user first (foreign key requirement)
    await db.insert(users).values({
      id: testUserId,
      email: `test-${testUserId}@example.com`,
      passwordHash: "test-hash-not-real",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Insert test batch
    await db.insert(batches).values({
      id: testBatchId,
      userId: testUserId,
      name: "Test Webhook Batch",
      totalRecipients: 1,
      sentCount: 1,
      deliveredCount: 0,
      bouncedCount: 0,
      failedCount: 0,
      status: "processing",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Insert test recipient
    await db.insert(recipients).values({
      id: testRecipientId,
      batchId: testBatchId,
      identifier: "test@example.com",
      email: "test@example.com",
      status: "sent",
      providerMessageId: testProviderMessageId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    // Cleanup test data (in correct order due to foreign keys)
    await db.delete(recipients).where(eq(recipients.id, testRecipientId));
    await db.delete(batches).where(eq(batches.id, testBatchId));
    await db.delete(users).where(eq(users.id, testUserId));

    // Close connections
    await webhookWorker.shutdown();
    await natsClient.close();
  });

  afterEach(async () => {
    // Reset recipient status between tests
    await db
      .update(recipients)
      .set({ status: "sent", deliveredAt: null, bouncedAt: null })
      .where(eq(recipients.id, testRecipientId));

    // Reset batch counters
    await db
      .update(batches)
      .set({ deliveredCount: 0, bouncedCount: 0, failedCount: 0 })
      .where(eq(batches.id, testBatchId));
  });

  it("should process delivery webhook through queue", async () => {
    // Create delivery webhook event
    const webhookEvent = WebhookEventFactory.fromResend({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: {
        email_id: testProviderMessageId,
        from: "test@batchsender.com",
        to: ["test@example.com"],
        subject: "Test Email",
      },
    });

    // Add recipient info (simulating lookup)
    webhookEvent.recipientId = testRecipientId;
    webhookEvent.batchId = testBatchId;
    webhookEvent.userId = testUserId;

    // Enqueue webhook
    await queueProcessor.enqueueWebhook(webhookEvent);

    // Start webhook worker processing
    const processingPromise = webhookWorker.startWebhookProcessor();

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop worker
    await webhookWorker.shutdown();

    // Verify recipient was updated
    const recipient = await db.query.recipients.findFirst({
      where: eq(recipients.id, testRecipientId),
    });

    expect(recipient?.status).toBe("delivered");
    expect(recipient?.deliveredAt).toBeTruthy();

    // Verify batch counter was updated
    const batch = await db.query.batches.findFirst({
      where: eq(batches.id, testBatchId),
    });

    expect(batch?.deliveredCount).toBe(1);
  });

  it("should process bounce webhook through queue", async () => {
    // Create bounce webhook event
    const webhookEvent = WebhookEventFactory.fromResend({
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: testProviderMessageId,
        from: "test@batchsender.com",
        to: ["test@example.com"],
        subject: "Test Email",
      },
    });

    // Add recipient info
    webhookEvent.recipientId = testRecipientId;
    webhookEvent.batchId = testBatchId;
    webhookEvent.userId = testUserId;

    // Enqueue webhook
    await queueProcessor.enqueueWebhook(webhookEvent);

    // Start webhook worker processing
    const processingPromise = webhookWorker.startWebhookProcessor();

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop worker
    await webhookWorker.shutdown();

    // Verify recipient was updated
    const recipient = await db.query.recipients.findFirst({
      where: eq(recipients.id, testRecipientId),
    });

    expect(recipient?.status).toBe("bounced");
    expect(recipient?.bouncedAt).toBeTruthy();

    // Verify batch counter was updated
    const batch = await db.query.batches.findFirst({
      where: eq(batches.id, testBatchId),
    });

    expect(batch?.bouncedCount).toBe(1);
  });

  it("should handle duplicate webhooks with deduplication", async () => {
    // Use unique message ID to avoid NATS stream-level deduplication from previous tests
    const uniqueMessageId = randomUUID();

    // Update recipient with unique message ID for this test
    await db
      .update(recipients)
      .set({ providerMessageId: uniqueMessageId })
      .where(eq(recipients.id, testRecipientId));

    // Create delivery webhook event
    const webhookEvent = WebhookEventFactory.fromResend({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: {
        email_id: uniqueMessageId,
        from: "test@batchsender.com",
        to: ["test@example.com"],
        subject: "Test Email",
      },
    });

    webhookEvent.recipientId = testRecipientId;
    webhookEvent.batchId = testBatchId;
    webhookEvent.userId = testUserId;

    // Use same event ID for both
    const eventId = webhookEvent.id;

    // Enqueue webhook twice
    await queueProcessor.enqueueWebhook(webhookEvent);
    await queueProcessor.enqueueWebhook({ ...webhookEvent, id: eventId });

    // Start webhook worker processing
    const processingPromise = webhookWorker.startWebhookProcessor();

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop worker
    await webhookWorker.shutdown();

    // Verify batch counter was only incremented once
    const batch = await db.query.batches.findFirst({
      where: eq(batches.id, testBatchId),
    });

    expect(batch?.deliveredCount).toBe(1); // Should be 1, not 2
  });

  it("should process webhooks in batches", async () => {
    // Get initial delivered count (may be non-zero from stale NATS messages)
    const initialBatch = await db.query.batches.findFirst({
      where: eq(batches.id, testBatchId),
    });
    const initialDeliveredCount = initialBatch?.deliveredCount || 0;

    // Create multiple recipients
    const recipientIds = [];
    for (let i = 0; i < 10; i++) {
      const recipientId = randomUUID();
      recipientIds.push(recipientId);

      await db.insert(recipients).values({
        id: recipientId,
        batchId: testBatchId,
        identifier: `test${i}@example.com`,
        email: `test${i}@example.com`,
        status: "sent",
        providerMessageId: `msg-${i}-${randomUUID()}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Update batch total
    await db
      .update(batches)
      .set({ totalRecipients: 11, sentCount: 11 })
      .where(eq(batches.id, testBatchId));

    // Enqueue multiple webhook events
    for (let i = 0; i < 10; i++) {
      const webhookEvent = WebhookEventFactory.fromResend({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: `msg-${i}-${randomUUID()}`,
          from: "test@batchsender.com",
          to: [`test${i}@example.com`],
          subject: "Test Email",
        },
      });

      webhookEvent.recipientId = recipientIds[i];
      webhookEvent.batchId = testBatchId;
      webhookEvent.userId = testUserId;

      await queueProcessor.enqueueWebhook(webhookEvent);
    }

    // Start webhook worker processing
    const processingPromise = webhookWorker.startWebhookProcessor();

    // Wait for batch processing
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Stop worker
    await webhookWorker.shutdown();

    // Verify batch counter (check delta, not absolute value, to handle stale NATS messages)
    const batch = await db.query.batches.findFirst({
      where: eq(batches.id, testBatchId),
    });

    expect((batch?.deliveredCount || 0) - initialDeliveredCount).toBe(10);

    // Cleanup
    for (const recipientId of recipientIds) {
      await db.delete(recipients).where(eq(recipients.id, recipientId));
    }
  });

  it("should handle SES webhook format", async () => {
    // Create SES webhook event
    const sesNotification = {
      notificationType: "Delivery",
      mail: {
        messageId: testProviderMessageId,
        timestamp: new Date().toISOString(),
        source: "test@batchsender.com",
        destination: ["test@example.com"],
      },
      delivery: {
        recipients: ["test@example.com"],
        timestamp: new Date().toISOString(),
        smtpResponse: "250 OK",
      },
    };

    const webhookEvent = WebhookEventFactory.fromSES(sesNotification);
    webhookEvent.recipientId = testRecipientId;
    webhookEvent.batchId = testBatchId;
    webhookEvent.userId = testUserId;

    // Enqueue webhook
    await queueProcessor.enqueueWebhook(webhookEvent);

    // Start webhook worker processing
    const processingPromise = webhookWorker.startWebhookProcessor();

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop worker
    await webhookWorker.shutdown();

    // Verify recipient was updated
    const recipient = await db.query.recipients.findFirst({
      where: eq(recipients.id, testRecipientId),
    });

    expect(recipient?.status).toBe("delivered");
  });

  it("should handle Telnyx webhook format", async () => {
    // Create Telnyx webhook event
    const telnyxWebhook = {
      data: {
        event_type: "message.finalized",
        id: randomUUID(),
        occurred_at: new Date().toISOString(),
        payload: {
          id: testProviderMessageId,
          status: "delivered",
          to: [{ phone_number: "+15551234567" }],
          from: { phone_number: "+15559876543" },
        },
      },
    };

    const webhookEvent = WebhookEventFactory.fromTelnyx(telnyxWebhook);
    webhookEvent.recipientId = testRecipientId;
    webhookEvent.batchId = testBatchId;
    webhookEvent.userId = testUserId;

    // Enqueue webhook
    await queueProcessor.enqueueWebhook(webhookEvent);

    // Start webhook worker processing
    const processingPromise = webhookWorker.startWebhookProcessor();

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Stop worker
    await webhookWorker.shutdown();

    // Verify recipient was updated
    const recipient = await db.query.recipients.findFirst({
      where: eq(recipients.id, testRecipientId),
    });

    expect(recipient?.status).toBe("delivered");
  });
});