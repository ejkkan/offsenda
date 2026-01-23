import { WebhookEvent } from "./queue-processor.js";
import { WebhookDeduplicator } from "./webhook-deduplicator.js";
import { WebhookEnricher } from "./webhook-enricher.js";
import { DatabaseBatchUpdater } from "./database-batch-updater.js";
import { log, createTimer } from "../logger.js";
import { getBufferedLogger } from "../buffered-logger.js";
import type { ModuleType } from "../clickhouse.js";
import {
  webhooksProcessedTotal,
  webhooksErrorsTotal,
  webhookBatchSize,
  webhookProcessingDuration,
} from "../metrics.js";

export interface ProcessingResult {
  processed: number;
  duplicates: number;
  errors: number;
  /** Formatted duration string (e.g., "100ms", "1.5s") */
  duration: string;
}

/**
 * Orchestrates the processing of webhook batches
 * Coordinates deduplication, enrichment, and database updates
 */
export class WebhookBatchProcessor {
  constructor(
    private deduplicator: WebhookDeduplicator,
    private enricher: WebhookEnricher,
    private dbUpdater: DatabaseBatchUpdater
  ) {}

  /**
   * Process a batch of webhook events
   */
  async processBatch(events: WebhookEvent[]): Promise<ProcessingResult> {
    const timer = createTimer();
    const processingTimer = webhookProcessingDuration.startTimer();

    const result: ProcessingResult = {
      processed: 0,
      duplicates: 0,
      errors: 0,
      duration: "",
    };

    try {
      log.webhook.info({ batchSize: events.length }, "Processing webhook batch");
      webhookBatchSize.observe(events.length);

      // Step 1: Deduplication
      const dedupResult = await this.deduplicator.deduplicateBatch(events);
      result.duplicates = dedupResult.stats.duplicates;

      if (dedupResult.stats.duplicates > 0) {
        log.webhook.info({
          total: events.length,
          duplicates: dedupResult.stats.duplicates,
          new: dedupResult.stats.new,
        }, "Deduplication complete");
      }

      // If no new events, we're done
      if (dedupResult.newEvents.length === 0) {
        result.duration = timer();
        processingTimer({ status: "success" });
        return result;
      }

      // Step 2: Enrich events with recipient information
      const enrichResult = await this.enricher.enrichBatch(dedupResult.newEvents);

      // Step 3: Group events by type
      const groupedEvents = this.groupEventsByType(enrichResult.enrichedEvents);

      // Step 4: Process each group
      const updatePromises = [];

      if (groupedEvents.deliveries.length > 0) {
        updatePromises.push(
          this.dbUpdater.processDeliveries(groupedEvents.deliveries)
        );
      }

      if (groupedEvents.bounces.length > 0) {
        updatePromises.push(
          this.dbUpdater.processBounces(groupedEvents.bounces)
        );
      }

      if (groupedEvents.failures.length > 0) {
        updatePromises.push(
          this.dbUpdater.processFailures(groupedEvents.failures)
        );
      }

      if (groupedEvents.others.length > 0) {
        updatePromises.push(
          this.dbUpdater.processOtherEvents(groupedEvents.others)
        );
      }

      // Wait for all database updates
      await Promise.all(updatePromises);

      // Step 5: Log to ClickHouse
      await this.logToClickHouse(enrichResult.enrichedEvents);

      // Step 6: Mark events as processed (AFTER successful DB updates)
      // This ensures we don't lose events if DB update fails
      this.deduplicator.markProcessed(enrichResult.enrichedEvents);

      // Step 7: Update metrics
      for (const event of enrichResult.enrichedEvents) {
        webhooksProcessedTotal.inc({
          provider: event.provider,
          event_type: event.eventType,
          status: "success",
        });
      }

      result.processed = enrichResult.enrichedEvents.length;
      result.duration = timer();
      processingTimer({ status: "success" });

      log.webhook.info({
        batchSize: events.length,
        processed: result.processed,
        duplicates: result.duplicates,
        enriched: enrichResult.stats.enriched,
        duration: result.duration,
      }, "Webhook batch processed successfully");

      return result;
    } catch (error) {
      result.duration = timer();
      result.errors = events.length - result.processed;
      processingTimer({ status: "error" });
      webhooksErrorsTotal.inc({ error_type: "batch_processing_error" });

      log.webhook.error({
        error,
        batchSize: events.length,
        processed: result.processed,
      }, "Failed to process webhook batch");

      throw error;
    }
  }

  /**
   * Group events by type for efficient processing
   */
  private groupEventsByType(events: WebhookEvent[]) {
    const deliveries = events.filter(e =>
      e.eventType === "delivered" || e.eventType === "sms.delivered"
    );

    const bounces = events.filter(e =>
      e.eventType === "bounced" || e.eventType === "soft_bounced"
    );

    const failures = events.filter(e =>
      e.eventType === "failed" || e.eventType === "sms.failed"
    );

    const others = events.filter(e =>
      !["delivered", "sms.delivered", "bounced", "soft_bounced", "failed", "sms.failed"]
        .includes(e.eventType)
    );

    return {
      deliveries,
      bounces,
      failures,
      others,
    };
  }

  /**
   * Log events to ClickHouse
   */
  private async logToClickHouse(events: WebhookEvent[]): Promise<void> {
    const clickhouseEvents = events.map(event => ({
      event_type: event.eventType,
      module_type: (event.provider === "telnyx" || event.provider === "twilio" ? "sms" : "email") as ModuleType,
      batch_id: event.batchId || "",
      recipient_id: event.recipientId || "",
      user_id: event.userId || "",
      email: event.metadata?.email || event.metadata?.to || "",
      provider_message_id: event.providerMessageId,
      metadata: event.metadata,
    }));

    getBufferedLogger().logEvents(clickhouseEvents);
  }

  /**
   * Get processing statistics
   */
  getStats() {
    return {
      deduplicatorStats: this.deduplicator.getStats(),
      enricherStats: this.enricher.getStats(),
    };
  }
}