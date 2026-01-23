/**
 * Preflight Checks
 *
 * Validates system readiness before accepting traffic:
 * 1. Dragonfly critical instance is reachable and configured correctly
 * 2. Dragonfly has persistence enabled (for crash recovery)
 * 3. Memory pressure is acceptable
 *
 * Fails fast if critical dependencies are not ready.
 */

import Redis from "ioredis";
import { config } from "./config.js";
import { log } from "./logger.js";

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
  critical: boolean;
}

export interface PreflightResult {
  ready: boolean;
  checks: PreflightCheck[];
}

/**
 * Parse memory value from Redis INFO output
 */
function parseMemoryInfo(info: string, key: string): number {
  const regex = new RegExp(`^${key}:(\\d+)`, "m");
  const match = info.match(regex);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Check Dragonfly critical instance
 */
async function checkDragonflyCritical(): Promise<PreflightCheck> {
  const url = config.DRAGONFLY_CRITICAL_URL || config.DRAGONFLY_URL;
  const [host, portStr] = url.split(":");
  const port = parseInt(portStr || "6379");

  try {
    const redis = new Redis({
      host,
      port,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
    });

    await redis.connect();

    // Test write/read
    const testKey = `preflight:critical:${Date.now()}`;
    await redis.set(testKey, "test", "EX", 10);
    const value = await redis.get(testKey);
    await redis.del(testKey);

    if (value !== "test") {
      await redis.quit();
      return {
        name: "dragonfly-critical",
        passed: false,
        message: "Write/read test failed",
        critical: true,
      };
    }

    // Check memory configuration
    const info = await redis.info("memory");
    const maxMemory = parseMemoryInfo(info, "maxmemory");
    const usedMemory = parseMemoryInfo(info, "used_memory");

    // Check eviction policy
    const configResult = await redis.config("GET", "maxmemory-policy") as string[];
    const policy = configResult?.[1];

    await redis.quit();

    // Validate configuration
    const warnings: string[] = [];

    if (maxMemory === 0) {
      warnings.push("maxmemory not set");
    }

    if (policy && policy !== "noeviction") {
      warnings.push(`eviction policy is '${policy}' (should be 'noeviction')`);
    }

    const ratio = maxMemory > 0 ? usedMemory / maxMemory : 0;
    if (ratio > 0.8) {
      return {
        name: "dragonfly-critical",
        passed: false,
        message: `Memory at ${(ratio * 100).toFixed(1)}% on startup (max 80%)`,
        critical: true,
      };
    }

    const msg = warnings.length > 0
      ? `Connected (warnings: ${warnings.join(", ")})`
      : `Connected, memory ${(ratio * 100).toFixed(1)}%`;

    return {
      name: "dragonfly-critical",
      passed: true,
      message: msg,
      critical: true,
    };
  } catch (error) {
    return {
      name: "dragonfly-critical",
      passed: false,
      message: `Connection failed: ${(error as Error).message}`,
      critical: true,
    };
  }
}

/**
 * Check Dragonfly auxiliary instance (non-critical, fail-open)
 */
async function checkDragonflyAuxiliary(): Promise<PreflightCheck> {
  const criticalUrl = config.DRAGONFLY_CRITICAL_URL || config.DRAGONFLY_URL;
  const auxiliaryUrl = config.DRAGONFLY_AUXILIARY_URL || config.DRAGONFLY_URL;

  // Skip if same as critical (not split architecture)
  if (auxiliaryUrl === criticalUrl) {
    return {
      name: "dragonfly-auxiliary",
      passed: true,
      message: "Using same instance as critical (not split)",
      critical: false,
    };
  }

  const [host, portStr] = auxiliaryUrl.split(":");
  const port = parseInt(portStr || "6379");

  try {
    const redis = new Redis({
      host,
      port,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
    });

    await redis.connect();
    await redis.ping();
    await redis.quit();

    return {
      name: "dragonfly-auxiliary",
      passed: true,
      message: "Connected",
      critical: false,
    };
  } catch (error) {
    return {
      name: "dragonfly-auxiliary",
      passed: false,
      message: `Connection failed: ${(error as Error).message} (non-critical, will use fail-open)`,
      critical: false,
    };
  }
}

/**
 * Check if Dragonfly has persistence configured
 */
async function checkDragonflyPersistence(): Promise<PreflightCheck> {
  const url = config.DRAGONFLY_CRITICAL_URL || config.DRAGONFLY_URL;
  const [host, portStr] = url.split(":");
  const port = parseInt(portStr || "6379");

  try {
    const redis = new Redis({
      host,
      port,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      lazyConnect: true,
    });

    await redis.connect();

    // Check persistence info
    const info = await redis.info("persistence");
    await redis.quit();

    // Look for indicators of persistence being enabled
    // Dragonfly shows rdb_last_save_time and other persistence metrics
    const hasRdbSave = info.includes("rdb_last_save_time");
    const rdbChanges = parseMemoryInfo(info, "rdb_changes_since_last_save");

    if (!hasRdbSave) {
      return {
        name: "dragonfly-persistence",
        passed: false,
        message: "Persistence not configured - data will be lost on restart!",
        critical: false, // Warning, not blocking
      };
    }

    return {
      name: "dragonfly-persistence",
      passed: true,
      message: `Persistence enabled (pending changes: ${rdbChanges})`,
      critical: false,
    };
  } catch (error) {
    return {
      name: "dragonfly-persistence",
      passed: false,
      message: `Check failed: ${(error as Error).message}`,
      critical: false,
    };
  }
}

/**
 * Run all preflight checks
 */
export async function runPreflight(): Promise<PreflightResult> {
  log.system.info({}, "Running preflight checks...");

  const checks: PreflightCheck[] = [];

  // Run checks
  checks.push(await checkDragonflyCritical());
  checks.push(await checkDragonflyAuxiliary());
  checks.push(await checkDragonflyPersistence());

  // Determine if ready (all critical checks must pass)
  const criticalFailed = checks.filter((c) => c.critical && !c.passed);
  const ready = criticalFailed.length === 0;

  // Log results
  for (const check of checks) {
    if (check.passed) {
      log.system.info({ check: check.name }, `✓ ${check.message}`);
    } else if (check.critical) {
      log.system.error({ check: check.name }, `✗ ${check.message}`);
    } else {
      log.system.warn({ check: check.name }, `⚠ ${check.message}`);
    }
  }

  if (ready) {
    log.system.info({}, "Preflight checks passed");
  } else {
    log.system.error(
      { failed: criticalFailed.map((c) => c.name) },
      "Preflight checks FAILED - not ready to accept traffic"
    );
  }

  return { ready, checks };
}
