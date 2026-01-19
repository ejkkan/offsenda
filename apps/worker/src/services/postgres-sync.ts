/**
 * PostgreSQL Background Sync Service
 *
 * Syncs hot state from Dragonfly to PostgreSQL in the background.
 * This enables the hot path to use only Dragonfly while maintaining
 * durable state in PostgreSQL.
 *
 * Sync operations:
 * 1. Batch recipient status updates (bulk UPDATE)
 * 2. Batch counter sync (sent_count, failed_count)
 * 3. Batch completion detection and status update
 *
 * Runs every 2 seconds by default, processing up to 1000 recipients per batch per cycle.
 */

import { eq, and, sql } from "drizzle-orm";
import { recipients, batches } from "@batchsender/db";
import { db } from "../db.js";
import { getHotStateManager, type RecipientState } from "../hot-state-manager.js";
import { log } from "../logger.js";
import { batchesProcessedTotal } from "../metrics.js";
import { groupRecipientsByStatus } from "../domain/utils/recipient-grouping.js";

export interface PostgresSyncConfig {
  /** Sync interval in milliseconds (default: 2000) */
  syncIntervalMs?: number;
  /** Maximum recipients to sync per batch per cycle (default: 1000) */
  maxRecipientsPerSync?: number;
  /** Whether to enable the service (default: true) */
  enabled?: boolean;
  /** Time after which a processing batch is considered stuck (default: 10 minutes) */
  stuckBatchThresholdMs?: number;
}

const DEFAULT_CONFIG: Required<PostgresSyncConfig> = {
  syncIntervalMs: 2000,
  maxRecipientsPerSync: 1000,
  enabled: true,
  stuckBatchThresholdMs: 10 * 60 * 1000, // 10 minutes
};

export class PostgresSyncService {
  private config: Required<PostgresSyncConfig>;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isShuttingDown = false;
  private batchesInFlight = new Set<string>(); // Track batches currently being synced
  private stats = {
    syncCycles: 0,
    recipientsSynced: 0,
    batchesCompleted: 0,
    batchesRecovered: 0,
    errors: 0,
    lastSyncTime: 0,
    lastSyncDuration: 0,
  };

  constructor(config?: PostgresSyncConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the sync service
   * Runs crash recovery first, then starts periodic sync
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      log.system.info({}, "PostgresSyncService disabled");
      return;
    }

    if (this.syncInterval) {
      return; // Already running
    }

    // Run crash recovery on startup
    await this.recoverStuckBatches();

    this.syncInterval = setInterval(() => {
      if (!this.isRunning) {
        this.runSyncCycle().catch((error) => {
          log.system.error({ error }, "PostgresSyncService sync cycle failed");
          this.stats.errors++;
        });
      }
    }, this.config.syncIntervalMs);

