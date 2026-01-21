/**
 * Shared initialization logic for all service entrypoints.
 *
 * Each service imports what it needs from here to avoid duplication.
 */

import { config } from "../config.js";
import { log } from "../logger.js";
import { clickhouse } from "../clickhouse.js";
import { NatsClient } from "../nats/client.js";
import { NatsQueueService } from "../nats/queue-service.js";
import { getHotStateManager, type HotStateManager } from "../hot-state-manager.js";
import { getBufferedLogger, type BufferedEventLogger } from "../buffered-logger.js";
import { RateLimiterService } from "../api-rate-limiter.js";

export { config, log, clickhouse };

// Shared NATS setup
export async function initNats(): Promise<{ natsClient: NatsClient; queueService: NatsQueueService }> {
  const natsClient = new NatsClient();
  await natsClient.connect();

  const queueService = new NatsQueueService(natsClient);

  log.system.info({ cluster: config.NATS_CLUSTER }, "NATS connected");
  return { natsClient, queueService };
}

// Hot state manager (Dragonfly)
export async function initHotState(): Promise<HotStateManager> {
  const hotState = getHotStateManager({
    completedBatchTtlMs: config.HOT_STATE_COMPLETED_TTL_HOURS * 60 * 60 * 1000,
    activeBatchTtlMs: config.HOT_STATE_ACTIVE_TTL_DAYS * 24 * 60 * 60 * 1000,
  });

  const healthy = await hotState.healthCheck();
  if (!healthy) {
    throw new Error("HotStateManager connection failed - Dragonfly required");
  }

  log.system.info({}, "HotStateManager initialized");
  return hotState;
}

// Buffered ClickHouse logger
export function initBufferedLogger(): BufferedEventLogger {
  const bufferedLogger = getBufferedLogger({
    maxBufferSize: config.CLICKHOUSE_BUFFER_SIZE,
    flushIntervalMs: config.CLICKHOUSE_FLUSH_INTERVAL_MS,
  });
  bufferedLogger.start();

  log.system.info({}, "BufferedEventLogger started");
  return bufferedLogger;
}

// API rate limiter
export async function initRateLimiter(): Promise<RateLimiterService> {
  const rateLimiterService = new RateLimiterService();

  const healthy = await rateLimiterService.healthCheck();
  if (!healthy) {
    log.system.warn({}, "Dragonfly connection failed for rate limiter - failing open");
  }

  log.system.info({}, "RateLimiter initialized");
  return rateLimiterService;
}

// Test ClickHouse connection
export async function testClickHouse(): Promise<boolean> {
  try {
    const result = await clickhouse.query({
      query: "SELECT 1",
      format: "JSONEachRow",
    });
    await result.json();
    log.system.info({ service: "clickhouse" }, "connected");
    return true;
  } catch (error) {
    log.system.warn({ service: "clickhouse", error: (error as Error).message }, "connection failed");
    return false;
  }
}

// Graceful shutdown helper
const SHUTDOWN_TIMEOUT_MS = 30000;

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  name: string
): Promise<T | void> {
  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    log.system.warn({ error: (error as Error).message, component: name }, "shutdown timeout");
  }
}

export function createShutdownHandler(
  serviceName: string,
  shutdownFn: () => Promise<void>
): void {
  let shutdownInProgress = false;

  async function initiateShutdown() {
    if (shutdownInProgress) {
      log.system.warn({ service: serviceName }, "shutdown already in progress, forcing exit");
      process.exit(1);
    }
    shutdownInProgress = true;

    log.system.info({ service: serviceName }, "shutting down");

    const forceExitTimer = setTimeout(() => {
      log.system.error({ service: serviceName }, "shutdown timeout exceeded, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
      await shutdownFn();
      log.system.info({ service: serviceName }, "shutdown complete");
      process.exit(0);
    } catch (error) {
      log.system.error({ service: serviceName, error: (error as Error).message }, "shutdown error");
      process.exit(1);
    }
  }

  process.on("SIGTERM", initiateShutdown);
  process.on("SIGINT", initiateShutdown);
}

// Service banner for dev
export function printBanner(serviceName: string, extras: Record<string, any> = {}): void {
  if (config.NODE_ENV !== "production") {
    const lines = [
      `  ${serviceName}`,
      `  Port: ${config.PORT}`,
      ...Object.entries(extras).map(([k, v]) => `  ${k}: ${v}`),
    ];

    console.log(`
========================================
${lines.join("\n")}
========================================
`);
  }
}
