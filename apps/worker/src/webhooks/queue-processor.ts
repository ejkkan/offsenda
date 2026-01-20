import { NatsConnection, JetStreamClient, StringCodec, AckPolicy, DeliverPolicy } from "nats";
import { eq, sql, inArray, and } from "drizzle-orm";
import { recipients, batches } from "@batchsender/db";
import { db } from "../db.js";
import { log } from "../logger.js";
import { logEmailEvent, type EmailEventType } from "../clickhouse.js";
import type { NatsClient } from "../nats/client.js";
import { enqueueFailuresTotal } from "../metrics.js";

// =============================================================================
// Webhook Queue Types
// =============================================================================

export interface WebhookEvent {
  id: string; // Unique event ID for deduplication
  provider: "resend" | "ses" | "telnyx" | "twilio" | "custom";
  eventType: EmailEventType | "sms.delivered" | "sms.failed" | "custom.event";
  providerMessageId: string;
  recipientId?: string; // May need to lookup
  batchId?: string;
  userId?: string;
  timestamp: string;
  metadata?: Record<string, any>;
  rawEvent?: any; // Original provider event
  moduleId?: string; // For custom module webhooks
}

export interface WebhookBatch {
  events: WebhookEvent[];
  processedAt?: Date;
}

// =============================================================================
// Webhook Queue Processor
// =============================================================================

