import { z } from "zod";

// Helper for parsing string booleans from environment variables
// z.coerce.boolean() treats any non-empty string as true, including "false"
const stringBoolean = z
  .union([z.boolean(), z.string()])
  .transform((val) => {
    if (typeof val === "boolean") return val;
    return val.toLowerCase() === "true";
  });

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // NATS JetStream
  NATS_CLUSTER: z.string().default("nats://localhost:4222"),
  NATS_REPLICAS: z.coerce.number().min(1).max(5).default(1),
  NATS_TLS_ENABLED: stringBoolean.default(false),
  NATS_TLS_CA_FILE: z.string().optional(), // Path to CA cert for verification
  NATS_TLS_CERT_FILE: z.string().optional(), // Path to client cert (if mutual TLS)
  NATS_TLS_KEY_FILE: z.string().optional(), // Path to client key (if mutual TLS)

  // ClickHouse
  CLICKHOUSE_URL: z.string().url().default("http://localhost:8123"),
  CLICKHOUSE_USER: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  CLICKHOUSE_DATABASE: z.string().default("batchsender"),

  // Dragonfly (distributed rate limiting)
  DRAGONFLY_URL: z.string().default("localhost:6379"),

  // Email provider
  EMAIL_PROVIDER: z.enum(["resend", "ses", "mock"]).default("resend"),
  RESEND_API_KEY: z.string().default(""), // Optional when using mock provider

  // AWS SES settings
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_ENDPOINT: z.string().url().optional(), // Override for mock server (e.g., http://localhost:4566/ses/send)

  // Mock provider settings (for testing)
  MOCK_MODE: z.enum(["success", "fail", "random"]).default("success"),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  MOCK_LATENCY_MS: z.coerce.number().default(50),

  // Webhooks
  WEBHOOK_SECRET: z.string().min(1),

  // Server
  PORT: z.coerce.number().default(6001),

  // Processing settings
  BATCH_SIZE: z.coerce.number().default(100),
  POLL_INTERVAL_MS: z.coerce.number().default(2000),
  RATE_LIMIT_PER_SECOND: z.coerce.number().default(100), // Per-user rate limit
  CONCURRENT_BATCHES: z.coerce.number().default(10),
  MAX_CONCURRENT_EMAILS: z.coerce.number().default(50), // Total concurrent email jobs

  // Provider-specific rate limits (messages per second)
  SES_RATE_LIMIT: z.coerce.number().default(14), // AWS SES default limit
  RESEND_RATE_LIMIT: z.coerce.number().default(100), // Resend default limit
  MOCK_RATE_LIMIT: z.coerce.number().default(1000), // Mock provider (no limit)

  // Worker scaling
  WORKER_ID: z.string().default("worker-1"), // Unique ID for this worker instance

  // Request validation
  MAX_REQUEST_SIZE_BYTES: z.coerce.number().default(10 * 1024 * 1024), // 10MB
  RATE_LIMIT_PER_IP: z.coerce.number().default(100), // requests per minute per IP
  DISABLE_RATE_LIMIT: stringBoolean.default(false), // Disable rate limiting (for E2E tests)

  // Environment
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // =============================================================================
  // Batch Recovery Service
  // =============================================================================
  // Detects and recovers stuck batches that are in "processing" status
  // but have all recipients in final states.
  BATCH_RECOVERY_ENABLED: stringBoolean.default(true),
  BATCH_RECOVERY_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000), // 5 minutes
  BATCH_RECOVERY_THRESHOLD_MS: z.coerce.number().default(15 * 60 * 1000), // 15 minutes
  BATCH_RECOVERY_MAX_PER_SCAN: z.coerce.number().default(100),

  // =============================================================================
  // Webhook Resilience
  // =============================================================================
  // Configures retry and circuit breaker for outgoing webhook calls
  WEBHOOK_TIMEOUT_MS: z.coerce.number().default(30000), // 30 seconds
  WEBHOOK_MAX_RETRIES: z.coerce.number().default(3),
  WEBHOOK_RETRY_BASE_DELAY_MS: z.coerce.number().default(1000), // 1 second
  WEBHOOK_RETRY_MAX_DELAY_MS: z.coerce.number().default(10000), // 10 seconds
  WEBHOOK_CIRCUIT_BREAKER_ENABLED: stringBoolean.default(true),
  WEBHOOK_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().default(5),
  WEBHOOK_CIRCUIT_RESET_TIMEOUT_MS: z.coerce.number().default(30000), // 30 seconds

  // =============================================================================
  // Audit Logging
  // =============================================================================
  // Comprehensive audit logging for security and compliance
  AUDIT_ENABLED: stringBoolean.default(true),
  AUDIT_LOG_TO_CONSOLE: stringBoolean.default(false),
  AUDIT_BATCH_SIZE: z.coerce.number().default(100),
  AUDIT_FLUSH_INTERVAL_MS: z.coerce.number().default(5000), // 5 seconds

  // =============================================================================
  // High-Throughput Processing
  // =============================================================================
  // Buffered ClickHouse logging
  CLICKHOUSE_BUFFER_SIZE: z.coerce.number().default(10000), // Max events before forced flush
  CLICKHOUSE_FLUSH_INTERVAL_MS: z.coerce.number().default(5000), // 5 seconds

  // Hot state manager (Dragonfly) - required for high-throughput processing
  HOT_STATE_COMPLETED_TTL_HOURS: z.coerce.number().default(48), // TTL for completed batches
  HOT_STATE_ACTIVE_TTL_DAYS: z.coerce.number().default(7), // TTL for active batches

  // PostgreSQL background sync - syncs hot state to PostgreSQL
  POSTGRES_SYNC_ENABLED: stringBoolean.default(true),
  POSTGRES_SYNC_INTERVAL_MS: z.coerce.number().default(2000), // 2 seconds
  POSTGRES_SYNC_BATCH_SIZE: z.coerce.number().default(1000), // Max recipients per sync cycle
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Missing or invalid environment variables:");
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof envSchema>;
