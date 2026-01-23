/**
 * E2E Test: Basic Batch Flow
 *
 * Tests the complete user journey:
 * 1. Create batch via API
 * 2. Batch synced to NATS queue
 * 3. Worker processes batch
 * 4. Emails sent via mock provider
 * 5. Webhooks received and processed
 * 6. Batch marked as completed
 */

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../../test/db.js";
import { batches, recipients } from "@batchsender/db";
import { eq } from "drizzle-orm";
import { clickhouse } from "../../clickhouse.js";
import {
  createBatch,
  sendBatch,
  getBatchStatus,
  sendWebhook,
  waitFor,
  sleep,
  setApiKey,
} from "../../../test/helpers.js";
import { buildSNSMessage, createTestUser, createTestApiKey } from "../helpers/fixtures.js";

describe("E2E: Basic Batch Flow", () => {
  let testUserId: string;

  beforeEach(async () => {
    // Create test user
    const testUser = createTestUser();
    await db.insert(require("@batchsender/db").users).values(testUser);
    testUserId = testUser.id;

    // Create and insert API key
    const { apiKey, dbRecord } = createTestApiKey(testUserId);
    await db.insert(require("@batchsender/db").apiKeys).values(dbRecord);
    setApiKey(apiKey);
  });

  it("should process small batch end-to-end", async () => {
    // 1. Create batch via API
    const { id: batchId } = await createBatch({
      name: "E2E Test Batch",
      subject: "Test Email",
      fromEmail: "test@batchsender.local",
      fromName: "Test Sender",
      htmlContent: "<p>Hello {{name}}!</p>",
      textContent: "Hello {{name}}!",
      recipients: [
        { email: "user1@test.local", name: "User One" },
        { email: "user2@test.local", name: "User Two" },
        { email: "user3@test.local", name: "User Three" },
      ],
    });

    expect(batchId).toBeDefined();

    // 2. Check batch is created as draft
    let batch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    expect(batch).toBeDefined();
    expect(batch?.status).toBe("draft");
    expect(batch?.totalRecipients).toBe(3);

    // 3. Start sending the batch
    await sendBatch(batchId);

    // 4. Verify batch is now queued
    batch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });
    expect(batch?.status).toBe("queued");

    // 3. Wait for NATS to process and send emails
    // MockEmailProvider will "send" instantly
    await waitFor(
      async () => {
        const b = await db.query.batches.findFirst({
          where: eq(batches.id, batchId),
        });
        return b?.sentCount === 3 ? b : null;
      },
      {
        timeout: 15000,
        timeoutMessage: "Batch did not send all emails",
      }
    );

    // 4. Verify all recipients are sent
    const allRecipients = await db.query.recipients.findMany({
      where: eq(recipients.batchId, batchId),
    });

    expect(allRecipients.length).toBe(3);
    expect(allRecipients.every((r) => r.status === "sent")).toBe(true);
    expect(allRecipients.every((r) => r.providerMessageId)).toBe(true);

    // 5. Verify ClickHouse events (queued + sent)
    await sleep(1000); // Wait for ClickHouse to process

    const eventResult = await clickhouse.query({
      query: `
        SELECT event_type, count() as cnt
        FROM email_events
        WHERE batch_id = {batchId:UUID}
        GROUP BY event_type
        ORDER BY event_type
      `,
      query_params: { batchId },
      format: "JSONEachRow",
    });

    const events = await eventResult.json<{ event_type: string; cnt: string }>();

    expect(Number(events.find((e) => e.event_type === "queued")?.cnt)).toBe(3);
    expect(Number(events.find((e) => e.event_type === "sent")?.cnt)).toBe(3);

    // 6. Simulate webhooks (delivery notifications)
    for (const recipient of allRecipients) {
      const webhookPayload = buildSNSMessage(
        recipient.providerMessageId!,
        "Delivery",
        recipient.email
      );

      await sendWebhook(webhookPayload);
    }

    // 7. Wait for webhooks to be processed
    await waitFor(
      async () => {
        const b = await db.query.batches.findFirst({
          where: eq(batches.id, batchId),
        });
        return b?.deliveredCount === 3 ? b : null;
      },
      {
        timeout: 10000,
        timeoutMessage: "Webhooks not processed",
      }
    );

    // 8. Verify final state
    const finalBatch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    expect(finalBatch?.status).toBe("completed");
    expect(finalBatch?.sentCount).toBe(3);
    expect(finalBatch?.deliveredCount).toBe(3);

    const deliveredRecipients = await db.query.recipients.findMany({
      where: eq(recipients.batchId, batchId),
    });

    expect(deliveredRecipients.every((r) => r.status === "delivered")).toBe(true);

    // 9. Verify ClickHouse has delivery events
    await sleep(1000);

    const deliveryResult = await clickhouse.query({
      query: `
        SELECT count() as cnt
        FROM email_events
        WHERE batch_id = {batchId:UUID}
          AND event_type = 'delivered'
      `,
      query_params: { batchId },
      format: "JSONEachRow",
    });

    const deliveryEvents = await deliveryResult.json<{ cnt: string }>();
    expect(Number(deliveryEvents[0]?.cnt)).toBe(3);
  });

  it("should handle batch with variable substitution", async () => {
    const { id: batchId } = await createBatch({
      name: "Variable Test Batch",
      subject: "Hello {{name}}!",
      fromEmail: "test@batchsender.local",
      htmlContent: "<p>Dear {{name}}, your code is {{code}}</p>",
      textContent: "Dear {{name}}, your code is {{code}}",
      recipients: [
        {
          email: "user1@test.local",
          name: "Alice",
          variables: { code: "ABC123" },
        },
        {
          email: "user2@test.local",
          name: "Bob",
          variables: { code: "XYZ789" },
        },
      ],
    });

    // Start sending
    await sendBatch(batchId);

    // Wait for processing
    await waitFor(
      async () => {
        const batch = await db.query.batches.findFirst({
          where: eq(batches.id, batchId),
        });
        return batch?.sentCount === 2 ? batch : null;
      },
      { timeout: 15000 }
    );

    const allRecipients = await db.query.recipients.findMany({
      where: eq(recipients.batchId, batchId),
    });

    expect(allRecipients.length).toBe(2);
    expect(allRecipients.every((r) => r.status === "sent")).toBe(true);
  });

  it("should reject empty batch", async () => {
    // API should reject batches with no recipients
    await expect(
      createBatch({
        name: "Empty Batch",
        subject: "Test",
        fromEmail: "test@batchsender.local",
        recipients: [],
      })
    ).rejects.toThrow(/400.*too_small/);
  });
});