export class WebhookQueueProcessor {
  private js: JetStreamClient;
  private sc = StringCodec();
  private batchSize = 100; // Process webhooks in batches
  private flushInterval = 1000; // Flush every second
  private eventBuffer: WebhookEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private natsClient: NatsClient,
    private options: {
      batchSize?: number;
      flushInterval?: number;
    } = {}
  ) {
    this.js = natsClient.getJetStream();
    if (options.batchSize) this.batchSize = options.batchSize;
    if (options.flushInterval) this.flushInterval = options.flushInterval;
  }

  /**
   * Enqueue a webhook event for processing
   * Returns immediately for fast webhook response
   */
  async enqueueWebhook(event: WebhookEvent): Promise<void> {
    const startTime = Date.now();

    try {
      // Publish to NATS for durable processing
      const ack = await this.js.publish(
        `webhook.${event.provider}.${event.eventType}`,
        this.sc.encode(JSON.stringify(event)),
        {
          msgID: event.id, // Prevent duplicate processing
          expect: {
            streamName: "webhooks", // New stream for webhooks
          },
        }
      );

      log.webhook.debug(
        {
          provider: event.provider,
          eventType: event.eventType,
          seq: ack.seq,
          duplicate: ack.duplicate,
          durationMs: Date.now() - startTime,
        },
        "webhook enqueued"
      );
    } catch (error) {
      log.webhook.error(
        { error, event },
        "failed to enqueue webhook"
      );
      throw error;
    }
  }

  /**
   * Start processing webhook events
   * Consumes from NATS and batches DB updates
   * Note: In production, use NatsWebhookWorker instead for better performance
   */
  async startProcessing(): Promise<void> {
    const jsm = this.natsClient.getJetStreamManager();

    // Create consumer if it doesn't exist
    try {
      await jsm.consumers.info("webhooks", "webhook-queue-processor");
    } catch {
      // Consumer doesn't exist, create it
      await jsm.consumers.add("webhooks", {
        name: "webhook-queue-processor",
        filter_subject: "webhook.>",
        deliver_policy: DeliverPolicy.All,
        ack_policy: AckPolicy.Explicit,
        max_deliver: 3,
        ack_wait: 30_000_000_000, // 30 seconds to process (in nanoseconds)
      });
    }

    const consumer = await this.js.consumers.get("webhooks", "webhook-queue-processor");
    const messages = await consumer.consume();

    log.webhook.info("webhook processor started");

    // Process messages
    for await (const msg of messages) {
      try {
        const event = JSON.parse(this.sc.decode(msg.data)) as WebhookEvent;

        // Add to buffer
        this.eventBuffer.push(event);

        // Process batch if full
        if (this.eventBuffer.length >= this.batchSize) {
          await this.processBatch();
        } else {
          // Schedule flush if not already scheduled
          this.scheduleFlush();
        }

        // Acknowledge message
        msg.ack();
      } catch (error) {
        log.webhook.error({ error }, "failed to process webhook message");
        msg.nak();
      }
    }
  }

  /**
   * Schedule a batch flush
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      if (this.eventBuffer.length > 0) {
        await this.processBatch();
      }
    }, this.flushInterval);
  }

  /**
   * Process a batch of webhook events
   * This is where the optimization happens!
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessing || this.eventBuffer.length === 0) return;

    this.isProcessing = true;
    const batch = [...this.eventBuffer];
    this.eventBuffer = [];

    const startTime = Date.now();

    try {
      // Group events by type for efficient processing
      const deliveryEvents = batch.filter(e =>
        e.eventType === "delivered" || e.eventType === "sms.delivered"
      );
      const bounceEvents = batch.filter(e =>
        e.eventType === "bounced" || e.eventType === "soft_bounced"
      );
      const failureEvents = batch.filter(e =>
        e.eventType === "failed" || e.eventType === "sms.failed"
      );

      // Batch update recipients
      const updates: Promise<any>[] = [];

      if (deliveryEvents.length > 0) {
        const recipientIds = deliveryEvents
          .map(e => e.recipientId)
          .filter(Boolean) as string[];

        if (recipientIds.length > 0) {
          updates.push(
            db.update(recipients)
              .set({
                status: "delivered",
                deliveredAt: new Date(),
                updatedAt: new Date(),
              })
              .where(inArray(recipients.id, recipientIds))
          );
        }

        // Update batch counters in bulk
        const batchCounts = new Map<string, number>();
        deliveryEvents.forEach(e => {
          if (e.batchId) {
            batchCounts.set(e.batchId, (batchCounts.get(e.batchId) || 0) + 1);
          }
        });

        for (const [batchId, count] of batchCounts) {
          updates.push(
            db.update(batches)
              .set({
                deliveredCount: sql`${batches.deliveredCount} + ${count}`,
                updatedAt: new Date(),
              })
              .where(eq(batches.id, batchId))
          );
        }
      }

      // Similar processing for bounce and failure events...
      if (bounceEvents.length > 0) {
        const recipientIds = bounceEvents
          .map(e => e.recipientId)
          .filter(Boolean) as string[];

        if (recipientIds.length > 0) {
          updates.push(
            db.update(recipients)
              .set({
                status: "bounced",
                bouncedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(inArray(recipients.id, recipientIds))
          );
        }
      }

      // Execute all updates in parallel
      await Promise.all(updates);

      // Batch insert to ClickHouse for analytics
      const clickhouseEvents = batch.map(event => ({
        event_type: event.eventType,
        batch_id: event.batchId || "",
        recipient_id: event.recipientId || "",
        user_id: event.userId || "",
        email: event.metadata?.email || "",
        provider_message_id: event.providerMessageId,
        metadata: event.metadata,
      }));

      // TODO: Implement batch insert for ClickHouse
      // await batchLogEmailEvents(clickhouseEvents);

      log.webhook.info(
        {
          batchSize: batch.length,
          deliveries: deliveryEvents.length,
          bounces: bounceEvents.length,
          failures: failureEvents.length,
          durationMs: Date.now() - startTime,
        },
        "webhook batch processed"
      );
    } catch (error) {
      log.webhook.error(
        { error, batchSize: batch.length },
        "failed to process webhook batch"
      );

      // Re-queue failed events
      for (const event of batch) {
        await this.enqueueWebhook(event).catch((requeueErr) => {
          log.webhook.error(
            {
              error: (requeueErr as Error).message,
              eventId: event.id,
              provider: event.provider,
              eventType: event.eventType,
            },
            "failed to re-queue webhook event"
          );
          enqueueFailuresTotal.inc({ queue: "webhook" });
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Graceful shutdown
   */
  async stop(): Promise<void> {
    // Clear flush timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Process remaining events
    if (this.eventBuffer.length > 0) {
      await this.processBatch();
    }

    log.webhook.info("webhook processor stopped");
  }
}

