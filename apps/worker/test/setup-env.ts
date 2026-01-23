/**
 * Test environment setup
 * Sets required environment variables BEFORE any imports happen
 * This file runs via vitest's setupFiles, which executes before test collection
 */

// Clear Prometheus registry to prevent metric collision in tests
// Must happen before any metrics are imported
import promClient from 'prom-client';
promClient.register.clear();

// Set test environment variables
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5433/batchsender_test";
process.env.NATS_CLUSTER = process.env.NATS_CLUSTER || "localhost:4222";
process.env.CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8124";
process.env.CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "test";
process.env.CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "test";
process.env.CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || "batchsender_test";
process.env.DRAGONFLY_URL = process.env.DRAGONFLY_URL || "localhost:6380";
process.env.DRAGONFLY_CRITICAL_URL = process.env.DRAGONFLY_CRITICAL_URL || "localhost:6380";
process.env.DRAGONFLY_AUXILIARY_URL = process.env.DRAGONFLY_AUXILIARY_URL || "localhost:6380";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "test-webhook-secret";
process.env.EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || "mock";
process.env.NODE_ENV = "test";
process.env.DISABLE_RATE_LIMIT = "true";

// Suppress noisy logs during tests
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
