/**
 * Integration test: Webhook deduplication
 *
 * Tests that duplicate webhooks are handled correctly:
 * - Same webhook received multiple times should result in one event
 * - Different event types for same recipient are tracked separately
 *
 * Requires:
 * - PostgreSQL running
 * - ClickHouse running
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@batchsender/db";
import {
  createTestUser,
  createTestBatch,
  createTestRecipients,
  sleep,
} from "../helpers/fixtures.js";
import { clickhouse, logEmailEvent, indexProviderMessage } from "../../clickhouse.js";

// Skip tests if required services are not available
const DATABASE_URL = process.env.DATABASE_URL;
const SKIP_INTEGRATION = !DATABASE_URL;

describe.skipIf(SKIP_INTEGRATION)("Webhook Deduplication", () => {
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

    // Clean up test user
    await db.delete(schema.users).where(eq(schema.users.id, testUserId));
    await sql_client.end();
  });

  beforeEach(async () => {
    if (SKIP_INTEGRATION) return;

    // Clean up test batches
    await db.delete(schema.batches).where(eq(schema.batches.userId, testUserId));
  });

  it("should store message index for webhook lookup", async () => {
    // Create batch and recipient
    const batchData = createTestBatch(testUserId);
    await db.insert(schema.batches).values(batchData);

    const [recipient] = createTestRecipients(batchData.id, 1, {
      status: "sent",
      providerMessageId: "test-message-123",
    });
    await db.insert(schema.recipients).values(recipient);

    // Index the message (simulates what happens when email is sent)
    await indexProviderMessage({
      provider_message_id: "test-message-123",
      recipient_id: recipient.id,
      batch_id: batchData.id,
      user_id: testUserId
    });

    // Query the index
    const result = await clickhouse.query({
      query: `
        SELECT batch_id, recipient_id, user_id
        FROM email_message_index
        WHERE provider_message_id = 'test-message-123'
        LIMIT 1
      `,
      format: "JSONEachRow",
    });

    const rows = await result.json<{
      batch_id: string;
      recipient_id: string;
      user_id: string;
    }>();

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.batch_id).toBe(batchData.id);
    expect(row.recipient_id).toBe(recipient.id);
    expect(row.user_id).toBe(testUserId);
  });

  it("should log different event types separately", async () => {
    // Create batch and recipient
    const batchData = createTestBatch(testUserId);
    await db.insert(schema.batches).values(batchData);

    const [recipient] = createTestRecipients(batchData.id, 1);
    await db.insert(schema.recipients).values(recipient);

    // Log multiple event types for same recipient
    await logEmailEvent({
      event_type: "queued",
      batch_id: batchData.id,
      recipient_id: recipient.id,
      user_id: testUserId,
      email: recipient.email,
    });

    await logEmailEvent({
      event_type: "sent",
      batch_id: batchData.id,
      recipient_id: recipient.id,
      user_id: testUserId,
      email: recipient.email,
      provider_message_id: "msg-123",
    });

    await logEmailEvent({
      event_type: "delivered",
      batch_id: batchData.id,
      recipient_id: recipient.id,
      user_id: testUserId,
      email: recipient.email,
      provider_message_id: "msg-123",
    });

    // Wait for ClickHouse to process
    await sleep(500);

    // Query events for this recipient
    const result = await clickhouse.query({
      query: `
        SELECT event_type, count() as cnt
        FROM email_events
        WHERE batch_id = {batchId:UUID}
          AND recipient_id = {recipientId:UUID}
        GROUP BY event_type
        ORDER BY event_type
      `,
      query_params: {
        batchId: batchData.id,
        recipientId: recipient.id,
      },
      format: "JSONEachRow",
    });

    const rows = await result.json<{ event_type: string; cnt: string }>();

    // Should have 3 different event types
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.event_type === "queued")).toBeDefined();
    expect(rows.find((r) => r.event_type === "sent")).toBeDefined();
    expect(rows.find((r) => r.event_type === "delivered")).toBeDefined();
  });

  it("should deduplicate same event type via ReplacingMergeTree", async () => {
    // Create batch and recipient
    const batchData = createTestBatch(testUserId);
    await db.insert(schema.batches).values(batchData);

    const [recipient] = createTestRecipients(batchData.id, 1);
    await db.insert(schema.recipients).values(recipient);

    // Log same event type multiple times (simulating duplicate webhooks)
    for (let i = 0; i < 3; i++) {
      await logEmailEvent({
        event_type: "delivered",
        batch_id: batchData.id,
        recipient_id: recipient.id,
        user_id: testUserId,
        email: recipient.email,
        provider_message_id: "msg-123",
      });
      await sleep(100); // Small delay between inserts
    }

    // Wait for ClickHouse to process
    await sleep(1000);

    // Force merge to trigger deduplication
    try {
      await clickhouse.command({
        query: `OPTIMIZE TABLE email_events FINAL`,
      });
    } catch {
      // OPTIMIZE might not be needed in all cases
    }

    await sleep(500);

    // Query with FINAL to get deduplicated results
    const result = await clickhouse.query({
      query: `
        SELECT count() as cnt
        FROM email_events FINAL
        WHERE batch_id = {batchId:UUID}
          AND recipient_id = {recipientId:UUID}
          AND event_type = 'delivered'
      `,
      query_params: {
        batchId: batchData.id,
        recipientId: recipient.id,
      },
      format: "JSONEachRow",
    });

    const rows = await result.json<{ cnt: string }>();

    // Should have only 1 event after deduplication
    // Note: ReplacingMergeTree keeps the row with the latest version (created_at)
    expect(parseInt(rows[0]?.cnt || "0")).toBe(1);
  });

  it("should track events for multiple recipients in batch", async () => {
    // Create batch with multiple recipients
    const batchData = createTestBatch(testUserId, { recipientCount: 5 });
    await db.insert(schema.batches).values(batchData);

    const recipients = createTestRecipients(batchData.id, 5);
    await db.insert(schema.recipients).values(recipients);

    // Log sent events for all recipients
    for (const recipient of recipients) {
      await logEmailEvent({
        event_type: "sent",
        batch_id: batchData.id,
        recipient_id: recipient.id,
        user_id: testUserId,
        email: recipient.email,
        provider_message_id: `msg-${recipient.id}`,
      });
    }

    // Log mixed delivery outcomes
    await logEmailEvent({
      event_type: "delivered",
      batch_id: batchData.id,
      recipient_id: recipients[0].id,
      user_id: testUserId,
      email: recipients[0].email,
    });

    await logEmailEvent({
      event_type: "delivered",
      batch_id: batchData.id,
      recipient_id: recipients[1].id,
      user_id: testUserId,
      email: recipients[1].email,
    });

    await logEmailEvent({
      event_type: "bounced",
      batch_id: batchData.id,
      recipient_id: recipients[2].id,
      user_id: testUserId,
      email: recipients[2].email,
    });

    // Wait for ClickHouse
    await sleep(500);

    // Query batch stats
    const result = await clickhouse.query({
      query: `
        SELECT
          countIf(event_type = 'sent') AS sent,
          countIf(event_type = 'delivered') AS delivered,
          countIf(event_type = 'bounced') AS bounced
        FROM email_events FINAL
        WHERE batch_id = {batchId:UUID}
      `,
      query_params: { batchId: batchData.id },
      format: "JSONEachRow",
    });

    const rows = await result.json<{
      sent: string;
      delivered: string;
      bounced: string;
    }>();

    const stats = rows[0];
    expect(parseInt(stats?.sent || "0")).toBe(5);
    expect(parseInt(stats?.delivered || "0")).toBe(2);
    expect(parseInt(stats?.bounced || "0")).toBe(1);
  });
});
