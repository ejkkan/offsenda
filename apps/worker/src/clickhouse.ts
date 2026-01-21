import { createClient } from "@clickhouse/client";
import { config } from "./config.js";
import { log } from "./logger.js";
import { clickhouseWriteFailuresTotal } from "./metrics.js";

// Import from shared types - single source of truth
import type { EventType, EmailEventType, EmailEvent, ModuleType } from "./types/events.js";

// Re-export for backwards compatibility
export type { EventType, EmailEventType, EmailEvent, ModuleType };

export const clickhouse = createClient({
  url: config.CLICKHOUSE_URL,
  username: config.CLICKHOUSE_USER,
  password: config.CLICKHOUSE_PASSWORD,
  database: config.CLICKHOUSE_DATABASE,
});

export async function logEmailEvent(event: EmailEvent): Promise<void> {
  try {
    await clickhouse.insert({
      table: "email_events",
      values: [
        {
          event_type: event.event_type,
          module_type: event.module_type || "email",
          batch_id: event.batch_id,
          recipient_id: event.recipient_id,
          user_id: event.user_id,
          email: event.email,
          provider_message_id: event.provider_message_id || "",
          metadata: JSON.stringify(event.metadata || {}),
          error_message: event.error_message || "",
        },
      ],
      format: "JSONEachRow",
    });
  } catch (error) {
    log.system.error(
      { error: (error as Error).message, eventType: event.event_type, batchId: event.batch_id },
      "ClickHouse event logging failed"
    );
    clickhouseWriteFailuresTotal.inc({ operation: "insert" });
    throw error;
  }
}

// Bulk insert for high throughput
export async function logEmailEvents(events: EmailEvent[]): Promise<void> {
  if (events.length === 0) return;

  try {
    const values = events.map((event) => ({
      event_type: event.event_type,
      module_type: event.module_type || "email",
      batch_id: event.batch_id,
      recipient_id: event.recipient_id,
      user_id: event.user_id,
      email: event.email,
      provider_message_id: event.provider_message_id || "",
      metadata: JSON.stringify(event.metadata || {}),
      error_message: event.error_message || "",
    }));

    await clickhouse.insert({
      table: "email_events",
      values,
      format: "JSONEachRow",
    });
  } catch (error) {
    log.system.error(
      { error: (error as Error).message, eventCount: events.length },
      "ClickHouse bulk event logging failed"
    );
    clickhouseWriteFailuresTotal.inc({ operation: "insert" });
    throw error;
  }
}

export async function indexProviderMessage(params: {
  provider_message_id: string;
  recipient_id: string;
  batch_id: string;
  user_id: string;
}): Promise<void> {
  try {
    await clickhouse.insert({
      table: "email_message_index",
      values: [
        {
          provider_message_id: params.provider_message_id,
          recipient_id: params.recipient_id,
          batch_id: params.batch_id,
          user_id: params.user_id,
        },
      ],
      format: "JSONEachRow",
    });
  } catch (error) {
    log.system.error(
      { error: (error as Error).message, providerMessageId: params.provider_message_id },
      "ClickHouse message index insert failed"
    );
    clickhouseWriteFailuresTotal.inc({ operation: "insert" });
    throw error;
  }
}

// Lookup IDs by provider message ID (for webhook processing)
export async function lookupByProviderMessageId(
  messageId: string
): Promise<{ batch_id: string; recipient_id: string; user_id: string } | null> {
  try {
    const result = await clickhouse.query({
      query: `
        SELECT batch_id, recipient_id, user_id
        FROM email_message_index
        WHERE provider_message_id = {messageId:String}
        LIMIT 1
      `,
      query_params: { messageId },
      format: "JSONEachRow",
    });

    const rows = await result.json<{
      batch_id: string;
      recipient_id: string;
      user_id: string;
    }>();

    return rows[0] || null;
  } catch (error) {
    log.system.error(
      { error: (error as Error).message, messageId },
      "ClickHouse message lookup failed"
    );
    clickhouseWriteFailuresTotal.inc({ operation: "query" });
    return null;
  }
}

export async function getBatchStats(batchId: string): Promise<{
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  failed: number;
}> {
  const result = await clickhouse.query({
    query: `
      SELECT
        countIf(event_type = 'sent') AS sent,
        countIf(event_type = 'delivered') AS delivered,
        countIf(event_type = 'opened') AS opened,
        countIf(event_type = 'clicked') AS clicked,
        countIf(event_type = 'bounced') AS bounced,
        countIf(event_type = 'complained') AS complained,
        countIf(event_type = 'failed') AS failed
      FROM email_events
      WHERE batch_id = {batchId:UUID}
    `,
    query_params: { batchId },
    format: "JSONEachRow",
  });

  const rows = await result.json<{
    sent: string;
    delivered: string;
    opened: string;
    clicked: string;
    bounced: string;
    complained: string;
    failed: string;
  }>();

  const row = rows[0] || {};

  return {
    sent: parseInt(row.sent || "0"),
    delivered: parseInt(row.delivered || "0"),
    opened: parseInt(row.opened || "0"),
    clicked: parseInt(row.clicked || "0"),
    bounced: parseInt(row.bounced || "0"),
    complained: parseInt(row.complained || "0"),
    failed: parseInt(row.failed || "0"),
  };
}

export async function getUserDailyStats(userId: string, days: number = 30): Promise<
  Array<{
    date: string;
    sent: number;
    delivered: number;
    bounced: number;
  }>
> {
  const result = await clickhouse.query({
    query: `
      SELECT
        event_date AS date,
        countIf(event_type = 'sent') AS sent,
        countIf(event_type = 'delivered') AS delivered,
        countIf(event_type = 'bounced') AS bounced
      FROM email_events
      WHERE user_id = {userId:UUID}
        AND event_date >= today() - {days:UInt32}
      GROUP BY event_date
      ORDER BY event_date
    `,
    query_params: { userId, days },
    format: "JSONEachRow",
  });

  return await result.json();
}
