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
import { register, batchesInProgress, pendingRecipientsTotal } from "../metrics.js";
import { db } from "../db.js";
import { batches } from "@batchsender/db";
import { eq, sql } from "drizzle-orm";
import type { NatsClient } from "../nats/client.js";
import type { HotStateManager } from "../hot-state-manager.js";
import type { BufferedEventLogger } from "../buffered-logger.js";

// Global instances
let natsClient: NatsClient;
let worker: NatsEmailWorker;
let hotState: HotStateManager;
let bufferedLogger: BufferedEventLogger;
let postgresSyncService: PostgresSyncService;
let metricsUpdateInterval: NodeJS.Timeout | null = null;

/**
 * Update scaling metrics for KEDA.
 *
 * Primary metric (pendingRecipientsTotal):
 * - Read from Dragonfly global counter (O(1) operation)
 * - Incremented when batches are initialized
 * - Decremented atomically as each recipient is processed
 * - Falls back to database query if Dragonfly counter seems wrong
 *
 * Secondary metric (batchesInProgress):
 * - Count from database (for monitoring, not scaling)
 */
async function updateScalingMetrics(): Promise<void> {
  try {
    // Read global pending from Dragonfly (O(1) - primary scaling metric)
    const dragonflyPending = await hotState.getGlobalPendingRecipients();

    // Query database for ground truth (used for reconciliation and monitoring)
    const dbResult = await db.execute(sql`
      SELECT
        COALESCE(SUM(total_recipients - sent_count - failed_count), 0)::int AS pending,
        COUNT(*)::int AS batch_count
      FROM batches
      WHERE status = 'processing'
    `);

    const row = dbResult.rows[0] as { pending: number; batch_count: number } | undefined;
    const dbPending = row?.pending ?? 0;
    const processingBatches = row?.batch_count ?? 0;

    // Use Dragonfly value if it seems reasonable, otherwise fall back to DB
    // Dragonfly might be 0 after restart, or negative due to bugs
    // DB is ground truth but slightly stale (sync delay)
    let pendingRecipients: number;
    if (dragonflyPending > 0) {
      // Dragonfly has a positive value - trust it (more real-time)
      pendingRecipients = dragonflyPending;
    } else if (dbPending > 0 && dragonflyPending === 0) {
      // Dragonfly shows 0 but DB shows work - likely Dragonfly restarted
      // Use DB value as fallback to prevent premature scale-down
      pendingRecipients = dbPending;
      log.system.warn(
        { dragonflyPending, dbPending },
        "Dragonfly counter is 0 but DB shows pending work - using DB fallback"
      );
    } else {
      // Both are 0 or Dragonfly is negative - use max(0, dragonfly)
      pendingRecipients = Math.max(0, dragonflyPending);
    }

    pendingRecipientsTotal.set(pendingRecipients);
    batchesInProgress.set(processingBatches);

    // Log for debugging KEDA scaling
    if (pendingRecipients > 0 || processingBatches > 0) {
      log.system.debug({ pendingRecipients, dragonflyPending, dbPending, processingBatches }, "scaling metrics updated");
    }
  } catch (error) {
    log.system.warn({ error: (error as Error).message }, "failed to update scaling metrics");
  }
}

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

  // Start periodic scaling metrics update (every 5 seconds)
  // This provides KEDA with accurate batches_in_progress data
  await updateScalingMetrics(); // Initial update
  metricsUpdateInterval = setInterval(updateScalingMetrics, 5000);
  log.system.info({}, "scaling metrics updater started (5s interval)");

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

  // Stop metrics updater
  if (metricsUpdateInterval) {
    clearInterval(metricsUpdateInterval);
  }

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
