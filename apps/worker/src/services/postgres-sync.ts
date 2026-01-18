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

import { eq, inArray, sql } from "drizzle-orm";
import { recipients, batches } from "@batchsender/db";
import { db } from "../db.js";
import { getHotStateManager, type RecipientState } from "../hot-state-manager.js";
import { log } from "../logger.js";
import { batchesProcessedTotal } from "../metrics.js";

export interface PostgresSyncConfig {
  /** Sync interval in milliseconds (default: 2000) */
  syncIntervalMs?: number;
  /** Maximum recipients to sync per batch per cycle (default: 1000) */
  maxRecipientsPerSync?: number;
  /** Whether to enable the service (default: true) */
  enabled?: boolean;
}

const DEFAULT_CONFIG: Required<PostgresSyncConfig> = {
  syncIntervalMs: 2000,
  maxRecipientsPerSync: 1000,
  enabled: true,
};

export class PostgresSyncService {
  private config: Required<PostgresSyncConfig>;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isShuttingDown = false;
  private stats = {
    syncCycles: 0,
    recipientsSynced: 0,
    batchesCompleted: 0,
    errors: 0,
    lastSyncTime: 0,
    lastSyncDuration: 0,
  };

  constructor(config?: PostgresSyncConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the sync service
   */
  start(): void {
    if (!this.config.enabled) {
      log.system.info({}, "PostgresSyncService disabled");
      return;
    }

    if (this.syncInterval) {
      return; // Already running
    }

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
   */
  private async syncBatch(batchId: string, hotState: ReturnType<typeof getHotStateManager>): Promise<void> {
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

    // Group by status for efficient bulk updates
    const sentRecipients: Array<{ id: string; sentAt: Date; providerMessageId: string }> = [];
    const failedRecipients: Array<{ id: string; errorMessage: string }> = [];

    for (const [recipientId, state] of states) {
      if (state.status === "sent") {
        sentRecipients.push({
          id: recipientId,
          sentAt: state.sentAt ? new Date(state.sentAt) : new Date(),
          providerMessageId: state.providerMessageId || "",
        });
      } else if (state.status === "failed") {
        failedRecipients.push({
          id: recipientId,
          errorMessage: state.errorMessage || "",
        });
      }
    }

    try {
      // Bulk update sent recipients using SQL CASE for efficient single-query update
      if (sentRecipients.length > 0) {
        const sentIds = sentRecipients.map((r) => r.id);

        // Build CASE expressions for varying fields
        const sentAtCases = sentRecipients
          .map((r) => `WHEN id = '${r.id}' THEN '${r.sentAt.toISOString()}'::timestamp`)
          .join(" ");
        const providerMessageIdCases = sentRecipients
          .map((r) => `WHEN id = '${r.id}' THEN '${r.providerMessageId.replace(/'/g, "''")}'`)
          .join(" ");
        const idList = sentIds.map((id) => `'${id}'`).join(",");

        // Single query to update all sent recipients with their individual values
        await db.execute(sql`
          UPDATE recipients SET
            status = 'sent',
            sent_at = CASE ${sql.raw(sentAtCases)} END,
            provider_message_id = CASE ${sql.raw(providerMessageIdCases)} END,
            updated_at = NOW()
          WHERE id IN (${sql.raw(idList)})
        `);

        syncedIds.push(...sentIds);
      }

      // Bulk update failed recipients using SQL CASE
      if (failedRecipients.length > 0) {
        const failedIds = failedRecipients.map((r) => r.id);

        // Build CASE expression for error messages
        const errorCases = failedRecipients
          .map((r) => `WHEN id = '${r.id}' THEN '${r.errorMessage.replace(/'/g, "''")}'`)
          .join(" ");
        const idList = failedIds.map((id) => `'${id}'`).join(",");

        // Single query to update all failed recipients
        await db.execute(sql`
          UPDATE recipients SET
            status = 'failed',
            error_message = CASE ${sql.raw(errorCases)} END,
            updated_at = NOW()
          WHERE id IN (${sql.raw(idList)})
        `);

        syncedIds.push(...failedIds);
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
   */
  private async checkAndCompleteBatch(
    batchId: string,
    hotState: ReturnType<typeof getHotStateManager>
  ): Promise<void> {
    const isComplete = await hotState.isBatchComplete(batchId);
    if (!isComplete) {
      return;
    }

    // Check if there are still pending syncs
    const pendingIds = await hotState.getPendingSyncRecipients(batchId, 1);
    if (pendingIds.length > 0) {
      // Still have pending syncs, don't mark complete yet
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
  getStats(): typeof this.stats & { isRunning: boolean } {
    return {
      ...this.stats,
      isRunning: this.isRunning,
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
