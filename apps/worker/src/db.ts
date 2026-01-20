import * as schema from "@batchsender/db";
import { config } from "./config.js";

/**
 * Database connection with optimized pool settings
 *
 * Development/Test: Standard postgres driver with connection pooling
 * Production: Neon serverless HTTP driver (connection pooling managed by Neon)
 *
 * The high-throughput architecture reduces database load significantly:
 * - Hot path uses Dragonfly for state (when HOT_STATE_ENABLED)
 * - PostgreSQL sync happens in background batches
 * - Individual per-message DB operations are eliminated
 */
let db: any;

if (config.NODE_ENV === "test" || config.NODE_ENV === "development") {
  // Local environment: use standard postgres driver with connection pool
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");

  const sql = postgres(config.DATABASE_URL, {
    // Connection pool settings optimized for high-throughput parallel processing
    max: 150,                   // Increased for 1000 concurrent messages
    idle_timeout: 30,           // Close idle connections after 30 seconds
    connect_timeout: 10,        // Connection timeout in seconds
    max_lifetime: 60 * 30,      // Max connection lifetime (30 minutes)
    prepare: false,             // Disable prepared statements for better compatibility
    transform: {
      // Don't transform column names - keep as-is
      column: {},
    },
  });
  db = drizzle(sql, { schema });
} else {
  // Production: use Neon serverless HTTP driver
  // Note: Neon HTTP driver is stateless (no connection pool)
  // Connection pooling is handled at Neon's infrastructure level
  // For high throughput, the hot state architecture reduces DB calls significantly
  const { neon } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");

  const sql = neon(config.DATABASE_URL);
  db = drizzle(sql as any, { schema });
}

export { db };