    log.system.info(
      {
        syncIntervalMs: this.config.syncIntervalMs,
        maxRecipientsPerSync: this.config.maxRecipientsPerSync,
      },
      "PostgresSyncService started"
    );
  }

  /**
   * Recover batches that were stuck in "processing" status due to crash
   * Checks if Dragonfly has state, and either syncs it or marks batch for retry
   */
  private async recoverStuckBatches(): Promise<void> {
    try {
      const stuckThreshold = new Date(Date.now() - this.config.stuckBatchThresholdMs);

      // Find batches stuck in "processing" for too long
      const stuckBatches = await db.query.batches.findMany({
        where: and(
          eq(batches.status, "processing"),
          sql`${batches.updatedAt} < ${stuckThreshold}`
        ),
        columns: { id: true, totalCount: true },
      });

      if (stuckBatches.length === 0) {
        return;
      }

      log.system.info({ count: stuckBatches.length }, "PostgresSyncService found stuck batches, attempting recovery");

      const hotState = getHotStateManager();

      for (const batch of stuckBatches) {
        try {
          // Check if Dragonfly has state for this batch
          const counters = await hotState.getCounters(batch.id);

          if (counters && counters.total > 0) {
            // Dragonfly has state - sync it to PostgreSQL
            log.system.info({ batchId: batch.id, counters }, "Recovering batch from Dragonfly state");

            // Full sync: get all pending recipients and sync them
            let totalSynced = 0;
            let pendingIds = await hotState.getPendingSyncRecipients(batch.id, this.config.maxRecipientsPerSync);

            while (pendingIds.length > 0) {
              const states = await hotState.getRecipientStates(batch.id, pendingIds);
              const syncedIds = await this.bulkUpdateRecipients(batch.id, states);
              await hotState.markSynced(batch.id, syncedIds);
              totalSynced += syncedIds.length;
              pendingIds = await hotState.getPendingSyncRecipients(batch.id, this.config.maxRecipientsPerSync);
            }

            // Sync final counters
            await this.syncCounters(batch.id, hotState);

            // Check if actually complete
            if (counters.total > 0 && (counters.sent + counters.failed) >= counters.total) {
              await db
                .update(batches)
                .set({
                  status: "completed",
                  sentCount: counters.sent,
                  failedCount: counters.failed,
                  completedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(batches.id, batch.id));
              await hotState.markBatchCompleted(batch.id);
              log.system.info({ batchId: batch.id, synced: totalSynced }, "Batch recovered and completed");
            } else {
              // Update counters but keep processing status - batch will be picked up by workers
              await db
                .update(batches)
                .set({
                  sentCount: counters.sent,
                  failedCount: counters.failed,
                  updatedAt: new Date(),
                })
                .where(eq(batches.id, batch.id));
              log.system.info({ batchId: batch.id, synced: totalSynced, counters }, "Batch state recovered, still processing");
            }

            this.stats.batchesRecovered++;
          } else {
            // No Dragonfly state - reset to queued so it gets reprocessed
            log.system.warn({ batchId: batch.id }, "No Dragonfly state found, resetting batch to queued");
            await db
              .update(batches)
              .set({
                status: "queued",
                updatedAt: new Date(),
              })
              .where(eq(batches.id, batch.id));
            this.stats.batchesRecovered++;
          }
        } catch (error) {
          log.system.error({ error, batchId: batch.id }, "Failed to recover stuck batch");
          this.stats.errors++;
        }
      }
    } catch (error) {
      log.system.error({ error }, "PostgresSyncService crash recovery failed");
      this.stats.errors++;
    }
  }

  /**
   * Stop the sync service (syncs remaining state)
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    // Run final sync cycle
    await this.runSyncCycle();

    log.system.info(
      {
        totalSyncCycles: this.stats.syncCycles,
        totalRecipientsSynced: this.stats.recipientsSynced,
        totalBatchesCompleted: this.stats.batchesCompleted,
        totalErrors: this.stats.errors,
      },
      "PostgresSyncService stopped"
    );
  }

  /**
   * Run a single sync cycle
   */
  private async runSyncCycle(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const hotState = getHotStateManager();
      const activeBatchIds = await hotState.getActiveBatchIds();

      for (const batchId of activeBatchIds) {
        if (this.isShuttingDown) {
          // On shutdown, try to sync all batches
          await this.syncBatch(batchId, hotState);
        } else {
          // Normal operation: sync each batch
          try {
            await this.syncBatch(batchId, hotState);
          } catch (error) {
            log.system.error({ error, batchId }, "PostgresSyncService failed to sync batch");
            this.stats.errors++;
          }
        }
      }

      this.stats.syncCycles++;
      this.stats.lastSyncTime = Date.now();
      this.stats.lastSyncDuration = Date.now() - startTime;

      if (activeBatchIds.length > 0) {
        log.system.debug(
          {
            batchesSynced: activeBatchIds.length,
            duration: this.stats.lastSyncDuration,
          },
          "PostgresSyncService cycle completed"
        );
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Sync a single batch from Dragonfly to PostgreSQL
   * Tracks in-flight batches for crash recovery visibility
   */
  private async syncBatch(batchId: string, hotState: ReturnType<typeof getHotStateManager>): Promise<void> {
    // Track this batch as in-flight
    this.batchesInFlight.add(batchId);

    try {
      // 1. Get pending sync recipients
      const pendingRecipientIds = await hotState.getPendingSyncRecipients(
        batchId,
        this.config.maxRecipientsPerSync
      );

      if (pendingRecipientIds.length === 0) {
        // No pending syncs, but check if we should mark batch complete
        await this.checkAndCompleteBatch(batchId, hotState);
        return;
      }

      // 2. Get recipient states from Dragonfly
      const recipientStates = await hotState.getRecipientStates(batchId, pendingRecipientIds);

      // 3. Bulk update PostgreSQL
      const syncedIds = await this.bulkUpdateRecipients(batchId, recipientStates);

      // 4. Mark synced in Dragonfly
      if (syncedIds.length > 0) {
        await hotState.markSynced(batchId, syncedIds);
        this.stats.recipientsSynced += syncedIds.length;
      }

      // 5. Sync counters and check completion
      await this.syncCounters(batchId, hotState);
      await this.checkAndCompleteBatch(batchId, hotState);
    } finally {
      this.batchesInFlight.delete(batchId);
    }
  }

  /**
   * Bulk update recipient statuses in PostgreSQL
   * Uses efficient SQL CASE expressions for true bulk updates
   */
  private async bulkUpdateRecipients(
    batchId: string,
    states: Map<string, RecipientState>
  ): Promise<string[]> {
    if (states.size === 0) {
      return [];
    }

    const syncedIds: string[] = [];

    // Group by status using domain layer function for efficient bulk updates
    const { sent: sentRecipients, failed: failedRecipients } = groupRecipientsByStatus(states);

    try {
      // Bulk update sent recipients using json_to_recordset (safe from SQL injection)
      // This approach passes a single JSON parameter that PostgreSQL unpacks into rows
      if (sentRecipients.length > 0) {
        const sentData = sentRecipients.map((r) => ({
          id: r.id,
          sent_at: r.sentAt.toISOString(),
          provider_message_id: r.providerMessageId,
        }));
        const sentJson = JSON.stringify(sentData);

        await db.execute(sql`
          UPDATE recipients AS r SET
            status = 'sent',
            sent_at = v.sent_at,
            provider_message_id = v.provider_message_id,
            updated_at = NOW()
          FROM json_to_recordset(${sentJson}::json) AS v(id uuid, sent_at timestamp, provider_message_id text)
          WHERE r.id = v.id
        `);

        syncedIds.push(...sentRecipients.map((r) => r.id));
      }

      // Bulk update failed recipients using json_to_recordset
      if (failedRecipients.length > 0) {
        const failedData = failedRecipients.map((r) => ({
          id: r.id,
          error_message: r.errorMessage,
        }));
        const failedJson = JSON.stringify(failedData);

        await db.execute(sql`
          UPDATE recipients AS r SET
            status = 'failed',
            error_message = v.error_message,
            updated_at = NOW()
          FROM json_to_recordset(${failedJson}::json) AS v(id uuid, error_message text)
          WHERE r.id = v.id
        `);

        syncedIds.push(...failedRecipients.map((r) => r.id));
      }

      return syncedIds;
    } catch (error) {
      log.system.error({ error, batchId, count: states.size }, "PostgresSyncService bulk update failed");
      throw error;
    }
  }

  /**
   * Sync batch counters from Dragonfly to PostgreSQL
   */
  private async syncCounters(batchId: string, hotState: ReturnType<typeof getHotStateManager>): Promise<void> {
    const counters = await hotState.getCounters(batchId);
    if (!counters) {
      return;
    }

    try {
      await db
        .update(batches)
        .set({
          sentCount: counters.sent,
          failedCount: counters.failed,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batchId));
    } catch (error) {
      log.system.error({ error, batchId }, "PostgresSyncService counter sync failed");
      // Don't throw - counter sync failures are recoverable
    }
  }

  /**
   * Check if batch is complete and update PostgreSQL status
   *
   * Note: Completion is based solely on Dragonfly counters (sent + failed >= total).
   * We do NOT wait for pending syncs to complete - background sync will continue
   * processing recipients after the batch is marked complete. This prevents a race
   * condition at high throughput where recipients are added faster than sync can process.
   */
  private async checkAndCompleteBatch(
    batchId: string,
    hotState: ReturnType<typeof getHotStateManager>
  ): Promise<void> {
    const isComplete = await hotState.isBatchComplete(batchId);
    if (!isComplete) {
      return;
    }

    try {
      // Check current status in PostgreSQL
      const batch = await db.query.batches.findFirst({
        where: eq(batches.id, batchId),
        columns: { status: true },
      });

      if (batch && batch.status !== "completed") {
        // Mark batch as completed
        await db
          .update(batches)
          .set({
            status: "completed",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(batches.id, batchId));

        // Update Dragonfly TTL
        await hotState.markBatchCompleted(batchId);

        // Record metric
        batchesProcessedTotal.inc({ status: "completed" });

        this.stats.batchesCompleted++;
        log.batch.info({ id: batchId }, "completed (via sync service)");
      }
    } catch (error) {
      log.system.error({ error, batchId }, "PostgresSyncService failed to complete batch");
      this.stats.errors++;
    }
  }

  /**
   * Get service statistics
   */
  getStats(): typeof this.stats & { isRunning: boolean; batchesInFlight: string[] } {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      batchesInFlight: Array.from(this.batchesInFlight),
    };
  }

  /**
   * Force a sync cycle (for testing/debugging)
   */
  async forceSync(): Promise<void> {
    await this.runSyncCycle();
  }
}

// Singleton instance
let postgresSyncService: PostgresSyncService | null = null;

/**
 * Get or create the singleton PostgresSyncService instance
 */
export function getPostgresSyncService(config?: PostgresSyncConfig): PostgresSyncService {
  if (!postgresSyncService) {
    postgresSyncService = new PostgresSyncService(config);
  }
  return postgresSyncService;
}
