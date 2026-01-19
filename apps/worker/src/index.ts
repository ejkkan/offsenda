import Fastify from "fastify";
import { config } from "./config.js";
import { registerWebhookRoutes } from "./webhooks/routes.js";
import { registerWebhookSimulator } from "./webhooks.js";
import { registerWebhookSimulatorRoutes } from "./test/webhook-simulator-routes.js";
import { WebhookQueueProcessor } from "./webhooks/queue-processor.js";
import { registerApi } from "./api.js";
import { registerTestSetupApi } from "./api-test-setup.js";
import { clickhouse } from "./clickhouse.js";
import { batches } from "@batchsender/db";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { log } from "./logger.js";
import { RateLimiterService } from "./rate-limiter.js";

// NATS imports
import { NatsClient } from "./nats/client.js";
import { NatsQueueService } from "./nats/queue-service.js";
import { NatsEmailWorker } from "./nats/workers.js";
import { NatsWebhookWorker } from "./nats/webhook-worker.js";
import { setupWebhookStream } from "./nats/webhook-stream.js";

// Services
import { SchedulerService } from "./services/scheduler.js";
import { BatchRecoveryService } from "./services/batch-recovery.js";
import { AuditService, getAuditService } from "./services/audit.js";
import { PostgresSyncService, getPostgresSyncService } from "./services/postgres-sync.js";

// High-throughput components
import { getBufferedLogger } from "./buffered-logger.js";
import { getHotStateManager } from "./hot-state-manager.js";

const app = Fastify({
  logger: false,  // We use our own structured logger
  bodyLimit: config.MAX_REQUEST_SIZE_BYTES, // Default is 1MB, we need up to 10MB for batch uploads
});

// Global error handler - prevent stack trace leakage in production
app.setErrorHandler((error, request, reply) => {
  // Log full error details internally
  log.api.error({
    error: error.message,
    stack: error.stack,
    url: request.url,
    method: request.method,
    requestId: request.id,
  }, "unhandled error");

  // In production, return sanitized error messages
  if (config.NODE_ENV === "production") {
    const statusCode = (error as any).statusCode || 500;
    return reply.status(statusCode).send({
      error: statusCode === 500 ? "Internal server error" : error.message,
      requestId: request.id,
    });
  }

  // In development, return full error details
  return reply.status((error as any).statusCode || 500).send({
    error: error.message,
    stack: error.stack,
    requestId: request.id,
  });
});

// Request validation middleware
app.addHook("onRequest", async (request, reply) => {
  // Skip validation for health check
  if (request.url === "/health") {
    return;
  }

  // 1. Request size validation
  const contentLength = request.headers["content-length"];
  if (contentLength && parseInt(contentLength) > config.MAX_REQUEST_SIZE_BYTES) {
    return reply.status(413).send({
      error: "Request too large",
      maxSize: config.MAX_REQUEST_SIZE_BYTES,
    });
  }

  // 2. Content-Type validation for POST/PUT/PATCH
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const contentType = request.headers["content-type"];
    if (contentType && !contentType.includes("application/json") && !contentType.includes("text/plain")) {
      return reply.status(415).send({
        error: "Unsupported media type",
        supported: ["application/json", "text/plain"],
      });
    }
  }

  // 3. Distributed rate limiting (Dragonfly)
  if (!config.DISABLE_RATE_LIMIT) {
    const clientIp = request.ip;
    const result = await rateLimiterService.checkLimit(clientIp);

    // Add rate limit headers
    reply.header("X-RateLimit-Limit", result.limit);
    reply.header("X-RateLimit-Remaining", result.remaining);
    reply.header("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000));

    if (!result.allowed) {
      log.api.warn({ ip: clientIp }, "rate limit exceeded");
      return reply.status(429).send({
        error: "Too many requests",
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
      });
    }
  }
});

// Parse JSON body and keep raw body for webhook signature verification
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (req, body, done) => {
    try {
      (req as any).rawBody = body;
      const json = JSON.parse(body as string);
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  }
);

// Global instances
export let natsClient: NatsClient;
export let queueService: NatsQueueService;
export let rateLimiterService: RateLimiterService;
export let webhookQueueProcessor: WebhookQueueProcessor;
let worker: NatsEmailWorker;
let webhookWorker: NatsWebhookWorker;
let scheduler: SchedulerService;
let batchRecovery: BatchRecoveryService;
let auditService: AuditService;
let postgresSyncService: PostgresSyncService;

// Register routes - webhooks registered after NATS initialization

// Sync queued batches from DB to NATS queue
async function syncQueuedBatchesToQueue(): Promise<void> {
  try {
    const queuedBatches = await db.query.batches.findMany({
      where: eq(batches.status, "queued"),
      columns: { id: true, userId: true },
    });

    for (const batch of queuedBatches) {
      await queueService.enqueueBatch(batch.id, batch.userId);
      log.queue.info({ batchId: batch.id }, "synced to queue");
    }

    if (queuedBatches.length > 0) {
      log.queue.info({ count: queuedBatches.length }, "batch sync complete");
    }
  } catch (error) {
    // Don't crash on temporary database issues - just log and retry next interval
    log.db.warn({ error: (error as Error).message }, "sync failed, will retry");
  }
}

