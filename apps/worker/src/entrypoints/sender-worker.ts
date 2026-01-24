/**
 * Sender Worker Entrypoint
 *
 * Consumes email jobs from NATS and sends them via providers (Resend, SES, Telnyx).
 *
 * Responsibilities:
 * - Consume from email.user.{userId}.send (per-user queues)
 * - Idempotency check via Dragonfly
 * - Rate limiting (managed/BYOK)
 * - Execute send via provider
 * - Update counters and check batch completion
 * - Log events to ClickHouse
 *
 * This is the main scaling service - can run 20-100 replicas with KEDA.
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
import { getPostgresSyncService, type PostgresSyncService } from "../services/postgres-sync.js";
import { register } from "../metrics.js";
import type { NatsClient } from "../nats/client.js";
import type { HotStateManager } from "../hot-state-manager.js";
import type { BufferedEventLogger } from "../buffered-logger.js";

// Global instances
let natsClient: NatsClient;
let worker: NatsEmailWorker;
let hotState: HotStateManager;
let bufferedLogger: BufferedEventLogger;
let postgresSyncService: PostgresSyncService;

// Minimal HTTP server for health checks and metrics
const app = Fastify({ logger: false });

app.get("/health", async () => {
  return { status: "ok", service: "sender-worker", timestamp: new Date().toISOString() };
});

app.get("/health/detailed", async () => {
  const natsHealthy = natsClient ? await natsClient.healthCheck() : false;
  const dragonflyHealthy = hotState ? await hotState.healthCheck() : false;

  return {
    status: natsHealthy && dragonflyHealthy ? "ok" : "degraded",
    service: "sender-worker",
    components: {
      nats: natsHealthy ? "ok" : "error",
      dragonfly: dragonflyHealthy ? "ok" : "error",
    },
    // inFlight tracking available via metrics
    timestamp: new Date().toISOString(),
  };
});

app.get("/metrics", async (_, reply) => {
  reply.header("Content-Type", register.contentType);
  return register.metrics();
});

async function start() {
  log.system.info({ service: "sender-worker" }, "starting");

  // Initialize NATS
  const nats = await initNats();
  natsClient = nats.natsClient;

  // Initialize hot state (required for idempotency and counters)
  hotState = await initHotState();

  // Initialize buffered logger
  bufferedLogger = initBufferedLogger();

  // Initialize PostgreSQL sync service (background sync of recipient status)
  postgresSyncService = getPostgresSyncService({
    enabled: config.POSTGRES_SYNC_ENABLED,
    syncIntervalMs: config.POSTGRES_SYNC_INTERVAL_MS,
    maxRecipientsPerSync: config.POSTGRES_SYNC_BATCH_SIZE,
  });
  await postgresSyncService.start();
  log.system.info({}, "PostgresSyncService started");

  // Create worker
  worker = new NatsEmailWorker(natsClient);

  // Start user workers (main email processing)
  await worker.startExistingUserWorkers();

  // Start HTTP server for health/metrics
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  log.system.info({
    service: "sender-worker",
    port: config.PORT,
  }, "sender-worker started");

  printBanner("Sender Worker", {
    "NATS": config.NATS_CLUSTER,
  });
}

async function shutdown() {
  log.system.info({ service: "sender-worker" }, "shutting down");

  // Stop HTTP server
  await withTimeout(app.close(), 2000, "Fastify");

  // Drain worker (wait for in-flight emails)
  await withTimeout(worker?.shutdown(), 15000, "NatsWorker");

  // Sync pending updates to PostgreSQL
  await withTimeout(postgresSyncService?.stop(), 5000, "PostgresSyncService");

  // Flush buffered events
  await withTimeout(bufferedLogger?.stop(), 5000, "BufferedEventLogger");

  // Close connections
  await withTimeout(hotState?.close(), 2000, "HotStateManager");
  await withTimeout(natsClient?.close(), 2000, "NATS");
  await withTimeout(clickhouse.close(), 2000, "ClickHouse");
}

// Setup shutdown handlers
createShutdownHandler("sender-worker", shutdown);

// Start the service
start().catch((err) => {
  log.system.error({ error: (err as Error).message }, "sender-worker startup failed");
  process.exit(1);
});
