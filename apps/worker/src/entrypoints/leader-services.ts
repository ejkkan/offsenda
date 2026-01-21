/**
 * Leader Services Entrypoint
 *
 * Runs singleton background tasks that should only run on one instance.
 * Uses Dragonfly-based leader election to ensure only one leader is active.
 *
 * Services:
 * - Batch Discoverer: Poll DB for queued batches, publish to NATS
 * - Scheduler: Check scheduled batches (scheduledAt <= now)
 * - Batch Recovery: Detect and fix stuck batches
 * - Audit Service: Security logging to ClickHouse
 *
 * This service should run N replicas for HA, but only 1 is active (the leader).
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

import { NatsQueueService } from "../nats/queue-service.js";
import { SchedulerService } from "../services/scheduler.js";
import { BatchRecoveryService } from "../services/batch-recovery.js";
import { getAuditService, type AuditService } from "../services/audit.js";
import { getLeaderElection, type LeaderElectionService } from "../services/leader-election.js";
import { db } from "../db.js";
import { batches } from "@batchsender/db";
import { eq } from "drizzle-orm";
import { register } from "../metrics.js";
import type { NatsClient } from "../nats/client.js";
import type { HotStateManager } from "../hot-state-manager.js";

// Global instances
let natsClient: NatsClient;
let queueService: NatsQueueService;
let hotState: HotStateManager;
let leaderElection: LeaderElectionService;
let scheduler: SchedulerService;
let batchRecovery: BatchRecoveryService;
let auditService: AuditService;
let batchDiscoveryInterval: NodeJS.Timeout | null = null;

// Minimal HTTP server for health checks and metrics
const app = Fastify({ logger: false });

app.get("/health", async () => {
  return {
    status: "ok",
    service: "leader-services",
    isLeader: leaderElection?.isCurrentLeader() || false,
    timestamp: new Date().toISOString(),
  };
});

app.get("/health/detailed", async () => {
  const natsHealthy = natsClient ? await natsClient.healthCheck() : false;
  const dragonflyHealthy = hotState ? await hotState.healthCheck() : false;

  return {
    status: natsHealthy && dragonflyHealthy ? "ok" : "degraded",
    service: "leader-services",
    isLeader: leaderElection?.isCurrentLeader() || false,
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

/**
 * Batch Discoverer - Poll DB for queued batches and publish to NATS.
 * This replaces the direct API publishing approach with a pull model.
 */
async function discoverQueuedBatches(): Promise<void> {
  // Only run on leader
  if (!leaderElection.isCurrentLeader()) {
    return;
  }

  try {
    const queuedBatches = await db.query.batches.findMany({
      where: eq(batches.status, "queued"),
      columns: { id: true, userId: true },
    });

    for (const batch of queuedBatches) {
      await queueService.enqueueBatch(batch.id, batch.userId);
      log.queue.info({ batchId: batch.id }, "batch discovered and enqueued");
    }

    if (queuedBatches.length > 0) {
      log.queue.info({ count: queuedBatches.length }, "batch discovery complete");
    }
  } catch (error) {
    log.db.warn({ error: (error as Error).message }, "batch discovery failed, will retry");
  }
}

async function start() {
  log.system.info({ service: "leader-services" }, "starting");

  // Initialize NATS
  const nats = await initNats();
  natsClient = nats.natsClient;
  queueService = nats.queueService;

  // Initialize hot state
  hotState = await initHotState();

  // Initialize leader election
  leaderElection = getLeaderElection();
  await leaderElection.start();
  log.system.info({ isLeader: leaderElection.isCurrentLeader() }, "leader election started");

  // Start scheduler (scheduled batches)
  scheduler = new SchedulerService(queueService, leaderElection);
  scheduler.start();
  log.system.info({}, "scheduler started (leader-only)");

  // Start batch recovery
  batchRecovery = new BatchRecoveryService({
    enabled: config.BATCH_RECOVERY_ENABLED,
    scanIntervalMs: config.BATCH_RECOVERY_INTERVAL_MS,
    stuckThresholdMs: config.BATCH_RECOVERY_THRESHOLD_MS,
    maxBatchesPerScan: config.BATCH_RECOVERY_MAX_PER_SCAN,
  }, leaderElection);
  batchRecovery.start();
  log.system.info({}, "batch recovery started (leader-only)");

  // Start audit service
  auditService = getAuditService({
    enabled: config.AUDIT_ENABLED,
    logToConsole: config.AUDIT_LOG_TO_CONSOLE,
    batchSize: config.AUDIT_BATCH_SIZE,
    flushIntervalMs: config.AUDIT_FLUSH_INTERVAL_MS,
  });
  auditService.start();
  log.system.info({}, "audit service started");

  // Start batch discoverer (poll every 5 seconds)
  await discoverQueuedBatches(); // Initial run
  batchDiscoveryInterval = setInterval(discoverQueuedBatches, 5000);
  log.system.info({}, "batch discoverer started (5s interval, leader-only)");

  // Start periodic cleanup of idle consumers (every hour)
  setInterval(() => {
    if (leaderElection.isCurrentLeader()) {
      queueService.cleanupIdleConsumers().catch((error) => {
        log.system.warn({ error }, "consumer cleanup failed");
      });
    }
  }, 3600000);

  // Start HTTP server for health/metrics
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  log.system.info({
    service: "leader-services",
    port: config.PORT,
    isLeader: leaderElection.isCurrentLeader(),
  }, "leader-services started");

  printBanner("Leader Services", {
    "Is Leader": leaderElection.isCurrentLeader(),
    "Worker ID": config.WORKER_ID,
    "NATS": config.NATS_CLUSTER,
  });
}

async function shutdown() {
  log.system.info({ service: "leader-services" }, "shutting down");

  // Stop batch discoverer
  if (batchDiscoveryInterval) {
    clearInterval(batchDiscoveryInterval);
  }

  // Stop HTTP server
  await withTimeout(app.close(), 2000, "Fastify");

  // Stop services
  scheduler?.stop();
  batchRecovery?.stop();

  // Release leadership
  await withTimeout(leaderElection?.stop(), 2000, "LeaderElection");

  // Flush audit events
  await withTimeout(auditService?.stop(), 5000, "AuditService");

  // Close connections
  await withTimeout(hotState?.close(), 2000, "HotStateManager");
  await withTimeout(natsClient?.close(), 2000, "NATS");
  await withTimeout(clickhouse.close(), 2000, "ClickHouse");
}

// Setup shutdown handlers
createShutdownHandler("leader-services", shutdown);

// Start the service
start().catch((err) => {
  log.system.error({ error: (err as Error).message }, "leader-services startup failed");
  process.exit(1);
});
