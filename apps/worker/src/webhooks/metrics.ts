import { Histogram, Counter, Gauge, register } from "prom-client";

// =============================================================================
// Webhook Metrics
// =============================================================================

// Webhook receive counter
export const webhookReceivedCounter = new Counter({
  name: "webhook_received_total",
  help: "Total number of webhooks received",
  labelNames: ["provider", "event_type", "status"],
  registers: [register],
});

// Webhook queue counter
export const webhookQueuedCounter = new Counter({
  name: "webhook_queued_total",
  help: "Total number of webhooks queued for processing",
  labelNames: ["provider", "event_type"],
  registers: [register],
});

// Webhook processing counter
export const webhookProcessedCounter = new Counter({
  name: "webhook_processed_total",
  help: "Total number of webhooks processed",
  labelNames: ["provider", "event_type", "status"],
  registers: [register],
});

// Webhook response time
export const webhookResponseTime = new Histogram({
  name: "webhook_response_duration_seconds",
  help: "Webhook endpoint response time (how fast we ACK)",
  labelNames: ["provider"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// Webhook processing time
export const webhookProcessingTime = new Histogram({
  name: "webhook_processing_duration_seconds",
  help: "Time to process webhook batch",
  labelNames: ["batch_size"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Webhook batch size
export const webhookBatchSize = new Histogram({
  name: "webhook_batch_size",
  help: "Number of webhooks processed per batch",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

// Webhook queue depth
export const webhookQueueDepth = new Gauge({
  name: "webhook_queue_depth",
  help: "Current number of webhooks awaiting processing",
  labelNames: ["provider"],
  registers: [register],
});

// Webhook processing lag
export const webhookProcessingLag = new Gauge({
  name: "webhook_processing_lag_seconds",
  help: "Time since oldest unprocessed webhook",
  labelNames: ["provider"],
  registers: [register],
});

// Database update performance
export const webhookDbUpdateTime = new Histogram({
  name: "webhook_db_update_duration_seconds",
  help: "Time to update database for webhook batch",
  labelNames: ["operation"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// Signature verification
export const webhookSignatureVerification = new Counter({
  name: "webhook_signature_verification_total",
  help: "Webhook signature verification attempts",
  labelNames: ["provider", "status"],
  registers: [register],
});

// =============================================================================
// Metric Helpers
// =============================================================================

export function recordWebhookReceived(
  provider: string,
  eventType: string,
  status: "success" | "error" = "success"
): void {
  webhookReceivedCounter.labels(provider, eventType, status).inc();
}

export function recordWebhookQueued(
  provider: string,
  eventType: string
): void {
  webhookQueuedCounter.labels(provider, eventType).inc();
}

export function recordWebhookProcessed(
  provider: string,
  eventType: string,
  count: number,
  status: "success" | "error" = "success"
): void {
  webhookProcessedCounter.labels(provider, eventType, status).inc(count);
}

export function recordBatchProcessed(
  batchSize: number,
  durationMs: number
): void {
  webhookBatchSize.observe(batchSize);
  webhookProcessingTime.labels(String(batchSize)).observe(durationMs / 1000);
}

export function updateQueueDepth(
  provider: string,
  depth: number
): void {
  webhookQueueDepth.labels(provider).set(depth);
}

export function updateProcessingLag(
  provider: string,
  lagSeconds: number
): void {
  webhookProcessingLag.labels(provider).set(lagSeconds);
}