import { JsMsg, StringCodec, DeliverPolicy, AckPolicy } from "nats";
import { eq, sql, inArray } from "drizzle-orm";
import { recipients, batches } from "@batchsender/db";
import { db } from "../db.js";
import { config } from "../config.js";
import { NatsClient } from "./client.js";
import { log, createTimer, withTraceAsync } from "../logger.js";
import { WebhookEvent } from "../webhooks/queue-processor.js";
import { logEventBuffered, getBufferedLogger } from "../buffered-logger.js";
import { getHotStateManager } from "../hot-state-manager.js";
import { calculateNatsBackoff } from "../domain/utils/backoff.js";
import { getCacheService } from "../services/cache-service.js";
import { lookupByProviderMessageId, type ModuleType } from "../clickhouse.js";
import { getWebhookMatcher } from "../services/webhook-matcher.js";
import {
  webhooksReceivedTotal,
  webhooksProcessedTotal,
  webhooksErrorsTotal,
  webhookBatchSize,
  webhookProcessingDuration,
  webhookQueueDepth,
} from "../metrics.js";

interface WebhookBatch {
  events: WebhookEvent[];
  processedAt?: Date;
}

/**
 * NATS-based webhook processor that handles webhooks in batches
 * for improved performance and reduced database load
 */
export class NatsWebhookWorker {
  private sc = StringCodec();
  private eventBuffer: WebhookEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isShuttingDown = false;
  private consumerPromise: Promise<void> | null = null;
  private consumerMessages: { stop(): void } | null = null;

  // Track pending messages for ACK after batch completion
  private pendingMessages: Map<string, JsMsg> = new Map();

  // Configuration
  private readonly batchSize = config.WEBHOOK_BATCH_SIZE || 100;
  private readonly flushIntervalMs = config.WEBHOOK_FLUSH_INTERVAL || 1000;

  constructor(private natsClient: NatsClient) {}

  /**
   * Start processing webhook events from NATS
   */
  async startWebhookProcessor(): Promise<void> {
    // Reset shutdown state to allow restart
    this.isShuttingDown = false;

    const js = this.natsClient.getJetStream();

    try {
      // Create or recreate consumer if needed
      const jsm = this.natsClient.getJetStreamManager();
      try {
        const consumerInfo = await jsm.consumers.info("webhooks", "webhook-processor");
        // Check if it's a push consumer (has deliver_subject) - if so, delete and recreate
        if (consumerInfo.config.deliver_subject) {
          log.system.warn("Found push consumer, deleting to recreate as pull consumer");
          await jsm.consumers.delete("webhooks", "webhook-processor");
          throw new Error("recreate"); // Trigger recreation
        }
      } catch (error) {
        // Consumer doesn't exist or needs recreation, create it as pull consumer
        await jsm.consumers.add("webhooks", {
          name: "webhook-processor",
          filter_subject: "webhook.>",
          deliver_policy: DeliverPolicy.All,
          ack_policy: AckPolicy.Explicit,
          max_deliver: 3,
          ack_wait: 30_000, // 30 seconds to process
          max_ack_pending: 1000,
        });
        log.system.info("Created webhook-processor consumer (pull mode)");
      }

      const consumer = await js.consumers.get("webhooks", "webhook-processor");
      const messages = await consumer.consume({
        max_messages: 1000 // Process up to 1000 messages concurrently
      });

      // Store reference for shutdown
      this.consumerMessages = messages;

      log.system.info("Webhook processor started");

      // Track the consumer promise
      this.consumerPromise = this.processMessages(messages);
      await this.consumerPromise;
    } catch (error) {
      const errorDetails = error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : { raw: String(error), type: typeof error };
      log.system.error({ error: errorDetails }, "Webhook processor error");
      throw error;
    }
  }

