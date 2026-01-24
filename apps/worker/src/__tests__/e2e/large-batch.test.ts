/**
 * E2E Test: Large Batch Processing
 *
 * Tests system performance and scalability:
 * - Process batches with 1k-10k emails
 * - Measure throughput and latency
 * - Verify autoscaling readiness (queue metrics)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../../test/db.js";
import { batches, recipients } from "@batchsender/db";
import { eq, sql } from "drizzle-orm";
import {
  createBatch,
  getBatchStatus,
  waitFor,
  generateRecipients,
  measureThroughput,
  getQueueStats,
  setApiKey,
} from "../../../test/helpers.js";
import { createTestUser, createTestApiKey } from "../helpers/fixtures.js";

describe("E2E: Large Batch Processing", () => {
  let testUserId: string;

  beforeEach(async () => {
    const testUser = createTestUser();
    await db.insert(require("@batchsender/db").users).values(testUser);
    testUserId = testUser.id;

    // Create and insert API key
    const { apiKey, dbRecord } = createTestApiKey(testUserId);
    await db.insert(require("@batchsender/db").apiKeys).values(dbRecord);
    setApiKey(apiKey);
  });

  it("should process 1000 emails efficiently", async () => {
    const BATCH_SIZE = 1000;

    const { id: batchId } = await createBatch({
      name: "Large Batch 1k",
      subject: "Test Email",
      fromEmail: "test@batchsender.local",
      htmlContent: "<p>Hello {{name}}!</p>",
      textContent: "Hello {{name}}!",
      recipients: generateRecipients(BATCH_SIZE),
      autoSend: true,
      dryRun: true,
    });

    console.log(`Created batch ${batchId} with ${BATCH_SIZE} recipients`);

    // Measure throughput
    const metrics = await measureThroughput(batchId, BATCH_SIZE);

    console.log(`
      ✓ Processed ${BATCH_SIZE} emails
      - Total time: ${metrics.totalTimeMs}ms (${(metrics.totalTimeMs / 1000).toFixed(2)}s)
      - Throughput: ${metrics.emailsPerSecond.toFixed(2)} emails/sec
      - Avg latency: ${metrics.avgLatencyMs.toFixed(2)}ms per email
    `);

    // Verify final state
    const finalBatch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    expect(finalBatch?.status).toBe("completed");
    expect(finalBatch?.sentCount).toBe(BATCH_SIZE);
    expect(finalBatch?.failedCount).toBe(0);

    // Verify throughput is acceptable (at least 10 emails/sec)
    expect(metrics.emailsPerSecond).toBeGreaterThan(10);
  });

  it("should process 10k emails with progress tracking", async () => {
    const BATCH_SIZE = 10000;

    const { id: batchId } = await createBatch({
      name: "Large Batch 10k",
      subject: "Load Test",
      fromEmail: "test@batchsender.local",
      htmlContent: "<p>Test</p>",
      recipients: generateRecipients(BATCH_SIZE),
      autoSend: true,
      dryRun: true,
    });

    console.log(`Created batch ${batchId} with ${BATCH_SIZE} recipients`);

    const start = Date.now();
    let progressUpdates = 0;

    // Wait for completion with progress tracking
    await waitFor(
      async () => {
        const batch = await getBatchStatus(batchId);

        // Log progress every 1000 emails
        if (batch.sentCount > 0 && batch.sentCount % 1000 === 0) {
          const elapsed = (Date.now() - start) / 1000;
          const rate = batch.sentCount / elapsed;
          console.log(
            `  Progress: ${batch.sentCount}/${BATCH_SIZE} (${rate.toFixed(2)}/sec)`
          );
          progressUpdates++;
        }

        return batch.status === "completed" ? batch : null;
      },
      {
        timeout: 600000, // 10 minutes
        interval: 1000, // Check every second
      }
    );

    const totalTime = Date.now() - start;
    const throughput = (BATCH_SIZE / totalTime) * 1000;

    console.log(`
      ✓ Processed ${BATCH_SIZE} emails
      - Total time: ${(totalTime / 1000).toFixed(2)}s
      - Throughput: ${throughput.toFixed(2)} emails/sec
      - Progress updates: ${progressUpdates}
    `);

    // Verify all sent
    const count = await db
      .select({ count: sql<number>`count(*)` })
      .from(recipients)
      .where(eq(recipients.batchId, batchId));

    expect(Number(count[0]?.count)).toBe(BATCH_SIZE);

    const finalBatch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    expect(finalBatch?.sentCount).toBe(BATCH_SIZE);
    expect(finalBatch?.status).toBe("completed");

    // Verify reasonable throughput (at least 10 emails/sec)
    expect(throughput).toBeGreaterThan(10);
  });

  it("should expose queue metrics for autoscaling", async () => {
    const BATCH_SIZE = 5000;

    // Create batch
    const { id: batchId } = await createBatch({
      name: "Autoscaling Test",
      subject: "Test",
      fromEmail: "test@batchsender.local",
      recipients: generateRecipients(BATCH_SIZE),
      autoSend: true,
      dryRun: true,
    });

    // Wait a moment for batch to be queued
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check queue stats while processing
    const stats = await getQueueStats();

    console.log(`Queue Stats:`, JSON.stringify(stats, null, 2));

    // Verify stats are available for autoscaling decisions
    expect(stats).toBeDefined();
    expect(stats.batches).toBeDefined();
    expect(stats.emails).toBeDefined();

    // Wait for completion
    await waitFor(
      async () => {
        const batch = await getBatchStatus(batchId);
        return batch.status === "completed" ? batch : null;
      },
      { timeout: 300000 }
    );
  });

  it("should handle chunked recipient creation", async () => {
    const BATCH_SIZE = 5000;
    const CHUNK_SIZE = 1000;

    // Create batch metadata first (with dryRun since we're bypassing API)
    const batchData = {
      id: require("crypto").randomUUID(),
      userId: testUserId,
      name: "Chunked Insert Test",
      subject: "Test",
      fromEmail: "test@batchsender.local",
      fromName: "Test",
      htmlContent: "<p>Test</p>",
      textContent: "Test",
      status: "draft" as const,
      totalRecipients: BATCH_SIZE,
      sentCount: 0,
      deliveredCount: 0,
      bouncedCount: 0,
      failedCount: 0,
      dryRun: true, // Required when bypassing API
    };

    await db.insert(batches).values(batchData);

    // Insert recipients in chunks
    const start = Date.now();

    for (let i = 0; i < BATCH_SIZE; i += CHUNK_SIZE) {
      const chunkSize = Math.min(CHUNK_SIZE, BATCH_SIZE - i);
      const recipientData = Array.from({ length: chunkSize }, (_, j) => ({
        id: require("crypto").randomUUID(),
        batchId: batchData.id,
        email: `user${i + j}@test.local`,
        name: `User ${i + j}`,
        variables: {},
        status: "pending" as const,
      }));

      await db.insert(recipients).values(recipientData);
    }

    const insertTime = Date.now() - start;
    console.log(`Inserted ${BATCH_SIZE} recipients in ${insertTime}ms`);

    // Use API to send batch (this properly enqueues it in NATS)
    const { sendBatch } = await import("../../../test/helpers.js");
    await sendBatch(batchData.id);

    // Wait for processing
    await waitFor(
      async () => {
        const batch = await db.query.batches.findFirst({
          where: eq(batches.id, batchData.id),
        });
        return batch?.status === "completed" ? batch : null;
      },
      { timeout: 300000 }
    );

    const finalBatch = await db.query.batches.findFirst({
      where: eq(batches.id, batchData.id),
    });

    expect(finalBatch?.sentCount).toBe(BATCH_SIZE);
  });
});
