/**
 * E2E Test: Concurrent Batch Processing
 *
 * Tests system behavior under concurrent load:
 * - Multiple batches processing simultaneously
 * - Multiple users with separate queues
 * - No cross-contamination between batches
 */

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../../test/db.js";
import { batches } from "@batchsender/db";
import { inArray, eq } from "drizzle-orm";
import {
  createBatch,
  waitFor,
  generateRecipients,
  getBatchStatus,
  setApiKey,
} from "../../../test/helpers.js";
import { createTestUser, createTestApiKey } from "../helpers/fixtures.js";

describe("E2E: Concurrent Batch Processing", () => {
  let testUserId1: string;
  let testUserId2: string;
  let apiKey1: string;
  let apiKey2: string;

  beforeEach(async () => {
    // Add small delay to prevent same timestamp emails
    const user1 = createTestUser();
    await new Promise(resolve => setTimeout(resolve, 10));
    const user2 = createTestUser();

    await db.insert(require("@batchsender/db").users).values([user1, user2]);

    testUserId1 = user1.id;
    testUserId2 = user2.id;

    // Create and insert API keys for both users
    const key1 = createTestApiKey(testUserId1);
    const key2 = createTestApiKey(testUserId2);
    apiKey1 = key1.apiKey;
    apiKey2 = key2.apiKey;
    await db.insert(require("@batchsender/db").apiKeys).values([key1.dbRecord, key2.dbRecord]);

    // Set API key for user1 as default (tests can switch if needed)
    setApiKey(apiKey1);
  });

  it("should process multiple small batches concurrently", async () => {
    const NUM_BATCHES = 5;
    const EMAILS_PER_BATCH = 100;

    console.log(
      `Creating ${NUM_BATCHES} batches with ${EMAILS_PER_BATCH} emails each`
    );

    // Create all batches simultaneously
    const batchIds = await Promise.all(
      Array.from({ length: NUM_BATCHES }, async (_, i) => {
        const { id } = await createBatch({
          name: `Concurrent Batch ${i}`,
          subject: `Test ${i}`,
          fromEmail: "test@batchsender.local",
          recipients: generateRecipients(EMAILS_PER_BATCH),
          autoSend: true,
          dryRun: true,
        });
        return id;
      })
    );

    console.log(`Created ${batchIds.length} batches`);

    const start = Date.now();

    // Wait for all batches to complete
    await waitFor(
      async () => {
        const allBatches = await db.query.batches.findMany({
          where: inArray(batches.id, batchIds),
        });

        const completed = allBatches.filter((b) => b.status === "completed");

        console.log(`  ${completed.length}/${NUM_BATCHES} batches completed`);

        return completed.length === NUM_BATCHES ? allBatches : null;
      },
      {
        timeout: 120000, // 2 minutes
        interval: 2000,
      }
    );

    const totalTime = Date.now() - start;
    const totalEmails = NUM_BATCHES * EMAILS_PER_BATCH;
    const throughput = (totalEmails / totalTime) * 1000;

    console.log(`
      ✓ Processed ${NUM_BATCHES} concurrent batches
      - Total emails: ${totalEmails}
      - Total time: ${(totalTime / 1000).toFixed(2)}s
      - Throughput: ${throughput.toFixed(2)} emails/sec
    `);

    // Verify all batches completed successfully
    const finalBatches = await db.query.batches.findMany({
      where: inArray(batches.id, batchIds),
    });

    expect(finalBatches.length).toBe(NUM_BATCHES);
    expect(finalBatches.every((b) => b.status === "completed")).toBe(true);
    expect(finalBatches.every((b) => b.sentCount === EMAILS_PER_BATCH)).toBe(
      true
    );
  });

  it("should handle batches from multiple users with separate queues", async () => {
    const EMAILS_PER_BATCH = 500;

    console.log("Creating batches for 2 different users");

    // Create batches for user1
    setApiKey(apiKey1);
    const batch1 = await createBatch({
      name: "User 1 Batch A",
      subject: "Test",
      fromEmail: "user1@batchsender.local",
      recipients: generateRecipients(EMAILS_PER_BATCH),
      autoSend: true,
      dryRun: true,
    });
    const batch2 = await createBatch({
      name: "User 1 Batch B",
      subject: "Test",
      fromEmail: "user1@batchsender.local",
      recipients: generateRecipients(EMAILS_PER_BATCH),
      autoSend: true,
      dryRun: true,
    });

    // Switch to user2 and create their batches
    setApiKey(apiKey2);
    const batch3 = await createBatch({
      name: "User 2 Batch A",
      subject: "Test",
      fromEmail: "user2@batchsender.local",
      recipients: generateRecipients(EMAILS_PER_BATCH),
      autoSend: true,
      dryRun: true,
    });
    const batch4 = await createBatch({
      name: "User 2 Batch B",
      subject: "Test",
      fromEmail: "user2@batchsender.local",
      recipients: generateRecipients(EMAILS_PER_BATCH),
      autoSend: true,
      dryRun: true,
    });

    const batchIds = [batch1.id, batch2.id, batch3.id, batch4.id];

    // Wait for all to complete
    await waitFor(
      async () => {
        const allBatches = await db.query.batches.findMany({
          where: inArray(batches.id, batchIds),
        });

        const completed = allBatches.filter((b) => b.status === "completed");

        return completed.length === 4 ? allBatches : null;
      },
      {
        timeout: 180000, // 3 minutes
        interval: 3000,
      }
    );

    // Verify all completed
    const finalBatches = await db.query.batches.findMany({
      where: inArray(batches.id, batchIds),
    });

    expect(finalBatches.length).toBe(4);
    expect(finalBatches.every((b) => b.status === "completed")).toBe(true);
    expect(finalBatches.every((b) => b.sentCount === EMAILS_PER_BATCH)).toBe(
      true
    );

    // Verify no cross-contamination (user1's batches only have user1's emails)
    const user1Batches = finalBatches.filter((b) => b.userId === testUserId1);
    const user2Batches = finalBatches.filter((b) => b.userId === testUserId2);

    expect(user1Batches.length).toBe(2);
    expect(user2Batches.length).toBe(2);
  });

  it("should maintain throughput under concurrent load", async () => {
    const NUM_BATCHES = 10;
    const EMAILS_PER_BATCH = 500;

    console.log(
      `Load test: ${NUM_BATCHES} batches × ${EMAILS_PER_BATCH} emails = ${NUM_BATCHES * EMAILS_PER_BATCH} total`
    );

    const start = Date.now();

    // Create all batches
    const batchIds = await Promise.all(
      Array.from({ length: NUM_BATCHES}, async (_, i) => {
        const { id } = await createBatch({
          name: `Load Test ${i}`,
          subject: "Test",
          fromEmail: "test@batchsender.local",
          recipients: generateRecipients(EMAILS_PER_BATCH),
          autoSend: true,
          dryRun: true,
        });
        return id;
      })
    );

    // Monitor progress
    let lastUpdate = Date.now();
    let lastTotalSent = 0;

    await waitFor(
      async () => {
        const allBatches = await db.query.batches.findMany({
          where: inArray(batches.id, batchIds),
        });

        const completed = allBatches.filter((b) => b.status === "completed");
        const totalSent = allBatches.reduce((sum, b) => sum + b.sentCount, 0);

        const now = Date.now();
        if (now - lastUpdate > 5000) {
          const elapsed = (now - lastUpdate) / 1000;
          const sentSinceLast = totalSent - lastTotalSent;
          const currentRate = sentSinceLast / elapsed;

          console.log(
            `  Progress: ${totalSent}/${NUM_BATCHES * EMAILS_PER_BATCH} (${currentRate.toFixed(2)}/sec) - ${completed.length}/${NUM_BATCHES} batches done`
          );

          lastUpdate = now;
          lastTotalSent = totalSent;
        }

        return completed.length === NUM_BATCHES ? allBatches : null;
      },
      {
        timeout: 300000, // 5 minutes
        interval: 1000,
      }
    );

    const totalTime = Date.now() - start;
    const totalEmails = NUM_BATCHES * EMAILS_PER_BATCH;
    const avgThroughput = (totalEmails / totalTime) * 1000;

    console.log(`
      ✓ Concurrent load test completed
      - Total batches: ${NUM_BATCHES}
      - Total emails: ${totalEmails}
      - Total time: ${(totalTime / 1000).toFixed(2)}s
      - Avg throughput: ${avgThroughput.toFixed(2)} emails/sec
    `);

    // Verify acceptable throughput (at least 10 emails/sec even under load)
    expect(avgThroughput).toBeGreaterThan(10);

    // Verify all completed
    const finalBatches = await db.query.batches.findMany({
      where: inArray(batches.id, batchIds),
    });

    expect(finalBatches.every((b) => b.status === "completed")).toBe(true);
    expect(finalBatches.every((b) => b.sentCount === EMAILS_PER_BATCH)).toBe(
      true
    );
  });
});