// Test connections
async function testConnections(): Promise<void> {
  log.system.info({}, "testing connections");

  // Test NATS
  try {
    const healthy = await natsClient.healthCheck();
    if (healthy) {
      log.system.info({ service: "nats" }, "connected");
    } else {
      throw new Error("NATS health check failed");
    }
  } catch (error) {
    log.system.error({ service: "nats", error: (error as Error).message }, "connection failed");
    throw error;
  }

  // Test ClickHouse
  try {
    const result = await clickhouse.query({
      query: "SELECT 1",
      format: "JSONEachRow",
    });
    await result.json();
    log.system.info({ service: "clickhouse" }, "connected");
  } catch (error) {
    log.system.error({ service: "clickhouse", error: (error as Error).message }, "connection failed");
  }
}

// Startup
try {
  // Initialize NATS
  natsClient = new NatsClient();
  await natsClient.connect();

  queueService = new NatsQueueService(natsClient);
  worker = new NatsEmailWorker(natsClient);
  webhookWorker = new NatsWebhookWorker(natsClient);
  webhookQueueProcessor = new WebhookQueueProcessor(natsClient);

  await testConnections();

  // Register routes after NATS initialization
  registerWebhookRoutes(app, webhookQueueProcessor);
  await registerApi(app);
  await registerTestSetupApi(app);
  await registerWebhookSimulator(app);
  await registerWebhookSimulatorRoutes(app, natsClient);

  // Health check endpoint for k8s probes
  app.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Initialize rate limiter
  rateLimiterService = new RateLimiterService();
  log.system.info({}, "rate limiter initialized");

  // Test Dragonfly connection (rate limiter uses it)
  const dragonflyHealthy = await rateLimiterService.healthCheck();
  if (!dragonflyHealthy) {
    log.system.error({}, "Dragonfly connection failed for rate limiter");
    // Don't exit - fail open is acceptable for rate limiting
  }

  // Initialize hot state manager BEFORE workers start (workers depend on it for idempotency)
  const hotState = getHotStateManager({
    completedBatchTtlMs: config.HOT_STATE_COMPLETED_TTL_HOURS * 60 * 60 * 1000,
    activeBatchTtlMs: config.HOT_STATE_ACTIVE_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
  const hotStateHealthy = await hotState.healthCheck();
  if (!hotStateHealthy) {
    log.system.error({}, "HotStateManager connection failed - Dragonfly required for message processing");
    process.exit(1);
  }
  log.system.info({}, "HotStateManager initialized (Dragonfly connected)");

  // Start buffered ClickHouse logger (workers use this for event logging)
  const bufferedLogger = getBufferedLogger({
    maxBufferSize: config.CLICKHOUSE_BUFFER_SIZE,
    flushIntervalMs: config.CLICKHOUSE_FLUSH_INTERVAL_MS,
  });
  bufferedLogger.start();
  log.system.info({}, "BufferedEventLogger started");

  // Start workers
  worker.startBatchProcessor().catch((error) => {
    const errorDetails = error instanceof Error
      ? { message: error.message, name: error.name, stack: error.stack }
      : { raw: String(error), type: typeof error };
    log.system.error({ error: errorDetails }, "Batch processor crashed");
    process.exit(1);
  });

  worker.startPriorityProcessor().catch((error) => {
    const errorDetails = error instanceof Error
      ? { message: error.message, name: error.name, stack: error.stack }
      : { raw: String(error), type: typeof error };
    log.system.error({ error: errorDetails }, "Priority processor crashed");
    // Don't exit - priority emails are optional
  });

  // Start existing user workers
  await worker.startExistingUserWorkers();

  // Setup webhook stream
  const jsm = natsClient.getJetStreamManager();
  await setupWebhookStream(jsm);
  log.system.info({}, "webhook stream configured");

  // Start webhook processor
  webhookWorker.startWebhookProcessor().catch((error) => {
    const errorDetails = error instanceof Error
      ? { message: error.message, name: error.name, stack: error.stack }
      : { raw: String(error), type: typeof error };
    log.system.error({ error: errorDetails }, "Webhook processor crashed");
    process.exit(1);
  });
  log.system.info({}, "webhook processor started");

  // Start scheduler for scheduled batches
  scheduler = new SchedulerService(queueService);
  scheduler.start();
  log.system.info({}, "scheduler started");

  // Start batch recovery service (detects and fixes stuck batches)
  batchRecovery = new BatchRecoveryService({
    enabled: config.BATCH_RECOVERY_ENABLED,
    scanIntervalMs: config.BATCH_RECOVERY_INTERVAL_MS,
    stuckThresholdMs: config.BATCH_RECOVERY_THRESHOLD_MS,
    maxBatchesPerScan: config.BATCH_RECOVERY_MAX_PER_SCAN,
  });
  batchRecovery.start();

  // Start audit service (security logging to ClickHouse)
  auditService = getAuditService({
    enabled: config.AUDIT_ENABLED,
    logToConsole: config.AUDIT_LOG_TO_CONSOLE,
    batchSize: config.AUDIT_BATCH_SIZE,
    flushIntervalMs: config.AUDIT_FLUSH_INTERVAL_MS,
  });
  auditService.start();

  // Start PostgreSQL background sync service
  postgresSyncService = getPostgresSyncService({
    enabled: config.POSTGRES_SYNC_ENABLED,
    syncIntervalMs: config.POSTGRES_SYNC_INTERVAL_MS,
    maxRecipientsPerSync: config.POSTGRES_SYNC_BATCH_SIZE,
  });
  await postgresSyncService.start(); // Runs crash recovery then starts periodic sync
  log.system.info({}, "PostgresSyncService started");

  // Sync any queued batches from DB to NATS on startup
  await syncQueuedBatchesToQueue();

  // Start periodic sync for new batches (every 5 seconds)
  setInterval(syncQueuedBatchesToQueue, 5000);

  // Start periodic cleanup of idle consumers (every hour)
  setInterval(() => {
    queueService.cleanupIdleConsumers().catch((error) => {
      log.system.warn({ error }, "Consumer cleanup failed");
    });
  }, 3600000);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  const stats = await queueService.getQueueStats();

  // Log startup info
  log.system.info({
    port: config.PORT,
    env: config.NODE_ENV,
    concurrentBatches: config.CONCURRENT_BATCHES,
    rateLimit: config.RATE_LIMIT_PER_SECOND,
    queueBatches: stats.batch.pending,
    queueEmails: stats.email.pending,
    natsCluster: config.NATS_CLUSTER,
  }, "worker started (NATS mode)");

  // Pretty banner for dev (human readable)
  if (config.NODE_ENV !== "production") {
    console.log(`
========================================
  BatchSender Worker Ready (NATS)
========================================
  http://localhost:${config.PORT}
  Rate limit: ${config.RATE_LIMIT_PER_SECOND}/sec
  NATS Cluster: ${config.NATS_CLUSTER}
========================================
`);
  }
} catch (err) {
  log.system.error({ error: (err as Error).message }, "startup failed");
  process.exit(1);
}

// Graceful shutdown with timeout protection
const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds max for graceful shutdown

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T | void> {
  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    log.system.warn({ error: (error as Error).message, component: name }, "shutdown timeout");
  }
}

async function shutdown() {
  log.system.info({}, "shutting down (30s timeout)");

  const shutdownStart = Date.now();

  // Phase 1: Stop accepting new work
  log.system.debug({}, "Phase 1: Stop accepting new work");
  await withTimeout(app.close(), 2000, "Fastify"); // Stop HTTP server first
  scheduler.stop();
  batchRecovery.stop();

  // Phase 2: Drain in-flight work
  log.system.debug({}, "Phase 2: Drain workers");
  await withTimeout(worker.shutdown(), 10000, "NatsWorker");
  await withTimeout(webhookWorker.shutdown(), 5000, "WebhookWorker");

  // Phase 3: Sync state to durable storage (while Dragonfly still available)
  log.system.debug({}, "Phase 3: Sync to durable storage");
  await withTimeout(postgresSyncService.stop(), 5000, "PostgresSyncService");

  // Phase 4: Flush buffered events (while ClickHouse still available)
  log.system.debug({}, "Phase 4: Flush events");
  const bufferedLogger = getBufferedLogger();
  await withTimeout(bufferedLogger.stop(), 5000, "BufferedEventLogger");
  await withTimeout(auditService.stop(), 5000, "AuditService");

  // Phase 5: Close all connections
  log.system.debug({}, "Phase 5: Close connections");
  const hotState = getHotStateManager();
  await withTimeout(hotState.close(), 2000, "HotStateManager");
  await withTimeout(rateLimiterService.close(), 2000, "RateLimiter");
  await withTimeout(natsClient.close(), 2000, "NATS");
  await withTimeout(clickhouse.close(), 2000, "ClickHouse");

  const duration = Date.now() - shutdownStart;
  log.system.info({ durationMs: duration }, "shutdown complete");

  process.exit(0);
}

// Force exit if graceful shutdown takes too long
let shutdownInProgress = false;
async function initiateShutdown() {
  if (shutdownInProgress) {
    log.system.warn({}, "shutdown already in progress, forcing exit");
    process.exit(1);
  }
  shutdownInProgress = true;

  // Set hard timeout
  const forceExitTimer = setTimeout(() => {
    log.system.error({}, "shutdown timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref(); // Don't keep process alive

  await shutdown();
}

process.on("SIGTERM", initiateShutdown);
process.on("SIGINT", initiateShutdown);