  private async processMessages(messages: AsyncIterable<JsMsg>): Promise<void> {
    for await (const msg of messages) {
      if (this.isShuttingDown) break;

      const timer = createTimer();

      try {
        const event = JSON.parse(this.sc.decode(msg.data)) as WebhookEvent;

        webhooksReceivedTotal.inc({
          provider: event.provider,
          event_type: event.eventType
        });

        // Add to buffer and track pending message for later ACK
        this.eventBuffer.push(event);
        this.pendingMessages.set(event.id, msg);
        webhookQueueDepth.set(this.eventBuffer.length);

        // Process batch if full
        if (this.eventBuffer.length >= this.batchSize) {
          await this.processBatch();
        } else {
          // Schedule flush if not already scheduled
          this.scheduleFlush();
        }

        // Note: Message ACK/NAK now happens in processBatch() after successful/failed completion

        log.webhook.debug({
          provider: event.provider,
          eventType: event.eventType,
          messageId: event.providerMessageId,
          bufferSize: this.eventBuffer.length,
          duration: timer(),
        }, "webhook buffered");
      } catch (error) {
        log.webhook.error({ error }, "Failed to process webhook message");
        msg.nak(calculateNatsBackoff(msg.info.redeliveryCount));
        webhooksErrorsTotal.inc({ error_type: "processing_error" });
      }
    }
  }

