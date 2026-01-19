import { sql, eq, inArray } from "drizzle-orm";
import { recipients, batches } from "@batchsender/db";
import { db } from "../db.js";
import { WebhookEvent } from "./queue-processor.js";
import { getHotStateManager } from "../hot-state-manager.js";
import { log, createTimer } from "../logger.js";

export interface UpdateResult {
  recipientsUpdated: number;
  batchesUpdated: number;
  errors: number;
}

/**
 * Handles efficient batch database updates for webhook events
 * Implements idempotent updates with strong consistency
 */
export class DatabaseBatchUpdater {
  private updateStats = {
    totalRecipientUpdates: 0,
    totalBatchUpdates: 0,
    failedUpdates: 0,
  };

  /**
   * Process delivery events in batch
   */
  async processDeliveries(events: WebhookEvent[]): Promise<UpdateResult> {
    const timer = createTimer();
    const result: UpdateResult = {
      recipientsUpdated: 0,
      batchesUpdated: 0,
      errors: 0,
    };

    try {
      // Filter events with recipient IDs
      const validEvents = events.filter(e => e.recipientId);
      if (validEvents.length === 0) return result;

      const recipientIds = validEvents.map(e => e.recipientId!);

      // Batch update recipients with idempotency check
      const updateResult = await db
        .update(recipients)
        .set({
          status: "delivered",
          deliveredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(sql`
          ${recipients.id} IN (${sql.join(recipientIds, sql`, `)})
          AND ${recipients.status} = 'sent'
        `);

      result.recipientsUpdated = updateResult.rowCount || 0;
      this.updateStats.totalRecipientUpdates += result.recipientsUpdated;

      // Update batch counters
      await this.updateBatchCounters(validEvents, "delivered", result);

      log.webhook.debug({
        events: validEvents.length,
        recipientsUpdated: result.recipientsUpdated,
        batchesUpdated: result.batchesUpdated,
        duration: timer(),
      }, "Processed delivery events");

      return result;
    } catch (error) {
      result.errors = events.length;
      this.updateStats.failedUpdates += result.errors;
      log.webhook.error({ error }, "Failed to process delivery events");
      throw error;
    }
  }

  /**
   * Process bounce events in batch
   */
  async processBounces(events: WebhookEvent[]): Promise<UpdateResult> {
    const timer = createTimer();
    const result: UpdateResult = {
      recipientsUpdated: 0,
      batchesUpdated: 0,
      errors: 0,
    };

    try {
      const validEvents = events.filter(e => e.recipientId);
      if (validEvents.length === 0) return result;

      const recipientIds = validEvents.map(e => e.recipientId!);

      // Batch update recipients
      const updateResult = await db
        .update(recipients)
        .set({
          status: "bounced",
          bouncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(sql`
          ${recipients.id} IN (${sql.join(recipientIds, sql`, `)})
          AND ${recipients.status} = 'sent'
        `);

      result.recipientsUpdated = updateResult.rowCount || 0;
      this.updateStats.totalRecipientUpdates += result.recipientsUpdated;

      // Update batch counters
      await this.updateBatchCounters(validEvents, "bounced", result);

      log.webhook.debug({
        events: validEvents.length,
        recipientsUpdated: result.recipientsUpdated,
        batchesUpdated: result.batchesUpdated,
        duration: timer(),
      }, "Processed bounce events");

      return result;
    } catch (error) {
      result.errors = events.length;
      this.updateStats.failedUpdates += result.errors;
      log.webhook.error({ error }, "Failed to process bounce events");
      throw error;
    }
  }

  /**
   * Process failure events in batch
   */
  async processFailures(events: WebhookEvent[]): Promise<UpdateResult> {
    const timer = createTimer();
    const result: UpdateResult = {
      recipientsUpdated: 0,
      batchesUpdated: 0,
      errors: 0,
    };

    try {
      const validEvents = events.filter(e => e.recipientId);
      if (validEvents.length === 0) return result;

      const recipientIds = validEvents.map(e => e.recipientId!);

      // Batch update recipients
      const updateResult = await db
        .update(recipients)
        .set({
          status: "failed",
          updatedAt: new Date(),
        })
        .where(sql`
          ${recipients.id} IN (${sql.join(recipientIds, sql`, `)})
          AND ${recipients.status} = 'sent'
        `);

      result.recipientsUpdated = updateResult.rowCount || 0;
      this.updateStats.totalRecipientUpdates += result.recipientsUpdated;

      // Update batch counters
      await this.updateBatchCounters(validEvents, "failed", result);

      log.webhook.debug({
        events: validEvents.length,
        recipientsUpdated: result.recipientsUpdated,
        batchesUpdated: result.batchesUpdated,
        duration: timer(),
      }, "Processed failure events");

      return result;
    } catch (error) {
      result.errors = events.length;
      this.updateStats.failedUpdates += result.errors;
      log.webhook.error({ error }, "Failed to process failure events");
      throw error;
    }
  }

  /**
   * Process other event types (complained, opened, clicked)
   */
  async processOtherEvents(events: WebhookEvent[]): Promise<UpdateResult> {
    const timer = createTimer();
    const result: UpdateResult = {
      recipientsUpdated: 0,
      batchesUpdated: 0,
      errors: 0,
    };

    try {
      // Group by event type
      const complainedEvents = events.filter(e => e.eventType === "complained" && e.recipientId);

      // Update complained recipients
      if (complainedEvents.length > 0) {
        const recipientIds = complainedEvents.map(e => e.recipientId!);

        const updateResult = await db
          .update(recipients)
          .set({
            status: "complained",
            updatedAt: new Date(),
          })
          .where(inArray(recipients.id, recipientIds));

        result.recipientsUpdated += updateResult.rowCount || 0;
        this.updateStats.totalRecipientUpdates += updateResult.rowCount || 0;
      }

      // For opened/clicked events, we don't update recipient status
      // These are already logged to ClickHouse for analytics

      log.webhook.debug({
        events: events.length,
        recipientsUpdated: result.recipientsUpdated,
        duration: timer(),
      }, "Processed other events");

      return result;
    } catch (error) {
      result.errors = events.length;
      this.updateStats.failedUpdates += result.errors;
      log.webhook.error({ error }, "Failed to process other events");
      throw error;
    }
  }

  /**
   * Update batch counters efficiently
   */
  private async updateBatchCounters(
    events: WebhookEvent[],
    counterType: "delivered" | "bounced" | "failed",
    result: UpdateResult
  ): Promise<void> {
    // Group events by batch ID
    const batchCounts = new Map<string, number>();

    for (const event of events) {
      if (event.batchId) {
        batchCounts.set(event.batchId, (batchCounts.get(event.batchId) || 0) + 1);
      }
    }

    // Update each batch
    for (const [batchId, count] of batchCounts) {
      try {
        // Determine which counter to update
        let updateQuery;
        switch (counterType) {
          case "delivered":
            updateQuery = db
              .update(batches)
              .set({
                deliveredCount: sql`LEAST(${batches.deliveredCount} + ${count}, ${batches.totalRecipients})`,
                updatedAt: new Date(),
              })
              .where(eq(batches.id, batchId));
            break;
          case "bounced":
            updateQuery = db
              .update(batches)
              .set({
                bouncedCount: sql`LEAST(${batches.bouncedCount} + ${count}, ${batches.totalRecipients})`,
                updatedAt: new Date(),
              })
              .where(eq(batches.id, batchId));
            break;
          case "failed":
            updateQuery = db
              .update(batches)
              .set({
                failedCount: sql`LEAST(${batches.failedCount} + ${count}, ${batches.totalRecipients})`,
                updatedAt: new Date(),
              })
              .where(eq(batches.id, batchId));
            break;
        }

        const updateResult = await updateQuery;
        if (updateResult.rowCount && updateResult.rowCount > 0) {
          result.batchesUpdated++;
          this.updateStats.totalBatchUpdates++;
        }

        // Check if batch is complete using hot state
        await this.checkBatchCompletion(batchId);
      } catch (error) {
        log.webhook.error({ error, batchId }, "Failed to update batch counter");
        // Continue with other batches
      }
    }
  }

  /**
   * Check if a batch is complete and update status
   */
  private async checkBatchCompletion(batchId: string): Promise<void> {
    const hotState = getHotStateManager();

    try {
      const isComplete = await hotState.isBatchComplete(batchId);
      if (isComplete) {
        // Update batch status to completed
        await db
          .update(batches)
          .set({
            status: "completed",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(batches.id, batchId));

        await hotState.markBatchCompleted(batchId);
        log.batch.info({ id: batchId }, "Batch completed via webhook");
      }
    } catch (error) {
      // Hot state unavailable, skip completion check
      log.webhook.debug({ batchId, error }, "Hot state unavailable for completion check");
    }
  }

  /**
   * Get update statistics
   */
  getStats() {
    return {
      ...this.updateStats,
      successRate: this.updateStats.totalRecipientUpdates /
        (this.updateStats.totalRecipientUpdates + this.updateStats.failedUpdates) || 0,
    };
  }

  /**
   * Reset statistics (for testing)
   */
  resetStats(): void {
    this.updateStats = {
      totalRecipientUpdates: 0,
      totalBatchUpdates: 0,
      failedUpdates: 0,
    };
  }
}