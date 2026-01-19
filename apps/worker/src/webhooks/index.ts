/**
 * Webhook Processing Module
 *
 * Provides queue-based webhook processing for extreme scale
 */

export { WebhookQueueProcessor, WebhookEventFactory } from "./queue-processor.js";
export { registerWebhookRoutes } from "./routes.js";
export { setupWebhookStream } from "../nats/webhook-stream.js";
export * from "./metrics.js";

// Re-export legacy functions for backwards compatibility
export { registerWebhooks, registerWebhookSimulator } from "../webhooks.js";