  /**
   * Schedule a batch flush
   */
  private scheduleFlush(): void {
    if (this.flushTimer || this.isShuttingDown) return;

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      if (this.eventBuffer.length > 0 && !this.isShuttingDown) {
        await this.processBatch();
      }
    }, this.flushIntervalMs);
  }

  /**
   * Process a batch of webhook events
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessing || this.eventBuffer.length === 0 || this.isShuttingDown) return;

    this.isProcessing = true;
    const batch = [...this.eventBuffer];
    this.eventBuffer = [];
    webhookQueueDepth.set(0);

    const timer = webhookProcessingDuration.startTimer();

    try {
      log.webhook.info({ batchSize: batch.length }, "Processing webhook batch");
      webhookBatchSize.observe(batch.length);

      // Deduplication check using cache
      const cacheService = getCacheService();
      const dedupChecks = batch.map(e => ({
        provider: e.provider,
        messageId: e.providerMessageId,
        eventType: e.eventType
      }));

      const processedMap = await cacheService.batchCheckWebhooksProcessed(dedupChecks);

      // Filter out already processed webhooks
      const newEvents: WebhookEvent[] = [];
      const duplicateEvents: WebhookEvent[] = [];

      for (const event of batch) {
        const key = `${event.provider}:${event.providerMessageId}:${event.eventType}`;
        if (processedMap.get(key)) {
          duplicateEvents.push(event);
          log.webhook.debug({
            provider: event.provider,
            messageId: event.providerMessageId,
            eventType: event.eventType
          }, "Webhook already processed (cache dedup)");
        } else {
          newEvents.push(event);
        }
      }

      if (duplicateEvents.length > 0) {
        log.webhook.info({
          total: batch.length,
          duplicates: duplicateEvents.length,
          new: newEvents.length
        }, "Deduplication check complete");

        // ACK duplicate events - they're already processed
        for (const event of duplicateEvents) {
          const msg = this.pendingMessages.get(event.id);
          if (msg) {
            msg.ack();
            this.pendingMessages.delete(event.id);
          }
        }
      }

      // If no new events, skip processing
      if (newEvents.length === 0) {
        timer({ status: "success" });
        return;
      }

      // Process events that need recipient lookups
      await this.enrichEventsWithRecipientInfo(newEvents);

      // Group events by type for efficient processing
      const deliveryEvents = newEvents.filter(e =>
        e.eventType === "delivered" || e.eventType === "sms.delivered"
      );
      const bounceEvents = newEvents.filter(e =>
        e.eventType === "bounced" || e.eventType === "soft_bounced"
      );
      const failureEvents = newEvents.filter(e =>
        e.eventType === "failed" || e.eventType === "sms.failed"
      );
      const otherEvents = newEvents.filter(e =>
        !["delivered", "sms.delivered", "bounced", "soft_bounced", "failed", "sms.failed"].includes(e.eventType)
      );

      // Batch update recipients and batches
      const updates: Promise<any>[] = [];

      // Process deliveries
      if (deliveryEvents.length > 0) {
        updates.push(this.processDeliveryBatch(deliveryEvents));
      }

      // Process bounces
      if (bounceEvents.length > 0) {
        updates.push(this.processBounceBatch(bounceEvents));
      }

      // Process failures
      if (failureEvents.length > 0) {
        updates.push(this.processFailureBatch(failureEvents));
      }

      // Process other events (opened, clicked, complained, etc.)
      if (otherEvents.length > 0) {
        updates.push(this.processOtherEventsBatch(otherEvents));
      }

      // Execute all updates in parallel
      await Promise.all(updates);

      // Mark events as processed in cache (AFTER successful DB updates)
      const markPromises = newEvents.map(e =>
        cacheService.markWebhookProcessed(
          e.provider,
          e.providerMessageId,
          e.eventType
        )
      );
      await Promise.all(markPromises).catch(err =>
        log.webhook.debug({ error: err }, "Failed to mark some webhooks as processed")
      );

      // Batch log to ClickHouse
      const clickhouseEvents = newEvents.map(event => ({
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

      // Update metrics
      for (const event of newEvents) {
        webhooksProcessedTotal.inc({
          provider: event.provider,
          event_type: event.eventType,
          status: "success"
        });
      }

      // ACK all successfully processed messages
      for (const event of newEvents) {
        const msg = this.pendingMessages.get(event.id);
        if (msg) {
          msg.ack();
          this.pendingMessages.delete(event.id);
        }
      }

      timer({ status: "success" });

      log.webhook.info({
        batchSize: batch.length,
        deliveries: deliveryEvents.length,
        bounces: bounceEvents.length,
        failures: failureEvents.length,
        others: otherEvents.length,
      }, "Webhook batch processed");
    } catch (error) {
      timer({ status: "error" });
      webhooksErrorsTotal.inc({ error_type: "batch_processing_error" });

      log.webhook.error(
        { error, batchSize: batch.length },
        "Failed to process webhook batch"
      );

      // NAK all messages in this batch so NATS can retry
      for (const event of batch) {
        const msg = this.pendingMessages.get(event.id);
        if (msg) {
          msg.nak(calculateNatsBackoff(msg.info.redeliveryCount));
          this.pendingMessages.delete(event.id);
        }
      }

      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process delivery events in batch
   */
  private async processDeliveryBatch(events: WebhookEvent[]): Promise<void> {
    const recipientIds = events
      .map(e => e.recipientId)
      .filter(Boolean) as string[];

    if (recipientIds.length === 0) return;

    // Update recipients with idempotency check
    await db
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

    // Update batch counters
    const batchCounts = new Map<string, number>();
    events.forEach(e => {
      if (e.batchId) {
        batchCounts.set(e.batchId, (batchCounts.get(e.batchId) || 0) + 1);
      }
    });

    for (const [batchId, count] of batchCounts) {
      await db
        .update(batches)
        .set({
          deliveredCount: sql`LEAST(${batches.deliveredCount} + ${count}, ${batches.totalRecipients})`,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batchId));

      // Check if batch is complete using hot state
      const hotState = getHotStateManager();
      try {
        const isComplete = await hotState.isBatchComplete(batchId);
        if (isComplete) {
          await hotState.markBatchCompleted(batchId);
          log.batch.info({ id: batchId }, "Batch completed via webhook");
        }
      } catch (error) {
        // Hot state unavailable, skip completion check
        log.webhook.debug({ batchId, error }, "Hot state unavailable for completion check");
      }
    }
  }

  /**
   * Process bounce events in batch
   */
  private async processBounceBatch(events: WebhookEvent[]): Promise<void> {
    const recipientIds = events
      .map(e => e.recipientId)
      .filter(Boolean) as string[];

    if (recipientIds.length === 0) return;

    // Update recipients with idempotency check
    await db
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

    // Update batch counters
    const batchCounts = new Map<string, number>();
    events.forEach(e => {
      if (e.batchId) {
        batchCounts.set(e.batchId, (batchCounts.get(e.batchId) || 0) + 1);
      }
    });

    for (const [batchId, count] of batchCounts) {
      await db
        .update(batches)
        .set({
          bouncedCount: sql`LEAST(${batches.bouncedCount} + ${count}, ${batches.totalRecipients})`,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batchId));
    }
  }

  /**
   * Process failure events in batch
   */
  private async processFailureBatch(events: WebhookEvent[]): Promise<void> {
    const recipientIds = events
      .map(e => e.recipientId)
      .filter(Boolean) as string[];

    if (recipientIds.length === 0) return;

    // Update recipients with idempotency check
    await db
      .update(recipients)
      .set({
        status: "failed",
        updatedAt: new Date(),
      })
      .where(sql`
        ${recipients.id} IN (${sql.join(recipientIds, sql`, `)})
        AND ${recipients.status} = 'sent'
      `);

    // Update batch counters
    const batchCounts = new Map<string, number>();
    events.forEach(e => {
      if (e.batchId) {
        batchCounts.set(e.batchId, (batchCounts.get(e.batchId) || 0) + 1);
      }
    });

    for (const [batchId, count] of batchCounts) {
      await db
        .update(batches)
        .set({
          failedCount: sql`LEAST(${batches.failedCount} + ${count}, ${batches.totalRecipients})`,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batchId));
    }
  }

  /**
   * Process other event types (opened, clicked, complained)
   */
  private async processOtherEventsBatch(events: WebhookEvent[]): Promise<void> {
    // Group by event type
    const eventsByType = new Map<string, WebhookEvent[]>();
    events.forEach(e => {
      const list = eventsByType.get(e.eventType) || [];
      list.push(e);
      eventsByType.set(e.eventType, list);
    });

    // Process complained events
    const complainedEvents = eventsByType.get("complained") || [];
    if (complainedEvents.length > 0) {
      const recipientIds = complainedEvents
        .map(e => e.recipientId)
        .filter(Boolean) as string[];

      if (recipientIds.length > 0) {
        await db
          .update(recipients)
          .set({
            status: "complained",
            updatedAt: new Date(),
          })
          .where(inArray(recipients.id, recipientIds));
      }
    }

    // For opened/clicked events, we just log to ClickHouse
    // (already handled in the main processBatch method)
  }

  /**
   * Enrich events with recipient information using webhook matcher
   */
  private async enrichEventsWithRecipientInfo(events: WebhookEvent[]): Promise<void> {
    const matcher = getWebhookMatcher();
    const eventsWithoutRecipient: WebhookEvent[] = [];

    // Use batch matching for efficiency
    const matchResults = await matcher.batchMatch(events);

    // Apply match results to events
    for (const event of events) {
      const match = matchResults.get(event.id);
      if (match) {
        event.recipientId = match.recipientId;
        event.batchId = match.batchId;
        event.userId = match.userId;

        log.webhook.debug({
          messageId: event.providerMessageId,
          recipientId: match.recipientId,
          matchType: match.matchType,
        }, "Webhook matched to recipient");
      } else {
        eventsWithoutRecipient.push(event);
      }
    }

    // Log events without recipient info
    if (eventsWithoutRecipient.length > 0) {
      log.webhook.warn({
        count: eventsWithoutRecipient.length,
        events: eventsWithoutRecipient.map(e => ({
          provider: e.provider,
          eventType: e.eventType,
          messageId: e.providerMessageId,
          metadata: e.metadata,
        })),
      }, "Events without recipient match will be skipped");
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    log.system.info({ bufferSize: this.eventBuffer.length }, "Shutting down webhook worker");

    // Clear flush timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Stop the consumer to break out of the for-await loop
    if (this.consumerMessages) {
      this.consumerMessages.stop();
      this.consumerMessages = null;
    }

    // Process remaining events
    if (this.eventBuffer.length > 0) {
      log.system.info({ bufferSize: this.eventBuffer.length }, "Processing remaining webhook events");
      await this.processBatch();
    }

    // Wait for consumer to finish
    if (this.consumerPromise) {
      await this.consumerPromise;
      this.consumerPromise = null;
    }

    log.system.info("Webhook worker shutdown complete");
  }
}