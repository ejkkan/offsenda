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

-- =============================================================================
-- Audit Log Table
-- =============================================================================
-- Tracks all security-relevant operations for compliance and debugging.
-- Designed for high-throughput writes and efficient querying by user/time.
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_log
(
    -- Event identification
    event_id UUID DEFAULT generateUUIDv4(),
    timestamp DateTime64(3) DEFAULT now64(3),

    -- Action classification
    action Enum16(
        -- Auth actions
        'login_success' = 1,
        'login_failure' = 2,
        'logout' = 3,
        'password_change' = 4,
        'password_reset_request' = 5,
        'password_reset_complete' = 6,
        'session_expired' = 7,
        -- Batch actions
        'batch_create' = 10,
        'batch_start' = 11,
        'batch_pause' = 12,
        'batch_resume' = 13,
        'batch_cancel' = 14,
        'batch_delete' = 15,
        'batch_complete' = 16,
        -- Config actions
        'send_config_create' = 20,
        'send_config_update' = 21,
        'send_config_delete' = 22,
        'send_config_test' = 23,
        -- API key actions
        'api_key_create' = 30,
        'api_key_revoke' = 31,
        'api_key_used' = 32,
        -- Webhook actions
        'webhook_config_create' = 40,
        'webhook_config_update' = 41,
        'webhook_config_delete' = 42,
        'webhook_received' = 43,
        'webhook_signature_invalid' = 44,
        -- Admin actions
        'user_create' = 50,
        'user_update' = 51,
        'user_delete' = 52,
        'user_suspend' = 53,
        'user_unsuspend' = 54,
        -- Security actions
        'rate_limit_exceeded' = 60,
        'invalid_token' = 61,
        'permission_denied' = 62,
        'suspicious_activity' = 63,
        'ip_blocked' = 64
    ),
    category Enum8(
        'auth' = 1,
        'batch' = 2,
        'config' = 3,
        'api_key' = 4,
        'webhook' = 5,
        'admin' = 6,
        'security' = 7
    ),
    outcome Enum8(
        'success' = 1,
        'failure' = 2,
        'denied' = 3
    ),

    -- Actor & target
    user_id String DEFAULT '',  -- Who performed the action (empty for anonymous)
    resource_type String DEFAULT '',  -- Type of resource affected
    resource_id String DEFAULT '',  -- ID of resource affected

    -- Request context
    trace_id String DEFAULT '',  -- For distributed tracing correlation
    ip String DEFAULT '',  -- Client IP address
    user_agent String DEFAULT '',  -- Client user agent
    method String DEFAULT '',  -- HTTP method
    path String DEFAULT '',  -- Request path

    -- Additional details
    metadata String DEFAULT '{}',  -- JSON string for extra data
    reason String DEFAULT '',  -- Human-readable explanation
    error_message String DEFAULT '',  -- Error details for failures

    -- Time-based partitioning
    event_date Date DEFAULT toDate(timestamp),

    -- Indexes for common queries
    INDEX idx_user_id user_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_category category TYPE set(8) GRANULARITY 4,
    INDEX idx_outcome outcome TYPE set(4) GRANULARITY 4,
    INDEX idx_ip ip TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (user_id, timestamp)  -- Optimized for user-centric queries
TTL event_date + INTERVAL 90 DAY  -- Keep audit logs for 90 days
SETTINGS index_granularity = 8192;

-- Materialized view for security alerts (high-value events)
CREATE MATERIALIZED VIEW IF NOT EXISTS security_alerts_mv
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (timestamp)
TTL event_date + INTERVAL 30 DAY
AS SELECT
    timestamp,
    action,
    outcome,
    user_id,
    ip,
    reason,
    error_message
FROM audit_log
WHERE category = 'security' OR outcome = 'denied';
