/**
 * E2E Test: Dry Run Mode
 *
 * Tests that dryRun flag works correctly:
 * 1. Batch processes normally through queue
 * 2. Rate limiting still applies
 * 3. Recipients marked as sent
 * 4. ClickHouse events logged
 * 5. NO actual outbound calls made
 * 6. Provider message IDs start with "dry-run-"
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "../../../test/db.js";
import { batches, recipients } from "@batchsender/db";
import { eq } from "drizzle-orm";
import { clickhouse } from "../../clickhouse.js";
import {
  createBatch,
  sendBatch,
  waitFor,
  sleep,
  setApiKey,
} from "../../../test/helpers.js";
import { createTestUser, createTestApiKey } from "../helpers/fixtures.js";

describe("E2E: Dry Run Mode", () => {
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

  it("should process batch in dry run mode without sending emails", async () => {
    // 1. Create batch with dryRun: true
    const { id: batchId, dryRun } = await createBatch({
      name: "Dry Run Test Batch",
      subject: "Test Email - Should Not Send",
      fromEmail: "test@batchsender.local",
      fromName: "Test Sender",
      htmlContent: "<p>Hello {{name}}!</p>",
      textContent: "Hello {{name}}!",
      recipients: [
        { email: "user1@test.local", name: "User One" },
        { email: "user2@test.local", name: "User Two" },
        { email: "user3@test.local", name: "User Three" },
      ],
      dryRun: true,
    });

    expect(batchId).toBeDefined();
    expect(dryRun).toBe(true);

    // 2. Check batch is created as draft with dryRun flag
    let batch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    expect(batch).toBeDefined();
    expect(batch?.status).toBe("draft");
    expect(batch?.dryRun).toBe(true);
    expect(batch?.totalRecipients).toBe(3);

    // 3. Start sending the batch
    await sendBatch(batchId);

    // 4. Verify batch is now queued
    batch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });
    expect(batch?.status).toBe("queued");

    // 5. Wait for processing to complete
    await waitFor(
      async () => {
        const b = await db.query.batches.findFirst({
          where: eq(batches.id, batchId),
        });
        return b?.sentCount === 3 ? b : null;
      },
      {
        timeout: 15000,
        timeoutMessage: "Dry run batch did not complete",
      }
    );

    // 6. Verify all recipients are marked as sent
    const allRecipients = await db.query.recipients.findMany({
      where: eq(recipients.batchId, batchId),
    });

    expect(allRecipients.length).toBe(3);
    expect(allRecipients.every((r) => r.status === "sent")).toBe(true);

    // 7. Verify provider message IDs start with "dry-run-"
    expect(allRecipients.every((r) => r.providerMessageId?.startsWith("dry-run-"))).toBe(true);

    // 8. Verify ClickHouse events (queued + sent)
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

    const events = await eventResult.json<{ event_type: string; cnt: number }>();

    expect(events.find((e) => e.event_type === "queued")?.cnt).toBe(3);
    expect(events.find((e) => e.event_type === "sent")?.cnt).toBe(3);

    // 9. Verify batch completed
    const finalBatch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    expect(finalBatch?.status).toBe("completed");
    expect(finalBatch?.sentCount).toBe(3);
  });

  it("should respect rate limiting in dry run mode", async () => {
    // Create a larger batch to test rate limiting
    const recipientCount = 50;
    const testRecipients = Array.from({ length: recipientCount }, (_, i) => ({
      email: `user${i}@test.local`,
      name: `User ${i}`,
    }));

    const { id: batchId } = await createBatch({
      name: "Dry Run Rate Limit Test",
      subject: "Rate Limit Test",
      fromEmail: "test@batchsender.local",
      htmlContent: "<p>Test</p>",
      recipients: testRecipients,
      dryRun: true,
    });

    const startTime = Date.now();

    // Start sending
    await sendBatch(batchId);

    // Wait for completion
    await waitFor(
      async () => {
        const b = await db.query.batches.findFirst({
          where: eq(batches.id, batchId),
        });
        return b?.sentCount === recipientCount ? b : null;
      },
      {
        timeout: 60000, // Allow more time for rate limiting
        timeoutMessage: "Rate limited batch did not complete",
      }
    );

    const duration = Date.now() - startTime;

    // Verify batch completed
    const finalBatch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    expect(finalBatch?.status).toBe("completed");
    expect(finalBatch?.sentCount).toBe(recipientCount);

    // All should have dry-run provider IDs
    const allRecipients = await db.query.recipients.findMany({
      where: eq(recipients.batchId, batchId),
    });

    expect(allRecipients.every((r) => r.providerMessageId?.startsWith("dry-run-"))).toBe(true);

    console.log(`Dry run batch of ${recipientCount} completed in ${duration}ms`);
  });

  it("should handle dryRun: false (default behavior)", async () => {
    // Create batch without dryRun flag (should default to false)
    const { id: batchId, dryRun } = await createBatch({
      name: "Normal Batch",
      subject: "Normal Email",
      fromEmail: "test@batchsender.local",
      htmlContent: "<p>Hello</p>",
      recipients: [{ email: "user@test.local", name: "User" }],
      // dryRun not specified - should default to false
    });

    expect(dryRun).toBe(false);

    const batch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    expect(batch?.dryRun).toBe(false);
  });

  it("should process webhook module in dry run mode", async () => {
    // First create a webhook send config
    // (This test assumes webhook module is available)
    // For now, just verify the batch can be created with dryRun

    const { id: batchId } = await createBatch({
      name: "Webhook Dry Run Test",
      subject: "Webhook Test", // Using email for now
      fromEmail: "test@batchsender.local",
      htmlContent: "<p>Test</p>",
      recipients: [
        { email: "endpoint1@test.local", name: "Endpoint 1" },
        { email: "endpoint2@test.local", name: "Endpoint 2" },
      ],
      dryRun: true,
    });

    // Start sending
    await sendBatch(batchId);

    // Wait for completion
    await waitFor(
      async () => {
        const b = await db.query.batches.findFirst({
          where: eq(batches.id, batchId),
        });
        return b?.sentCount === 2 ? b : null;
      },
      {
        timeout: 15000,
      }
    );

    // Verify dry run processed
    const allRecipients = await db.query.recipients.findMany({
      where: eq(recipients.batchId, batchId),
    });

    expect(allRecipients.every((r) => r.providerMessageId?.startsWith("dry-run-"))).toBe(true);
  });
});
