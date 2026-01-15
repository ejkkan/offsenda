/**
 * Test database connection
 * Uses direct PostgreSQL connection instead of Neon's serverless driver
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@batchsender/db";

// Use direct PostgreSQL connection for tests
const connectionString = process.env.DATABASE_URL || "postgresql://test:test@localhost:5433/batchsender_test";
const sql = postgres(connectionString);

export const db = drizzle(sql, { schema });

// Export sql client for cleanup operations
export { sql };
