/**
 * API Server Entrypoint
 *
 * Handles all HTTP traffic:
 * - /api/* - REST API (batch management, send configs, analytics)
 * - /webhooks/* - Provider webhooks (Resend, SES, Telnyx)
 * - /metrics - Prometheus metrics
 * - /health - K8s probes
 *
 * This service is stateless and can scale horizontally.
 */

import Fastify from "fastify";
import {
  config,
  log,
  clickhouse,
  initNats,
  initRateLimiter,
  testClickHouse,
  withTimeout,
  createShutdownHandler,
  printBanner,
} from "./shared.js";

import { registerWebhookRoutes } from "../webhooks/routes.js";
import { registerWebhookSimulator } from "../webhooks.js";
import { registerWebhookSimulatorRoutes } from "../test/webhook-simulator-routes.js";
import { WebhookQueueProcessor } from "../webhooks/queue-processor.js";
import { registerApi } from "../api.js";
import { registerTestSetupApi } from "../api-test-setup.js";
import type { NatsClient } from "../nats/client.js";
import type { NatsQueueService } from "../nats/queue-service.js";
import type { RateLimiterService } from "../api-rate-limiter.js";

// Global instances for this service
let natsClient: NatsClient;
let queueService: NatsQueueService;
let rateLimiterService: RateLimiterService;
let webhookQueueProcessor: WebhookQueueProcessor;

const app = Fastify({
  logger: false,
  bodyLimit: config.MAX_REQUEST_SIZE_BYTES,
});

// Global error handler
app.setErrorHandler((error, request, reply) => {
  const statusCode = (error as any).statusCode || 500;

  log.api.error({
    error: error.message,
    stack: error.stack,
    url: request.url,
    method: request.method,
    requestId: request.id,
    statusCode,
  }, "unhandled error");

  return reply.status(statusCode).send({
    error: error.message,
    requestId: request.id,
    ...(config.NODE_ENV !== "production" && { stack: error.stack }),
  });
});

// Request validation middleware
app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health" || request.url === "/metrics") {
    return;
  }

  // Request size validation
  const contentLength = request.headers["content-length"];
  if (contentLength && parseInt(contentLength) > config.MAX_REQUEST_SIZE_BYTES) {
    return reply.status(413).send({
      error: "Request too large",
      maxSize: config.MAX_REQUEST_SIZE_BYTES,
    });
  }

  // Content-Type validation
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const contentType = request.headers["content-type"];
    if (contentType && !contentType.includes("application/json") && !contentType.includes("text/plain")) {
      return reply.status(415).send({
        error: "Unsupported media type",
        supported: ["application/json", "text/plain"],
      });
    }
  }

  // Rate limiting - bypass for admin requests
  const adminSecret = request.headers["x-admin-secret"];
  const isAdminRequest = adminSecret === config.TEST_ADMIN_SECRET;

  if (!config.DISABLE_RATE_LIMIT && rateLimiterService && !isAdminRequest) {
    const clientIp = request.ip;
    const result = await rateLimiterService.checkLimit(clientIp);

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

// Parse JSON and keep raw body for webhook signature verification
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

// Health check (basic - detailed health is registered via registerApi)
app.get("/health", async () => {
  return { status: "ok", service: "api-server", timestamp: new Date().toISOString() };
});

async function start() {
  log.system.info({ service: "api-server" }, "starting");

  // Initialize NATS (for publishing batches and webhooks)
  const nats = await initNats();
  natsClient = nats.natsClient;
  queueService = nats.queueService;

  // Initialize rate limiter
  rateLimiterService = await initRateLimiter();

  // Initialize webhook queue processor
  webhookQueueProcessor = new WebhookQueueProcessor(natsClient);

  // Test ClickHouse (for analytics queries)
  await testClickHouse();

  // Register routes
  registerWebhookRoutes(app, webhookQueueProcessor);
  await registerApi(app, { queueService, natsClient });
  await registerTestSetupApi(app);
  await registerWebhookSimulator(app);
  await registerWebhookSimulatorRoutes(app, natsClient);

  // Start server
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  log.system.info({
    service: "api-server",
    port: config.PORT,
    env: config.NODE_ENV,
  }, "api-server started");

  printBanner("API Server", {
    "NATS": config.NATS_CLUSTER,
  });
}

async function shutdown() {
  log.system.info({ service: "api-server" }, "shutting down");

  await withTimeout(app.close(), 2000, "Fastify");
  await withTimeout(rateLimiterService?.close(), 2000, "RateLimiter");
  await withTimeout(natsClient?.close(), 2000, "NATS");
  await withTimeout(clickhouse.close(), 2000, "ClickHouse");
}

// Setup shutdown handlers
createShutdownHandler("api-server", shutdown);

// Start the service
start().catch((err) => {
  log.system.error({ error: (err as Error).message }, "api-server startup failed");
  process.exit(1);
});

// Export for testing
export { app, queueService, webhookQueueProcessor, rateLimiterService };
