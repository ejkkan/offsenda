import { z } from "zod";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse string booleans from environment variables.
 * z.coerce.boolean() treats any non-empty string as true, including "false"
 */
const stringBoolean = z
  .union([z.boolean(), z.string()])
  .transform((val) => {
    if (typeof val === "boolean") return val;
    return val.toLowerCase() === "true";
  });

// =============================================================================
// Config Schema - Grouped by Domain
// =============================================================================

export const configSchema = z.object({
  // ===========================================================================
  // Environment
  // ===========================================================================
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  WORKER_ID: z.string().default("worker-1"),

  // ===========================================================================
  // Database (PostgreSQL)
  // ===========================================================================
  DATABASE_URL: z.string().url(),

  // ===========================================================================
  // NATS JetStream
  // ===========================================================================
  NATS_CLUSTER: z.string().default("nats://localhost:4222"),
  NATS_REPLICAS: z.coerce.number().min(1).max(5).default(3),
  NATS_MAX_MSGS_PER_SUBJECT: z.coerce.number().default(1_000_000),
  NATS_TLS_ENABLED: stringBoolean.default(false),
  NATS_TLS_CA_FILE: z.string().optional(),
  NATS_TLS_CERT_FILE: z.string().optional(),
  NATS_TLS_KEY_FILE: z.string().optional(),

  // ===========================================================================
  // ClickHouse (Analytics)
  // ===========================================================================
  CLICKHOUSE_URL: z.string().url().default("http://localhost:8123"),
  CLICKHOUSE_USER: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  CLICKHOUSE_DATABASE: z.string().default("batchsender"),
  CLICKHOUSE_BUFFER_SIZE: z.coerce.number().default(10000),
  CLICKHOUSE_FLUSH_INTERVAL_MS: z.coerce.number().default(5000),

  // ===========================================================================
  // Dragonfly (Redis-compatible, for rate limiting & hot state)
  // Split architecture: critical (batch state) + auxiliary (rate limiting, caching)
  // ===========================================================================
  /** Legacy URL - fallback if split URLs not configured */
  DRAGONFLY_URL: z.string().default("localhost:6379"),
  /** Critical instance for HotStateManager (batch state, prevents duplicate sends) */
  DRAGONFLY_CRITICAL_URL: z.string().default("dragonfly-critical.batchsender.svc:6379"),
  /** Auxiliary instance for rate limiting, caching (fail-open services) */
  DRAGONFLY_AUXILIARY_URL: z.string().default("dragonfly-auxiliary.batchsender.svc:6379"),
  HOT_STATE_COMPLETED_TTL_HOURS: z.coerce.number().default(48),
  HOT_STATE_ACTIVE_TTL_DAYS: z.coerce.number().default(7),

  // ===========================================================================
  // Rate Limiting
  // ===========================================================================
  /** System-wide rate limit ceiling (all requests across all users) */
  SYSTEM_RATE_LIMIT: z.coerce.number().default(100000),

  // ===========================================================================
  // Provider Rate Limits (Managed Mode)
  // Shared limits when users use BatchSender's provider accounts
  // ===========================================================================
  // Email providers
  MANAGED_SES_RATE_LIMIT: z.coerce.number().default(14),
  MANAGED_RESEND_RATE_LIMIT: z.coerce.number().default(100),
  // SMS providers
  MANAGED_TELNYX_RATE_LIMIT: z.coerce.number().default(50),

  // ===========================================================================
  // Provider Credentials
  // ===========================================================================
  // Resend
  RESEND_API_KEY: z.string().default(""),
  // AWS SES
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_ENDPOINT: z.string().url().optional(),
  // Telnyx
  TELNYX_WEBHOOK_SECRET: z.string().optional(),

  // ===========================================================================
  // Webhooks (Inbound from providers)
  // ===========================================================================
  WEBHOOK_SECRET: z.string().min(1),
  WEBHOOK_BATCH_SIZE: z.coerce.number().default(100),
  WEBHOOK_FLUSH_INTERVAL: z.coerce.number().default(1000),
  WEBHOOK_MAX_WORKERS: z.coerce.number().default(10),
  WEBHOOK_QUEUE_ENABLED: stringBoolean.default(true),
  WEBHOOK_DEDUP_TTL: z.coerce.number().default(86400),

  // ===========================================================================
  // Webhooks (Outbound to customers)
  // ===========================================================================
  WEBHOOK_TIMEOUT_MS: z.coerce.number().default(30000),
  WEBHOOK_MAX_RETRIES: z.coerce.number().default(3),
  WEBHOOK_RETRY_BASE_DELAY_MS: z.coerce.number().default(1000),
  WEBHOOK_RETRY_MAX_DELAY_MS: z.coerce.number().default(10000),
  WEBHOOK_CIRCUIT_BREAKER_ENABLED: stringBoolean.default(true),
  WEBHOOK_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().default(5),
  WEBHOOK_CIRCUIT_RESET_TIMEOUT_MS: z.coerce.number().default(30000),

  // ===========================================================================
  // Server
  // ===========================================================================
  PORT: z.coerce.number().default(6001),
  MAX_REQUEST_SIZE_BYTES: z.coerce.number().default(10 * 1024 * 1024),
  RATE_LIMIT_PER_IP: z.coerce.number().default(100),
  DISABLE_RATE_LIMIT: stringBoolean.default(false),

  // ===========================================================================
  // Background Services
  // ===========================================================================
  // Batch Recovery
  BATCH_RECOVERY_ENABLED: stringBoolean.default(true),
  BATCH_RECOVERY_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  BATCH_RECOVERY_THRESHOLD_MS: z.coerce.number().default(15 * 60 * 1000),
  BATCH_RECOVERY_MAX_PER_SCAN: z.coerce.number().default(100),

  // PostgreSQL Sync
  POSTGRES_SYNC_ENABLED: stringBoolean.default(true),
  POSTGRES_SYNC_INTERVAL_MS: z.coerce.number().default(2000),
  POSTGRES_SYNC_BATCH_SIZE: z.coerce.number().default(1000),

  // Audit Logging
  AUDIT_ENABLED: stringBoolean.default(true),
  AUDIT_LOG_TO_CONSOLE: stringBoolean.default(false),
  AUDIT_BATCH_SIZE: z.coerce.number().default(100),
  AUDIT_FLUSH_INTERVAL_MS: z.coerce.number().default(5000),

  // ===========================================================================
  // Testing & Development
  // ===========================================================================
  TEST_ADMIN_SECRET: z.string().default("test-admin-secret"),
  ENABLE_TEST_SETUP_API: z.string().optional(),
  ENABLE_WEBHOOK_SIMULATOR: z.string().optional(),
  /** Minimum simulated latency for dry run mode (ms) */
  DRY_RUN_LATENCY_MIN_MS: z.coerce.number().default(50),
  /** Maximum simulated latency for dry run mode (ms) */
  DRY_RUN_LATENCY_MAX_MS: z.coerce.number().default(500),
});

// =============================================================================
// Config Loading
// =============================================================================

export type Config = z.infer<typeof configSchema>;

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig !== null) {
    return cachedConfig;
  }

  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Missing or invalid environment variables:");
    console.error(result.error.format());
    process.exit(1);
  }

  const config = result.data;
  cachedConfig = config;
  return config;
}

/** For testing: reset cached config */
export function resetConfig(): void {
  cachedConfig = null;
}

/** Singleton config instance */
export const config = loadConfig();
