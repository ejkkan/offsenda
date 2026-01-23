import { JsMsg, StringCodec, DeliverPolicy, AckPolicy } from "nats";
import { config } from "../config.js";
import { NatsClient } from "./client.js";
import { log } from "../logger.js";
import { WebhookEvent } from "../webhooks/queue-processor.js";
import { EventBuffer } from "../webhooks/event-buffer.js";
import { WebhookDeduplicator } from "../webhooks/webhook-deduplicator.js";
import { WebhookEnricher } from "../webhooks/webhook-enricher.js";
import { WebhookBatchProcessor } from "../webhooks/webhook-batch-processor.js";
import { DatabaseBatchUpdater } from "../webhooks/database-batch-updater.js";
import { getCacheService } from "../services/cache-service.js";
import { calculateNatsBackoff } from "../domain/utils/backoff.js";
import {
  webhooksReceivedTotal,
  webhooksErrorsTotal,
  webhookQueueDepth,
} from "../metrics.js";

/**
 * Refactored NATS-based webhook processor using modular components
 * for better testability and separation of concerns
 */
export class NatsWebhookWorkerRefactored {
  private sc = StringCodec();
  private isShuttingDown = false;
  private consumerPromise: Promise<void> | null = null;

  // Modular components
  private eventBuffer: EventBuffer;
  private batchProcessor: WebhookBatchProcessor;

  constructor(private natsClient: NatsClient) {
    // Initialize components
    const cacheService = getCacheService();
    const deduplicator = new WebhookDeduplicator(cacheService);
    const enricher = new WebhookEnricher(cacheService);
    const dbUpdater = new DatabaseBatchUpdater();

    this.batchProcessor = new WebhookBatchProcessor(
      deduplicator,
      enricher,
      dbUpdater
    );

    // Initialize event buffer with batch processor
    this.eventBuffer = new EventBuffer({
      maxSize: config.WEBHOOK_BATCH_SIZE || 100,
      flushIntervalMs: config.WEBHOOK_FLUSH_INTERVAL || 1000,
      onFlush: async (events) => {
        await this.batchProcessor.processBatch(events);
      },
    });
  }

  /**
   * Start processing webhook events from NATS
   */
  async startWebhookProcessor(): Promise<void> {
    const js = this.natsClient.getJetStream();

    try {
      // Create consumer if it doesn't exist
      await this.ensureConsumer();

      const consumer = await js.consumers.get("webhooks", "webhook-processor");
      const messages = await consumer.consume({
        max_messages: 1000, // Process up to 1000 messages concurrently
      });

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

  /**
   * Ensure webhook consumer exists
   */
  private async ensureConsumer(): Promise<void> {
    const jsm = this.natsClient.getJetStreamManager();

    try {
      await jsm.consumers.info("webhooks", "webhook-processor");
    } catch (error) {
      // Consumer doesn't exist, create it
      await jsm.consumers.add("webhooks", {
        name: "webhook-processor",
        filter_subject: "webhook.>",
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        max_deliver: 3,
        ack_wait: 30_000, // 30 seconds
        max_ack_pending: 1000,
      });
      log.system.info("Created webhook-processor consumer");
    }
  }

  /**
   * Process messages from NATS
   */
  private async processMessages(messages: AsyncIterable<JsMsg>): Promise<void> {
    for await (const msg of messages) {
      if (this.isShuttingDown) break;

      try {
        const event = JSON.parse(this.sc.decode(msg.data)) as WebhookEvent;

        webhooksReceivedTotal.inc({
          provider: event.provider,
          event_type: event.eventType,
        });

        // Add to buffer
        const buffered = await this.eventBuffer.add(event);
        if (!buffered) {
          // Buffer is closed, NACK the message
          msg.nak(calculateNatsBackoff(msg.info.redeliveryCount));
          continue;
        }

        // Update queue depth metric
        webhookQueueDepth.set(this.eventBuffer.size());

        // Acknowledge message
        msg.ack();

        log.webhook.debug({
          provider: event.provider,
          eventType: event.eventType,
          messageId: event.providerMessageId,
          bufferSize: this.eventBuffer.size(),
        }, "Webhook buffered");
      } catch (error) {
        log.webhook.error({ error }, "Failed to process webhook message");
        msg.nak(calculateNatsBackoff(msg.info.redeliveryCount));
        webhooksErrorsTotal.inc({ error_type: "processing_error" });
      }
    }
  }

  /**
   * Get processing statistics
   */
  getStats() {
    return {
      bufferStats: this.eventBuffer.getStats(),
      processorStats: this.batchProcessor.getStats(),
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    log.system.info({ bufferSize: this.eventBuffer.size() }, "Shutting down webhook worker");

    // Close the buffer and process remaining events
    await this.eventBuffer.close();

    // Reset queue depth metric
    webhookQueueDepth.set(0);

    // Wait for consumer to stop
    if (this.consumerPromise) {
      await this.consumerPromise;
    }

    log.system.info("Webhook worker shutdown complete");
  }
}

// Export factory function for easy testing
export function createWebhookWorker(
  natsClient: NatsClient,
  components?: {
    eventBuffer?: EventBuffer;
    batchProcessor?: WebhookBatchProcessor;
  }
): NatsWebhookWorkerRefactored {
  const worker = new NatsWebhookWorkerRefactored(natsClient);

  // Allow injection of components for testing
  if (components?.eventBuffer) {
    (worker as any).eventBuffer = components.eventBuffer;
  }
  if (components?.batchProcessor) {
    (worker as any).batchProcessor = components.batchProcessor;
  }

  return worker;
}