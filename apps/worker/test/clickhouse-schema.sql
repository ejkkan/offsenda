-- Email events table for analytics
-- Uses ReplacingMergeTree to auto-deduplicate duplicate webhooks
CREATE TABLE IF NOT EXISTS email_events (
  event_type String,
  batch_id UUID,
  recipient_id UUID,
  user_id UUID,
  email String,
  provider_message_id String,
  metadata String,
  error_message String,
  event_date Date DEFAULT toDate(now()),
  event_time DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(event_time)
PARTITION BY toYYYYMM(event_date)
ORDER BY (batch_id, recipient_id, event_type);

-- Message index table for fast webhook lookups
CREATE TABLE IF NOT EXISTS email_message_index (
  provider_message_id String,
  recipient_id UUID,
  batch_id UUID,
  user_id UUID,
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY provider_message_id;
