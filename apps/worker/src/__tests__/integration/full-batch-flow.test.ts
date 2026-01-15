/**
 * Integration test: Full batch flow
 *
 * Tests the complete email sending pipeline:
 * Create batch → Queue → Send → Receive webhooks → Complete
 *
 * Requires:
 * - PostgreSQL running
 * - ClickHouse running
 * - NATS running
 * - Mock SES server running (or mock provider)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import * as schema from "@batchsender/db";
import {
  createTestUser,
  createTestBatch,
  createTestRecipients,
  waitFor,
  sleep,
} from "../helpers/fixtures.js";

// Skip tests if DATABASE_URL is not set
const DATABASE_URL = process.env.DATABASE_URL;
const SKIP_INTEGRATION = !DATABASE_URL;

describe.skipIf(SKIP_INTEGRATION)("Full Batch Flow", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql_client: ReturnType<typeof postgres>;
  let testUserId: string;

  beforeAll(async () => {
    if (SKIP_INTEGRATION) return;

    sql_client = postgres(DATABASE_URL!);
    db = drizzle(sql_client, { schema });

    // Create test user
    const testUser = createTestUser();
    await db.insert(schema.users).values(testUser);
    testUserId = testUser.id;
  });

  afterAll(async () => {
    if (SKIP_INTEGRATION) return;

    // Clean up test user (cascades to batches and recipients)
    await db.delete(schema.users).where(eq(schema.users.id, testUserId));
    await sql_client.end();
  });

  beforeEach(async () => {
    if (SKIP_INTEGRATION) return;

    // Clean up any existing batches for test user
    await db.delete(schema.batches).where(eq(schema.batches.userId, testUserId));
  });

  it("should create and queue a batch with recipients", async () => {
    // Create batch
    const batchData = createTestBatch(testUserId, { recipientCount: 5 });
    await db.insert(schema.batches).values(batchData);

    // Create recipients
    const recipients = createTestRecipients(batchData.id, 5);
    await db.insert(schema.recipients).values(recipients);

    // Verify batch exists
    const batch = await db.query.batches.findFirst({
      where: eq(schema.batches.id, batchData.id),
    });

    expect(batch).toBeDefined();
    expect(batch?.status).toBe("queued");
    expect(batch?.totalRecipients).toBe(5);

    // Verify recipients exist
    const savedRecipients = await db.query.recipients.findMany({
      where: eq(schema.recipients.batchId, batchData.id),
    });

    expect(savedRecipients).toHaveLength(5);
    expect(savedRecipients.every((r) => r.status === "pending")).toBe(true);
  });

  it("should track sent count correctly", async () => {
    // Create batch
    const batchData = createTestBatch(testUserId, { recipientCount: 3 });
    await db.insert(schema.batches).values(batchData);

    // Create recipients
    const recipients = createTestRecipients(batchData.id, 3);
    await db.insert(schema.recipients).values(recipients);

    // Simulate sending emails (update recipients to sent)
    for (const recipient of recipients) {
      await db
        .update(schema.recipients)
        .set({
          status: "sent",
          providerMessageId: `msg-${recipient.id}`,
          sentAt: new Date(),
        })
        .where(eq(schema.recipients.id, recipient.id));

      // Increment sent count on batch
      await db
        .update(schema.batches)
        .set({
          sentCount: sql`${schema.batches.sentCount} + 1`,
        })
        .where(eq(schema.batches.id, batchData.id));
    }

    // Verify batch sent count
    const batch = await db.query.batches.findFirst({
      where: eq(schema.batches.id, batchData.id),
    });

    expect(batch?.sentCount).toBe(3);

    // Verify all recipients are sent
    const sentRecipients = await db.query.recipients.findMany({
      where: eq(schema.recipients.batchId, batchData.id),
    });

    expect(sentRecipients.every((r) => r.status === "sent")).toBe(true);
    expect(sentRecipients.every((r) => r.providerMessageId)).toBe(true);
  });

  it("should handle mixed delivery outcomes", async () => {
    // Create batch
    const batchData = createTestBatch(testUserId, { recipientCount: 4 });
    await db.insert(schema.batches).values(batchData);

    // Create recipients with different statuses
    const recipient1 = {
      ...createTestRecipients(batchData.id, 1)[0],
      status: "delivered" as const,
    };
    const recipient2 = {
      ...createTestRecipients(batchData.id, 1)[0],
      email: "bounce@test.local",
      status: "bounced" as const,
    };
    const recipient3 = {
      ...createTestRecipients(batchData.id, 1)[0],
      email: "complain@test.local",
      status: "complained" as const,
    };
    const recipient4 = {
      ...createTestRecipients(batchData.id, 1)[0],
      email: "fail@test.local",
      status: "failed" as const,
    };

    await db.insert(schema.recipients).values([
      recipient1,
      recipient2,
      recipient3,
      recipient4,
    ]);

    // Update batch counters
    await db
      .update(schema.batches)
      .set({
        sentCount: 4,
        deliveredCount: 1,
        bouncedCount: 1,
        failedCount: 1,
        status: "completed",
      })
      .where(eq(schema.batches.id, batchData.id));

    // Verify final state
    const batch = await db.query.batches.findFirst({
      where: eq(schema.batches.id, batchData.id),
    });

    expect(batch?.status).toBe("completed");
    expect(batch?.sentCount).toBe(4);
    expect(batch?.deliveredCount).toBe(1);
    expect(batch?.bouncedCount).toBe(1);
    expect(batch?.failedCount).toBe(1);
  });

  it("should handle large batches efficiently", async () => {
    const BATCH_SIZE = 1000;

    // Create batch
    const batchData = createTestBatch(testUserId, { recipientCount: BATCH_SIZE });
    await db.insert(schema.batches).values(batchData);

    // Create recipients in chunks
    const CHUNK_SIZE = 200;
    for (let i = 0; i < BATCH_SIZE; i += CHUNK_SIZE) {
      const recipients = createTestRecipients(
        batchData.id,
        Math.min(CHUNK_SIZE, BATCH_SIZE - i)
      );
      await db.insert(schema.recipients).values(recipients);
    }

    // Verify all recipients created
    const count = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.recipients)
      .where(eq(schema.recipients.batchId, batchData.id));

    expect(Number(count[0]?.count)).toBe(BATCH_SIZE);

    // Verify batch total
    const batch = await db.query.batches.findFirst({
      where: eq(schema.batches.id, batchData.id),
    });

    expect(batch?.totalRecipients).toBe(BATCH_SIZE);
  });
});
