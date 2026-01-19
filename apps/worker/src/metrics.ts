import promClient from 'prom-client';

// Initialize Prometheus default metrics (CPU, memory, etc.)
promClient.collectDefaultMetrics({
  prefix: 'worker_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// Create a registry for all metrics
export const register = promClient.register;

// ============================================
// Email Processing Metrics
// ============================================

/**
 * Histogram: Time to send a single email
 * Labels: provider (resend/ses/mock), status (success/failure)
 */
export const emailSendDuration = new promClient.Histogram({
  name: 'email_send_duration_seconds',
  help: 'Duration of email send operations',
  labelNames: ['provider', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10], // 10ms to 10s
});

/**
 * Counter: Total emails sent
 * Labels: provider, status (sent/failed)
 */
export const emailsSentTotal = new promClient.Counter({
  name: 'emails_sent_total',
  help: 'Total number of emails sent',
  labelNames: ['provider', 'status'],
});

/**
 * Counter: Total email errors by type
 * Labels: provider, error_type (transient/rate_limit/permanent/unknown)
 */
export const emailErrorsTotal = new promClient.Counter({
  name: 'email_errors_total',
  help: 'Total number of email errors by type',
  labelNames: ['provider', 'error_type'],
});

// ============================================
// Batch Processing Metrics
// ============================================

/**
 * Histogram: Time to process entire batch (from queue to all emails sent)
 */
export const batchProcessingDuration = new promClient.Histogram({
  name: 'batch_processing_duration_seconds',
  help: 'Duration of batch processing (queue to completion)',
  buckets: [1, 5, 10, 30, 60, 120, 300, 600], // 1s to 10min
});

/**
 * Counter: Total batches processed
 * Labels: status (completed/failed)
 */
export const batchesProcessedTotal = new promClient.Counter({
  name: 'batches_processed_total',
  help: 'Total number of batches processed',
  labelNames: ['status'],
});

/**
 * Gauge: Current batches in processing state
 */
export const batchesInProgress = new promClient.Gauge({
  name: 'batches_in_progress',
  help: 'Number of batches currently being processed',
});

// ============================================
// NATS Queue Metrics
// ============================================

/**
 * Gauge: Pending messages in batch-processor consumer
 */
export const natsQueueDepthBatchProcessor = new promClient.Gauge({
  name: 'nats_queue_depth_batch_processor',
  help: 'Number of pending messages in batch-processor consumer',
});

/**
 * Gauge: Pending messages in user email consumers (aggregated)
 */
export const natsQueueDepthEmailProcessor = new promClient.Gauge({
  name: 'nats_queue_depth_email_processor',
  help: 'Number of pending messages in email processors',
});

/**
 * Gauge: Total pending messages across all consumers
 */
export const natsQueueDepthTotal = new promClient.Gauge({
  name: 'nats_queue_depth_total',
  help: 'Total pending messages across all consumers',
});

/**
 * Histogram: Message processing time (from NATS pull to ack)
 * Labels: consumer_type (batch/email)
 */
export const natsMessageProcessingDuration = new promClient.Histogram({
  name: 'nats_message_processing_duration_seconds',
  help: 'Duration of NATS message processing',
  labelNames: ['consumer_type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
});

// ============================================
// Provider Rate Limiting Metrics
// ============================================

/**
 * Gauge: Current provider rate limit token bucket level
 * Labels: provider
 */
export const providerRateLimitTokens = new promClient.Gauge({
  name: 'provider_rate_limit_tokens',
  help: 'Current number of available tokens in rate limiter',
  labelNames: ['provider'],
});

/**
 * Counter: Total rate limit hits (requests delayed)
 * Labels: provider
 */
export const providerRateLimitHits = new promClient.Counter({
  name: 'provider_rate_limit_hits_total',
  help: 'Total number of rate limit delays',
  labelNames: ['provider'],
});

/**
 * Histogram: Rate limit wait time
 * Labels: provider
 */
export const providerRateLimitWaitDuration = new promClient.Histogram({
  name: 'provider_rate_limit_wait_duration_seconds',
  help: 'Duration of rate limit waits',
  labelNames: ['provider'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
});

// ============================================
// Database Metrics
// ============================================

/**
 * Histogram: PostgreSQL query duration
 * Labels: operation (select/insert/update), table
 */
export const postgresQueryDuration = new promClient.Histogram({
  name: 'postgres_query_duration_seconds',
  help: 'Duration of PostgreSQL queries',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

/**
 * Histogram: ClickHouse insert duration
 * Labels: table
 */
export const clickhouseInsertDuration = new promClient.Histogram({
  name: 'clickhouse_insert_duration_seconds',
  help: 'Duration of ClickHouse inserts',
  labelNames: ['table'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

/**
 * Counter: Total ClickHouse events logged
 * Labels: event_type (queued/sent/delivered/bounced/failed)
 */
export const clickhouseEventsTotal = new promClient.Counter({
  name: 'clickhouse_events_total',
  help: 'Total number of events logged to ClickHouse',
  labelNames: ['event_type'],
});

// ============================================
// API Metrics
// ============================================

/**
 * Histogram: HTTP request duration
 * Labels: method, route, status_code
 */
export const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

/**
 * Counter: Total HTTP requests
 * Labels: method, route, status_code
 */
export const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// ============================================
// Webhook Metrics
// ============================================

/**
 * Counter: Total webhooks received
 * Labels: provider, event_type
 */
export const webhooksReceivedTotal = new promClient.Counter({
  name: 'webhooks_received_total',
  help: 'Total number of webhooks received',
  labelNames: ['provider', 'event_type'],
});

/**
 * Counter: Total webhooks processed
 * Labels: provider, event_type, status
 */
export const webhooksProcessedTotal = new promClient.Counter({
  name: 'webhooks_processed_total',
  help: 'Total number of webhooks processed',
  labelNames: ['provider', 'event_type', 'status'],
});

/**
 * Counter: Total webhook processing errors
 * Labels: error_type
 */
export const webhooksErrorsTotal = new promClient.Counter({
  name: 'webhooks_errors_total',
  help: 'Total number of webhook processing errors',
  labelNames: ['error_type'],
});

/**
 * Histogram: Webhook batch size
 */
export const webhookBatchSize = new promClient.Histogram({
  name: 'webhook_batch_size',
  help: 'Size of webhook batches processed',
  buckets: [1, 5, 10, 25, 50, 100, 200, 500],
});

/**
 * Gauge: Current webhook queue depth
 */
export const webhookQueueDepth = new promClient.Gauge({
  name: 'webhook_queue_depth',
  help: 'Number of webhooks in processing buffer',
});

/**
 * Histogram: Webhook processing duration
 * Labels: status (success/error)
 */
export const webhookProcessingDuration = new promClient.Histogram({
  name: 'webhook_processing_duration_seconds',
  help: 'Duration of webhook batch processing',
  labelNames: ['status'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

// ============================================
// Helper Functions
// ============================================

/**
 * Start a timer for a histogram metric
 * @returns end function to stop timer and record duration
 */
export function startTimer(
  histogram: promClient.Histogram<string>,
  labels?: Record<string, string>
) {
  return histogram.startTimer(labels);
}

/**
 * Get all metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get metrics content type
 */
export function getMetricsContentType(): string {
  return register.contentType;
}
