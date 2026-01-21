/**
 * Webhook Processor Entrypoint
 *
 * Consumes webhook events from NATS and processes delivery status updates.
 *
 * Responsibilities:
 * - Consume from webhook.{provider}.{event}
 * - Batch events for efficiency
 * - Enrich events (lookup batch/recipient by provider message ID)
 * - Deduplicate events
 * - Update recipient status in PostgreSQL
 * - Log events to ClickHouse
 *
 * This service can scale to 1-5 replicas based on webhook volume.
 */

import Fastify from "fastify";
import {
  config,
  log,
  clickhouse,
  initNats,
  initHotState,
  withTimeout,
  createShutdownHandler,
  printBanner,
} from "./shared.js";

import { NatsWebhookWorker } from "../nats/webhook-worker.js";
import { setupWebhookStream } from "../nats/webhook-stream.js";
import { register } from "../metrics.js";
import type { NatsClient } from "../nats/client.js";
import type { HotStateManager } from "../hot-state-manager.js";

// Global instances
let natsClient: NatsClient;
let webhookWorker: NatsWebhookWorker;
let hotState: HotStateManager;

// Minimal HTTP server for health checks and metrics
const app = Fastify({ logger: false });

app.get("/health", async () => {
  return { status: "ok", service: "webhook-processor", timestamp: new Date().toISOString() };
});

app.get("/health/detailed", async () => {
  const natsHealthy = natsClient ? await natsClient.healthCheck() : false;
  const dragonflyHealthy = hotState ? await hotState.healthCheck() : false;

  return {
    status: natsHealthy && dragonflyHealthy ? "ok" : "degraded",
    service: "webhook-processor",
    components: {
      nats: natsHealthy ? "ok" : "error",
      dragonfly: dragonflyHealthy ? "ok" : "error",
    },
    timestamp: new Date().toISOString(),
  };
});

app.get("/metrics", async (_, reply) => {
  reply.header("Content-Type", register.contentType);
  return register.metrics();
});

async function start() {
  log.system.info({ service: "webhook-processor" }, "starting");

  // Initialize NATS
  const nats = await initNats();
  natsClient = nats.natsClient;

  // Initialize hot state (for deduplication)
  hotState = await initHotState();

  // Setup webhook stream (ensures stream exists)
  const jsm = natsClient.getJetStreamManager();
  await setupWebhookStream(jsm);
  log.system.info({}, "webhook stream configured");

  // Create and start webhook worker
  webhookWorker = new NatsWebhookWorker(natsClient);
  webhookWorker.startWebhookProcessor().catch((error) => {
    log.system.error({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }, "webhook processor crashed");
    process.exit(1);
  });

  // Start HTTP server for health/metrics
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  log.system.info({
    service: "webhook-processor",
    port: config.PORT,
  }, "webhook-processor started");

  printBanner("Webhook Processor", {
    "NATS": config.NATS_CLUSTER,
  });
}

async function shutdown() {
  log.system.info({ service: "webhook-processor" }, "shutting down");

  // Stop HTTP server
  await withTimeout(app.close(), 2000, "Fastify");

  // Drain webhook worker
  await withTimeout(webhookWorker?.shutdown(), 10000, "WebhookWorker");

  // Close connections
  await withTimeout(hotState?.close(), 2000, "HotStateManager");
  await withTimeout(natsClient?.close(), 2000, "NATS");
  await withTimeout(clickhouse.close(), 2000, "ClickHouse");
}

// Setup shutdown handlers
createShutdownHandler("webhook-processor", shutdown);

// Start the service
start().catch((err) => {
  log.system.error({ error: (err as Error).message }, "webhook-processor startup failed");
  process.exit(1);
});
