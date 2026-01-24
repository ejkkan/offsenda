import { eq, and, lt, sql } from "drizzle-orm";
import { batches, recipients } from "@batchsender/db";
import { db } from "../db.js";
import { log, createTimer } from "../logger.js";
import { batchesProcessedTotal, batchesStuck, batchesRecoveredTotal } from "../metrics.js";
import type { LeaderElectionService } from "./leader-election.js";
import type { NatsQueueService } from "../nats/queue-service.js";

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
 * Threshold for resetting stuck batches with pending recipients (ms)
 * If a batch is stuck for longer than this AND has recipients in "queued" status,
 * reset it to "queued" so it can be re-processed
 */
const RESET_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Batch Recovery Service - detects and recovers stuck batches
 *
 * IMPORTANT: Only runs on the leader worker to prevent duplicate processing
 * across multiple worker instances.
 */
export class BatchRecoveryService {
  private config: BatchRecoveryConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private leaderElection?: LeaderElectionService;
  private queueService?: NatsQueueService;

  constructor(
    config: Partial<BatchRecoveryConfig> = {},
    leaderElection?: LeaderElectionService,
    queueService?: NatsQueueService
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.leaderElection = leaderElection;
    this.queueService = queueService;
  }

  /**
   * Set the queue service (can be set after construction)
   */
  setQueueService(queueService: NatsQueueService): void {
    this.queueService = queueService;
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
    // Only run if we're the leader (or no leader election configured)
    if (this.leaderElection && !this.leaderElection.isCurrentLeader()) {
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

      // Update the stuck batches gauge
      batchesStuck.set(stuckBatches.length);

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
   * Returns true if the batch was recovered (marked as completed or reset)
   */
  private async recoverBatch(batchId: string): Promise<boolean> {
    // Get batch details including startedAt for age check
    const batch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
      columns: { id: true, startedAt: true, userId: true },
    });

    if (!batch) {
      log.system.warn({ batchId }, "batch not found during recovery");
      return false;
    }

    // Get all recipients for this batch
    const batchRecipients = await db.query.recipients.findMany({
      where: eq(recipients.batchId, batchId),
      columns: { status: true },
    });

    // Check if all recipients are in a final state
    const allDone = batchRecipients.length > 0 && batchRecipients.every(
      (r: { status: string }) => FINAL_RECIPIENT_STATES.includes(r.status)
    );

    if (allDone) {
      // All recipients are done - mark batch as completed
      await db
        .update(batches)
        .set({
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batchId));

      // Record metrics
      batchesProcessedTotal.inc({ status: "recovered" });
      batchesRecoveredTotal.inc();

      log.batch.info(
        { id: batchId, recipients: batchRecipients.length },
        "recovered stuck batch (all done)"
      );

      return true;
    }

    // Check if batch has been stuck long enough to warrant a reset
    const batchAge = batch.startedAt ? Date.now() - batch.startedAt.getTime() : 0;
    const queuedRecipients = batchRecipients.filter(
      (r: { status: string }) => r.status === "queued"
    ).length;

    if (batchAge > RESET_THRESHOLD_MS && queuedRecipients > 0) {
      // Batch has been stuck for too long with un-processed recipients
      // Reset it to "queued" so it can be re-processed
      log.batch.warn(
        {
          id: batchId,
          ageMinutes: Math.round(batchAge / 60000),
          total: batchRecipients.length,
          queued: queuedRecipients,
        },
        "resetting stuck batch with pending recipients"
      );

      await db
        .update(batches)
        .set({
          status: "queued",
          startedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batchId));

      // The syncQueuedBatchesToQueue() function (runs every 5s) will automatically
      // pick up this batch and enqueue it to NATS for reprocessing

      // Record metrics
      batchesProcessedTotal.inc({ status: "reset" });
      batchesRecoveredTotal.inc();

      log.batch.info(
        { id: batchId, queuedRecipients },
        "batch reset to queued for reprocessing (will be auto-enqueued)"
      );

      return true;
    }

    // Batch has pending recipients but hasn't been stuck long enough
    log.system.debug(
      {
        batchId,
        total: batchRecipients.length,
        pending: batchRecipients.filter((r: { status: string }) => !FINAL_RECIPIENT_STATES.includes(r.status)).length,
        ageMinutes: Math.round(batchAge / 60000),
      },
      "batch has pending recipients, not old enough to reset"
    );
    return false;
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
  config?: Partial<BatchRecoveryConfig>,
  leaderElection?: LeaderElectionService,
  queueService?: NatsQueueService
): BatchRecoveryService {
  if (!instance) {
    instance = new BatchRecoveryService(config, leaderElection, queueService);
  } else if (queueService && !instance["queueService"]) {
    // Allow setting queue service after initial creation
    instance.setQueueService(queueService);
  }
  return instance;
}
