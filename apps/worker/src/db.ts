import * as schema from "@batchsender/db";
import { config } from "./config.js";

// Use standard postgres driver for test/development (local postgres)
// Use Neon serverless driver for production (Neon cloud database)
let db: any;

if (config.NODE_ENV === "test" || config.NODE_ENV === "development") {
  // Local environment: use standard postgres driver for direct connection
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");

  const sql = postgres(config.DATABASE_URL);
  db = drizzle(sql, { schema });
} else {
  // Production: use Neon serverless driver for edge compatibility
  const { neon } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");

  const sql = neon(config.DATABASE_URL);
  db = drizzle(sql as any, { schema });
}

export { db };
