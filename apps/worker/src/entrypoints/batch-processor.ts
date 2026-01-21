/**
 * Batch Processor Entrypoint
 *
 * Consumes batch jobs from NATS and expands them into individual email jobs.
 *
 * Responsibilities:
 * - Consume from sys.batch.process
 * - Load batch and recipients from DB
 * - Initialize hot state in Dragonfly
 * - Publish individual jobs to email.user.{userId}.send
 * - Log events to ClickHouse
 *
 * This service can scale horizontally (NATS handles distribution).
 */

import Fastify from "fastify";
import {
  config,
  log,
  clickhouse,
  initNats,
  initHotState,
  initBufferedLogger,
  withTimeout,
  createShutdownHandler,
  printBanner,
} from "./shared.js";

import { NatsEmailWorker } from "../nats/workers.js";
import { register } from "../metrics.js";
import type { NatsClient } from "../nats/client.js";
import type { HotStateManager } from "../hot-state-manager.js";
import type { BufferedEventLogger } from "../buffered-logger.js";

// Global instances
let natsClient: NatsClient;
let worker: NatsEmailWorker;
let hotState: HotStateManager;
let bufferedLogger: BufferedEventLogger;

// Minimal HTTP server for health checks and metrics
const app = Fastify({ logger: false });

app.get("/health", async () => {
  return { status: "ok", service: "batch-processor", timestamp: new Date().toISOString() };
});

app.get("/health/detailed", async () => {
  const natsHealthy = natsClient ? await natsClient.healthCheck() : false;
  const dragonflyHealthy = hotState ? await hotState.healthCheck() : false;

  return {
    status: natsHealthy && dragonflyHealthy ? "ok" : "degraded",
    service: "batch-processor",
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
  log.system.info({ service: "batch-processor" }, "starting");

  // Initialize NATS
  const nats = await initNats();
  natsClient = nats.natsClient;

  // Initialize hot state (required for batch completion tracking)
  hotState = await initHotState();

  // Initialize buffered logger (for ClickHouse event logging)
  bufferedLogger = initBufferedLogger();

  // Create worker
  worker = new NatsEmailWorker(natsClient);

  // Start batch processor consumer
  worker.startBatchProcessor().catch((error) => {
    log.system.error({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }, "batch processor crashed");
    process.exit(1);
  });

  // Start HTTP server for health/metrics
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  log.system.info({
    service: "batch-processor",
    port: config.PORT,
    concurrentBatches: config.CONCURRENT_BATCHES,
  }, "batch-processor started");

  printBanner("Batch Processor", {
    "Concurrent Batches": config.CONCURRENT_BATCHES,
    "NATS": config.NATS_CLUSTER,
  });
}

async function shutdown() {
  log.system.info({ service: "batch-processor" }, "shutting down");

  // Stop HTTP server
  await withTimeout(app.close(), 2000, "Fastify");

  // Drain worker (wait for in-flight batches)
  await withTimeout(worker?.shutdown(), 15000, "NatsWorker");

  // Flush buffered events
  await withTimeout(bufferedLogger?.stop(), 5000, "BufferedEventLogger");

  // Close connections
  await withTimeout(hotState?.close(), 2000, "HotStateManager");
  await withTimeout(natsClient?.close(), 2000, "NATS");
  await withTimeout(clickhouse.close(), 2000, "ClickHouse");
}

// Setup shutdown handlers
createShutdownHandler("batch-processor", shutdown);

// Start the service
start().catch((err) => {
  log.system.error({ error: (err as Error).message }, "batch-processor startup failed");
  process.exit(1);
});
