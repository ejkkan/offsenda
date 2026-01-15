import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";

// Detect if URL is for Neon (cloud) or local postgres
function isNeonUrl(url: string): boolean {
  return url.includes("neon.tech") || url.includes("neon-");
}

export function createDb(databaseUrl: string) {
  if (isNeonUrl(databaseUrl)) {
    // Production: use Neon serverless driver
    const sql = neon(databaseUrl) as NeonQueryFunction<boolean, boolean>;
    return drizzleNeon(sql, { schema });
  } else {
    // Local dev: use standard postgres driver
    const sql = postgres(databaseUrl);
    return drizzlePostgres(sql, { schema });
  }
}

export type Database = ReturnType<typeof createDb>;
