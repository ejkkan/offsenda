import Fastify from "fastify";
import { config } from "./config.js";
import { registerWebhooks, registerWebhookSimulator } from "./webhooks.js";
import { registerApi } from "./api.js";
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

const app = Fastify({
  logger: false,  // We use our own structured logger
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
let worker: NatsEmailWorker;

// Register routes
await registerWebhooks(app);
await registerApi(app);
await registerWebhookSimulator(app);

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

  await testConnections();

  // Initialize rate limiter
  rateLimiterService = new RateLimiterService();
  log.system.info({}, "rate limiter initialized");

  // Test Dragonfly connection
  const dragonflyHealthy = await rateLimiterService.healthCheck();
  if (!dragonflyHealthy) {
    log.system.error({}, "Dragonfly connection failed");
    // Don't exit - fail open is acceptable for rate limiting
  }

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

// Graceful shutdown
async function shutdown() {
  log.system.info({}, "shutting down");

  // Stop accepting new work
  await worker.shutdown();

  // Close connections
  await rateLimiterService.close();
  await app.close();
  await natsClient.close();
  await clickhouse.close();

  log.system.info({}, "shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);