import { eq, and, lt, sql } from "drizzle-orm";
import { batches, recipients } from "@batchsender/db";
import { db } from "../db.js";
import { log, createTimer } from "../logger.js";
import { batchesProcessedTotal } from "../metrics.js";

// =============================================================================
// Batch Recovery Service
// =============================================================================
// Detects and recovers stuck batches - those in "processing" status where:
// 1. All recipients are already in a final state (sent, delivered, bounced, etc.)
// 2. The batch has been processing for longer than the threshold
//
// This handles edge cases where:
// - checkBatchCompletion() failed silently
// - Worker crashed after processing but before updating batch status
// - Network issues prevented status update
// =============================================================================

/**
 * Configuration for the batch recovery service
 */
export interface BatchRecoveryConfig {
  /** How often to scan for stuck batches (ms) */
  scanIntervalMs: number;

  /** Threshold for considering a batch stuck (ms) */
  stuckThresholdMs: number;

  /** Maximum batches to process per scan (prevents overload) */
  maxBatchesPerScan: number;

  /** Whether the service is enabled */
  enabled: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: BatchRecoveryConfig = {
  scanIntervalMs: 5 * 60 * 1000,      // Scan every 5 minutes
  stuckThresholdMs: 15 * 60 * 1000,   // Stuck if processing > 15 minutes
  maxBatchesPerScan: 100,              // Process max 100 batches per scan
  enabled: true,
};

/**
 * Result of a recovery scan
 */
export interface RecoveryScanResult {
  scannedAt: Date;
  stuckBatchesFound: number;
  batchesRecovered: number;
  batchesFailed: number;
  durationMs: number;
  recoveredBatchIds: string[];
  failedBatchIds: string[];
}

/**
 * Final states for recipients - if all recipients are in one of these states,
 * the batch can be marked as completed
 */
const FINAL_RECIPIENT_STATES = ["sent", "delivered", "bounced", "complained", "failed"];

/**
 * Batch Recovery Service - detects and recovers stuck batches
 */
export class BatchRecoveryService {
  private config: BatchRecoveryConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(config: Partial<BatchRecoveryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the recovery service
   */
  start(): void {
    if (!this.config.enabled) {
      log.system.info({}, "batch recovery service disabled");
      return;
    }

    if (this.intervalId) {
      log.system.warn({}, "batch recovery service already running");
      return;
    }

    // Run immediately on start
    this.runScan().catch((error) => {
      log.system.error({ error: (error as Error).message }, "initial recovery scan failed");
    });

    // Schedule periodic scans
    this.intervalId = setInterval(() => {
      this.runScan().catch((error) => {
        log.system.error({ error: (error as Error).message }, "recovery scan failed");
      });
    }, this.config.scanIntervalMs);

    log.system.info(
      {
        intervalMs: this.config.scanIntervalMs,
        thresholdMs: this.config.stuckThresholdMs,
      },
      "batch recovery service started"
    );
  }

  /**
   * Stop the recovery service
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.system.info({}, "batch recovery service stopped");
    }
  }

  /**
   * Run a single recovery scan
   */
  async runScan(): Promise<RecoveryScanResult> {
    // Prevent concurrent scans
    if (this.isRunning) {
      log.system.debug({}, "recovery scan already in progress, skipping");
      return {
        scannedAt: new Date(),
        stuckBatchesFound: 0,
        batchesRecovered: 0,
        batchesFailed: 0,
        durationMs: 0,
        recoveredBatchIds: [],
        failedBatchIds: [],
      };
    }

    this.isRunning = true;
    const timer = createTimer();
    const result: RecoveryScanResult = {
      scannedAt: new Date(),
      stuckBatchesFound: 0,
      batchesRecovered: 0,
      batchesFailed: 0,
      durationMs: 0,
      recoveredBatchIds: [],
      failedBatchIds: [],
    };

    try {
      // Find stuck batches
      const stuckThreshold = new Date(Date.now() - this.config.stuckThresholdMs);
      const stuckBatches = await this.findStuckBatches(stuckThreshold);

      result.stuckBatchesFound = stuckBatches.length;

      if (stuckBatches.length === 0) {
        log.system.debug({}, "no stuck batches found");
        return result;
      }

      log.system.info(
        { count: stuckBatches.length },
        "found stuck batches, attempting recovery"
      );

      // Attempt recovery for each stuck batch
      for (const batch of stuckBatches.slice(0, this.config.maxBatchesPerScan)) {
        try {
          const recovered = await this.recoverBatch(batch.id);
          if (recovered) {
            result.batchesRecovered++;
            result.recoveredBatchIds.push(batch.id);
          }
        } catch (error) {
          result.batchesFailed++;
          result.failedBatchIds.push(batch.id);
          log.system.error(
            { batchId: batch.id, error: (error as Error).message },
            "failed to recover batch"
          );
        }
      }

      // Log summary
      if (result.batchesRecovered > 0 || result.batchesFailed > 0) {
        log.system.info(
          {
            found: result.stuckBatchesFound,
            recovered: result.batchesRecovered,
            failed: result.batchesFailed,
          },
          "recovery scan complete"
        );
      }

      return result;
    } finally {
      this.isRunning = false;
      result.durationMs = parseInt(timer().replace("ms", "").replace("s", "000"));
    }
  }

  /**
   * Find batches that are stuck in processing status
   */
  private async findStuckBatches(
    olderThan: Date
  ): Promise<Array<{ id: string; startedAt: Date | null }>> {
    return db.query.batches.findMany({
      where: and(
        eq(batches.status, "processing"),
        lt(batches.startedAt, olderThan)
      ),
      columns: {
        id: true,
        startedAt: true,
      },
      limit: this.config.maxBatchesPerScan,
    });
  }

  /**
   * Attempt to recover a single stuck batch
   * Returns true if the batch was recovered (marked as completed)
   */
  private async recoverBatch(batchId: string): Promise<boolean> {
    // Get all recipients for this batch
    const batchRecipients = await db.query.recipients.findMany({
      where: eq(recipients.batchId, batchId),
      columns: { status: true },
    });

    // Check if all recipients are in a final state
    const allDone = batchRecipients.length > 0 && batchRecipients.every(
      (r: { status: string }) => FINAL_RECIPIENT_STATES.includes(r.status)
    );

    if (!allDone) {
      // Batch has recipients still being processed - not stuck, just slow
      log.system.debug(
        {
          batchId,
          total: batchRecipients.length,
          pending: batchRecipients.filter((r: { status: string }) => !FINAL_RECIPIENT_STATES.includes(r.status)).length,
        },
        "batch has pending recipients, not recovering"
      );
      return false;
    }

    // All recipients are done - mark batch as completed
    await db
      .update(batches)
      .set({
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(batches.id, batchId));

    // Record metric
    batchesProcessedTotal.inc({ status: "recovered" });

    log.batch.info(
      { id: batchId, recipients: batchRecipients.length },
      "recovered stuck batch"
    );

    return true;
  }

  /**
   * Manually trigger a recovery scan (useful for testing or manual intervention)
   */
  async triggerScan(): Promise<RecoveryScanResult> {
    return this.runScan();
  }

  /**
   * Get current configuration
   */
  getConfig(): BatchRecoveryConfig {
    return { ...this.config };
  }

  /**
   * Update configuration (takes effect on next scan)
   */
  updateConfig(updates: Partial<BatchRecoveryConfig>): void {
    this.config = { ...this.config, ...updates };
    log.system.info({ config: this.config }, "batch recovery config updated");
  }
}

// Export singleton factory
let instance: BatchRecoveryService | null = null;

export function getBatchRecoveryService(
  config?: Partial<BatchRecoveryConfig>
): BatchRecoveryService {
  if (!instance) {
    instance = new BatchRecoveryService(config);
  }
  return instance;
}
