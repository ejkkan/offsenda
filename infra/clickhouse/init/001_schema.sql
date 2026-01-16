-- Events table for analytics (email, webhook, etc.)
-- Uses ReplacingMergeTree to auto-deduplicate duplicate webhooks from SNS
-- Deduplication: (batch_id, recipient_id, event_type) - one event type per recipient per batch
CREATE TABLE IF NOT EXISTS email_events
(
    event_id UUID DEFAULT generateUUIDv4(),
    event_type Enum8(
        'queued' = 1,
        'sent' = 2,
        'delivered' = 3,
        'opened' = 4,
        'clicked' = 5,
        'bounced' = 6,
        'soft_bounced' = 9,
        'complained' = 7,
        'failed' = 8
    ),
    module_type Enum8(
        'email' = 1,
        'webhook' = 2
    ) DEFAULT 'email',
    batch_id UUID,
    recipient_id UUID,
    user_id UUID,
    email String,
    provider_message_id String,
    metadata String DEFAULT '{}',  -- JSON string for extra data
    error_message String DEFAULT '',
    created_at DateTime64(3) DEFAULT now64(3),

    -- For efficient time-based queries
    event_date Date DEFAULT toDate(created_at),

    -- Index for user queries (dashboard, analytics)
    INDEX idx_user_id user_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_module_type module_type TYPE set(2) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(event_date)
ORDER BY (batch_id, recipient_id, event_type)  -- Fast batch queries + deduplication
TTL event_date + INTERVAL 1 DAY TO VOLUME 'cold'
SETTINGS storage_policy = 'tiered';

-- Batch stats materialized view (real-time aggregation)
CREATE MATERIALIZED VIEW IF NOT EXISTS batch_stats_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (batch_id, event_date)
AS SELECT
    batch_id,
    event_date,
    countIf(event_type = 'sent') AS sent_count,
    countIf(event_type = 'delivered') AS delivered_count,
    countIf(event_type = 'opened') AS opened_count,
    countIf(event_type = 'clicked') AS clicked_count,
    countIf(event_type = 'bounced') AS bounced_count,
    countIf(event_type = 'complained') AS complained_count,
    countIf(event_type = 'failed') AS failed_count
FROM email_events
GROUP BY batch_id, event_date;

-- Daily stats per user
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_user_stats_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (user_id, event_date)
AS SELECT
    user_id,
    event_date,
    count() AS total_events,
    countIf(event_type = 'sent') AS sent_count,
    countIf(event_type = 'delivered') AS delivered_count,
    countIf(event_type = 'bounced') AS bounced_count
FROM email_events
GROUP BY user_id, event_date;

-- Index for provider message ID lookups (webhooks)
CREATE TABLE IF NOT EXISTS email_message_index
(
    provider_message_id String,
    recipient_id UUID,
    batch_id UUID,
    user_id UUID,
    created_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree()
ORDER BY provider_message_id
TTL created_at + INTERVAL 30 DAY;
