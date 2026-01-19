import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

const isDev = config.NODE_ENV !== "production";

// =============================================================================
// Trace Context (Correlation IDs)
// =============================================================================
// AsyncLocalStorage allows us to automatically propagate traceId through
// async operations without manually passing it everywhere.
//
// Usage:
//   withTrace(() => {
//     log.batch.info({ batchId }, "processing"); // traceId added automatically
//     await processEmails();                      // all nested logs get same traceId
//   });
//
// Or with existing traceId (from NATS message metadata):
//   withTrace(() => { ... }, existingTraceId);
// =============================================================================

interface TraceContext {
  traceId: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Generate a short, unique trace ID (12 chars, base62)
 * Format: xxxxxxxxxxxx (e.g., "a1B2c3D4e5F6")
 */
export function generateTraceId(): string {
  return randomBytes(9).toString("base64url").slice(0, 12);
}

/**
 * Get the current trace ID from context, or undefined if not in a trace
 */
export function getTraceId(): string | undefined {
  return traceStorage.getStore()?.traceId;
}

/**
 * Run a function with a trace context. All logs within will include the traceId.
 * If no traceId is provided, a new one is generated.
 */
export function withTrace<T>(fn: () => T, traceId?: string): T {
  const ctx: TraceContext = { traceId: traceId ?? generateTraceId() };
  return traceStorage.run(ctx, fn);
}

/**
 * Async version of withTrace for async functions
 */
export async function withTraceAsync<T>(
  fn: () => Promise<T>,
  traceId?: string
): Promise<T> {
  const ctx: TraceContext = { traceId: traceId ?? generateTraceId() };
  return traceStorage.run(ctx, fn);
}

// =============================================================================
// Structured Logger
// =============================================================================
//
// Usage patterns:
//
// SUCCESS (short, info level):
//   log.batch.info({ id, recipients: 1000 }, "created")
//   log.email.info({ id, to: "x@y.com" }, "sent")
//
// FAILURE (detailed, error level):
//   log.email.error({ id, to, error: err.message, provider, attempts }, "failed")
//
// DEBUG (verbose, only in dev):
//   log.queue.debug({ jobs: 50, users: 3 }, "status")
//
// =============================================================================

// Base logger configuration
const baseConfig: pino.LoggerOptions = {
  level: isDev ? "debug" : "info",

  // Custom log levels formatting
  formatters: {
    level: (label) => ({ level: label }),
  },

  // Timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,

  // Mixin adds traceId to every log entry automatically
  mixin() {
    const traceId = traceStorage.getStore()?.traceId;
    return traceId ? { traceId } : {};
  },
};

// Create the base logger - use pretty printing in development
export const logger = isDev
  ? pino({
      ...baseConfig,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
          messageFormat: "{component} | {msg}",
          singleLine: true,
        },
      },
    })
  : pino(baseConfig);

// =============================================================================
// Component Loggers
// =============================================================================
// Each component gets its own child logger for easy filtering

export const log = {
  // Batch processing lifecycle
  batch: logger.child({ component: "batch" }),

  // Individual email operations
  email: logger.child({ component: "email" }),

  // Queue operations
  queue: logger.child({ component: "queue" }),

  // Webhook events (delivery, bounce, etc.)
  webhook: logger.child({ component: "webhook" }),

  // API requests
  api: logger.child({ component: "api" }),

  // Rate limiting
  rateLimit: logger.child({ component: "rate-limiter" }),

  // Database operations
  db: logger.child({ component: "db" }),

  // Provider operations (Resend, SES, etc.)
  provider: logger.child({ component: "provider" }),

  // System-level events
  system: logger.child({ component: "system" }),

  // Cache operations (Dragonfly/Redis)
  cache: logger.child({ component: "cache" }),

  // NATS operations
  nats: logger.child({ component: "nats" }),
};

// =============================================================================
// Helper Types
// =============================================================================

export interface BatchLogContext {
  id: string;
  userId?: string;
  recipients?: number;
  sent?: number;
  failed?: number;
  bounced?: number;
  duration?: string;
}

export interface EmailLogContext {
  batchId: string;
  recipientId: string;
  to: string;
  provider?: string;
  messageId?: string;
  attempts?: number;
  error?: string;
  errorCode?: string;
}

export interface QueueLogContext {
  queue: string;
  jobs?: number;
  waiting?: number;
  active?: number;
  userId?: string;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Log a successful operation with minimal context
 */
export function logSuccess(
  component: keyof typeof log,
  event: string,
  context: Record<string, unknown>
): void {
  log[component].info(context, event);
}

/**
 * Log a failure with full context for debugging
 */
export function logFailure(
  component: keyof typeof log,
  event: string,
  error: Error | unknown,
  context: Record<string, unknown>
): void {
  const err = error instanceof Error ? error : new Error(String(error));

  log[component].error({
    ...context,
    error: err.message,
    errorName: err.name,
    // Include stack trace only in dev or for unexpected errors
    ...(isDev && { stack: err.stack }),
  }, event);
}

/**
 * Log a warning for unexpected but non-critical issues
 */
export function logWarning(
  component: keyof typeof log,
  event: string,
  context: Record<string, unknown>
): void {
  log[component].warn(context, event);
}

/**
 * Create a timer for measuring operation duration
 */
export function createTimer(): () => string {
  const start = process.hrtime.bigint();
  return () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1_000_000;
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };
}

// =============================================================================
// Default export for simple usage
// =============================================================================
export default log;