// =============================================================================
// Webhook Event Factory
// =============================================================================

export class WebhookEventFactory {
  /**
   * Create webhook event from Telnyx webhook
   */
  static fromTelnyx(data: any): WebhookEvent {
    const messageId = data.data?.payload?.id;
    const eventType = data.data?.event_type;

    let processedEventType: WebhookEvent["eventType"] = "failed";

    switch (eventType) {
      case "message.sent":
        processedEventType = "sent";
        break;
      case "message.finalized":
      case "message.delivery_report":
        if (data.data?.payload?.status === "delivered") {
          processedEventType = "sms.delivered";
        } else {
          processedEventType = "sms.failed";
        }
        break;
    }

    return {
      id: `telnyx-${messageId}-${Date.now()}`,
      provider: "telnyx",
      eventType: processedEventType,
      providerMessageId: messageId,
      timestamp: data.data?.occurred_at || new Date().toISOString(),
      metadata: {
        status: data.data?.payload?.status,
        errors: data.data?.payload?.errors,
      },
      rawEvent: data,
    };
  }

  /**
   * Create webhook event from Resend webhook
   */
  static fromResend(event: any): WebhookEvent {
    const typeMap: Record<string, WebhookEvent["eventType"]> = {
      "email.sent": "sent",
      "email.delivered": "delivered",
      "email.bounced": "bounced",
      "email.complained": "complained",
      "email.opened": "opened",
      "email.clicked": "clicked",
    };

    return {
      id: `resend-${event.data.email_id}-${Date.now()}`,
      provider: "resend",
      eventType: typeMap[event.type] || "failed",
      providerMessageId: event.data.email_id,
      timestamp: event.created_at,
      metadata: {
        email: event.data.to?.[0],
        subject: event.data.subject,
      },
      rawEvent: event,
    };
  }

  /**
   * Create webhook event from AWS SES
   */
  static fromSES(notification: any): WebhookEvent {
    let eventType: WebhookEvent["eventType"] = "failed";

    switch (notification.notificationType) {
      case "Delivery":
        eventType = "delivered";
        break;
      case "Bounce":
        eventType = notification.bounce?.bounceType === "Permanent" ? "bounced" : "soft_bounced";
        break;
      case "Complaint":
        eventType = "complained";
        break;
    }

    return {
      id: `ses-${notification.mail.messageId}-${Date.now()}`,
      provider: "ses",
      eventType,
      providerMessageId: notification.mail.messageId,
      timestamp: notification.mail.timestamp,
      metadata: {
        email: notification.mail.destination?.[0],
        bounceType: notification.bounce?.bounceType,
        bounceSubType: notification.bounce?.bounceSubType,
      },
      rawEvent: notification,
    };
  }

  /**
   * Create webhook event from custom module webhook
   */
  static fromCustom(moduleId: string, data: any): WebhookEvent {
    // Extract provider message ID from common fields
    const providerMessageId =
      data.message_id ||
      data.messageId ||
      data.id ||
      `custom-${moduleId}-${Date.now()}`;

    // Map common event types or use custom.event
    let eventType: WebhookEvent["eventType"] = "custom.event";

    if (data.event_type || data.eventType || data.type) {
      const type = (data.event_type || data.eventType || data.type).toLowerCase();
      if (type.includes("delivered")) eventType = "delivered";
      else if (type.includes("bounced")) eventType = "bounced";
      else if (type.includes("failed")) eventType = "failed";
      else if (type.includes("sent")) eventType = "sent";
      else if (type.includes("opened")) eventType = "opened";
      else if (type.includes("clicked")) eventType = "clicked";
      else if (type.includes("complained")) eventType = "complained";
    }

    return {
      id: `custom-${moduleId}-${providerMessageId}-${Date.now()}`,
      provider: "custom",
      eventType,
      providerMessageId,
      timestamp: data.timestamp || data.created_at || new Date().toISOString(),
      metadata: {
        ...data,
        moduleId,
      },
      rawEvent: data,
      moduleId,
    };
  }
}