import { FastifyInstance } from "fastify";
import { eq, sql, and } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { recipients, batches } from "@batchsender/db";
import { db } from "./db.js";
import { config } from "./config.js";
import { logEmailEvent, lookupByProviderMessageId, type EmailEventType } from "./clickhouse.js";
import { log } from "./logger.js";
import { getNatsHealth } from "./nats/monitoring.js";
import { natsClient, queueService, rateLimiterService } from "./index.js";

// =============================================================================
// Resend Types
// =============================================================================

interface ResendWebhookEvent {
  type:
    | "email.sent"
    | "email.delivered"
    | "email.delivery_delayed"
    | "email.complained"
    | "email.bounced"
    | "email.opened"
    | "email.clicked";
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
  };
}

// =============================================================================
// AWS SES/SNS Types
// =============================================================================

interface SNSMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SubscribeURL?: string;
}

interface SESNotification {
  notificationType: "Bounce" | "Complaint" | "Delivery";
  mail: {
    messageId: string;
    timestamp: string;
    source: string;
    destination: string[];
  };
  bounce?: {
    bounceType: "Undetermined" | "Permanent" | "Transient";
    bounceSubType: string;
    bouncedRecipients: Array<{
      emailAddress: string;
      status?: string;
      diagnosticCode?: string;
    }>;
    timestamp: string;
  };
  complaint?: {
    complainedRecipients: Array<{
      emailAddress: string;
    }>;
    complaintFeedbackType?: string;
    timestamp: string;
  };
  delivery?: {
    recipients: string[];
    timestamp: string;
    smtpResponse: string;
  };
}

function verifySignature(
  payload: string,
  signature: string,
  timestamp: string
): boolean {
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = crypto
    .createHmac("sha256", config.WEBHOOK_SECRET)
    .update(signedPayload)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

export async function registerWebhooks(app: FastifyInstance): Promise<void> {
  // Resend webhook endpoint
  app.post("/webhooks/resend", {
    config: {
      rawBody: true,
    },
    handler: async (request, reply) => {
      const signature = request.headers["svix-signature"] as string;
      const timestamp = request.headers["svix-timestamp"] as string;
      const rawBody = (request as any).rawBody as string;

      // Verify signature in production
      if (config.NODE_ENV === "production") {
        if (!signature || !timestamp || !rawBody) {
          log.webhook.warn({}, "missing required signature headers");
          return reply.status(401).send({ error: "Missing signature headers" });
        }

        try {
          const sigParts = signature.split(",");
          const v1Sig = sigParts.find((p) => p.startsWith("v1,"))?.slice(3);

          if (v1Sig && !verifySignature(rawBody, v1Sig, timestamp)) {
            log.webhook.warn({}, "invalid signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        } catch {
          log.webhook.warn({}, "signature verification failed");
          return reply.status(401).send({ error: "Signature verification failed" });
        }
      }

      const event = request.body as ResendWebhookEvent;

      log.webhook.info({ type: event.type, emailId: event.data.email_id }, "received");

      try {
        await processWebhookEvent(event);
        return reply.send({ received: true });
      } catch (error) {
        log.webhook.error({ type: event.type, emailId: event.data.email_id, error: (error as Error).message }, "processing failed");
        return reply.status(500).send({ error: "Processing failed" });
      }
    },
  });

  // =============================================================================
  // AWS SES/SNS Webhook Endpoint
  // =============================================================================
  // SNS sends notifications as text/plain with JSON body
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (req, body, done) => {
    done(null, body);
  });

  app.post("/webhooks/ses", async (request, reply) => {
    try {
      // Parse SNS envelope
      const snsMessage = JSON.parse(request.body as string) as SNSMessage;

      // Handle subscription confirmation (required when setting up SNS topic)
      if (snsMessage.Type === "SubscriptionConfirmation") {
        if (snsMessage.SubscribeURL) {
          await fetch(snsMessage.SubscribeURL);
          log.webhook.info({ topicArn: snsMessage.TopicArn }, "SNS subscription confirmed");
        }
        return reply.send({ confirmed: true });
      }

      // Handle unsubscribe confirmation
      if (snsMessage.Type === "UnsubscribeConfirmation") {
        log.webhook.info({ topicArn: snsMessage.TopicArn }, "SNS unsubscribed");
        return reply.send({ received: true });
      }

      // Parse SES notification from Message field
      const sesNotification = JSON.parse(snsMessage.Message) as SESNotification;
      const messageId = sesNotification.mail.messageId;

      log.webhook.info(
        { type: sesNotification.notificationType, messageId },
        "SES notification received"
      );

      // Lookup batch/recipient/user IDs from ClickHouse index
      const lookup = await lookupByProviderMessageId(messageId);
      if (!lookup) {
        log.webhook.debug({ messageId }, "message not found in index");
        return reply.send({ received: true });
      }

      // Map SES notification type to our event type
      let eventType: EmailEventType;
      switch (sesNotification.notificationType) {
        case "Delivery":
          eventType = "delivered";
          break;
        case "Bounce":
          eventType = sesNotification.bounce?.bounceType === "Permanent" ? "bounced" : "soft_bounced";
          break;
        case "Complaint":
          eventType = "complained";
          break;
        default:
          log.webhook.debug({ type: sesNotification.notificationType }, "unhandled SES event type");
          return reply.send({ received: true });
      }

      // Update recipient status in PostgreSQL
      const statusMap: Record<EmailEventType, typeof recipients.$inferSelect.status> = {
        delivered: "delivered",
        bounced: "bounced",
        soft_bounced: "bounced",
        complained: "complained",
        sent: "sent",
        queued: "queued",
        opened: "delivered", // Keep as delivered
        clicked: "delivered", // Keep as delivered
        failed: "failed",
      };

      await db
        .update(recipients)
        .set({
          status: statusMap[eventType],
          deliveredAt: eventType === "delivered" ? new Date() : undefined,
          bouncedAt: eventType === "bounced" || eventType === "soft_bounced" ? new Date() : undefined,
          updatedAt: new Date(),
        })
        .where(eq(recipients.id, lookup.recipient_id));

      // Update batch counters
      if (eventType === "delivered") {
        await db
          .update(batches)
          .set({
            deliveredCount: sql`${batches.deliveredCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(batches.id, lookup.batch_id));
      } else if (eventType === "bounced" || eventType === "soft_bounced") {
        await db
          .update(batches)
          .set({
            bouncedCount: sql`${batches.bouncedCount} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(batches.id, lookup.batch_id));
      }

      // Check if batch is complete and update status (re-fetch to get updated counts)
      const updatedBatch = await db.query.batches.findFirst({
        where: eq(batches.id, lookup.batch_id),
      });

      if (updatedBatch && updatedBatch.totalRecipients > 0) {
        const processedCount = updatedBatch.deliveredCount + updatedBatch.bouncedCount + updatedBatch.failedCount;
        if (processedCount >= updatedBatch.totalRecipients) {
          await db
            .update(batches)
            .set({
              status: "completed",
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(batches.id, lookup.batch_id));
        }
      }

      // Log event to ClickHouse for analytics
      await logEmailEvent({
        event_type: eventType,
        batch_id: lookup.batch_id,
        recipient_id: lookup.recipient_id,
        user_id: lookup.user_id,
        email: sesNotification.mail.destination[0],
        provider_message_id: messageId,
        metadata: sesNotification.bounce
          ? {
              bounceType: sesNotification.bounce.bounceType,
              bounceSubType: sesNotification.bounce.bounceSubType,
            }
          : sesNotification.complaint
            ? { complaintFeedbackType: sesNotification.complaint.complaintFeedbackType }
            : undefined,
      });

      log.webhook.info({ type: eventType, messageId }, "SES event processed");
      return reply.send({ received: true });
    } catch (error) {
      log.webhook.error({ error: (error as Error).message }, "SES webhook processing failed");
      return reply.status(500).send({ error: "Processing failed" });
    }
  });

  // Health check
  app.get("/health", async () => {
    try {
      // Get NATS health status
      const natsHealth = await getNatsHealth(natsClient);

      // Get queue stats
      const queueStats = await queueService.getQueueStats();

      // Get Dragonfly health
      const dragonflyHealth = await rateLimiterService.healthCheck();

      const isHealthy = natsHealth.connected && dragonflyHealth;

      return {
        status: isHealthy ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        nats: {
          connected: natsHealth.connected,
          streamExists: natsHealth.stream_exists,
          consumerCount: natsHealth.consumers.length,
          consumers: natsHealth.consumers,
        },
        dragonfly: {
          connected: dragonflyHealth,
        },
        queues: {
          batch: {
            pending: queueStats.batch.pending,
            consumers: queueStats.batch.consumers,
          },
          email: {
            pending: queueStats.email.pending,
            consumers: queueStats.email.consumers,
          },
          priority: {
            pending: queueStats.priority.pending,
            consumers: queueStats.priority.consumers,
          },
        },
      };
    } catch (error) {
      log.system.error({ error }, "Health check failed");
      return {
        status: "degraded",
        timestamp: new Date().toISOString(),
        error: (error as Error).message,
      };
    }
  });
}

async function processWebhookEvent(event: ResendWebhookEvent): Promise<void> {
  const { type, data } = event;
  const emailId = data.email_id;

  const recipient = await db.query.recipients.findFirst({
    where: eq(recipients.providerMessageId, emailId),
  });

  if (!recipient) {
    log.webhook.debug({ emailId }, "recipient not found");
    return;
  }

  // Get batch for user_id
  const batch = await db.query.batches.findFirst({
    where: eq(batches.id, recipient.batchId),
    columns: { userId: true },
  });

  const userId = batch?.userId || "";

  switch (type) {
    case "email.delivered":
      await db
        .update(recipients)
        .set({
          status: "delivered",
          deliveredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(recipients.id, recipient.id));

      await db
        .update(batches)
        .set({
          deliveredCount: sql`${batches.deliveredCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, recipient.batchId));

      await logEmailEvent({
        event_type: "delivered",
        batch_id: recipient.batchId,
        recipient_id: recipient.id,
        user_id: userId,
        email: recipient.email,
        provider_message_id: emailId,
      });
      break;

    case "email.bounced":
      await db
        .update(recipients)
        .set({
          status: "bounced",
          bouncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(recipients.id, recipient.id));

      await db
        .update(batches)
        .set({
          bouncedCount: sql`${batches.bouncedCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, recipient.batchId));

      await logEmailEvent({
        event_type: "bounced",
        batch_id: recipient.batchId,
        recipient_id: recipient.id,
        user_id: userId,
        email: recipient.email,
        provider_message_id: emailId,
      });
      break;

    case "email.complained":
      await db
        .update(recipients)
        .set({
          status: "complained",
          updatedAt: new Date(),
        })
        .where(eq(recipients.id, recipient.id));

      await logEmailEvent({
        event_type: "complained",
        batch_id: recipient.batchId,
        recipient_id: recipient.id,
        user_id: userId,
        email: recipient.email,
        provider_message_id: emailId,
      });
      break;

    case "email.opened":
      await logEmailEvent({
        event_type: "opened",
        batch_id: recipient.batchId,
        recipient_id: recipient.id,
        user_id: userId,
        email: recipient.email,
        provider_message_id: emailId,
      });
      break;

    case "email.clicked":
      await logEmailEvent({
        event_type: "clicked",
        batch_id: recipient.batchId,
        recipient_id: recipient.id,
        user_id: userId,
        email: recipient.email,
        provider_message_id: emailId,
      });
      break;

    default:
      log.webhook.debug({ type }, "unhandled event type");
  }
}

// =============================================================================
// Webhook Simulator (dev/test only)
// =============================================================================

const simulateBatchSchema = z.object({
  deliveredRate: z.number().min(0).max(1).default(0.9),
  bouncedRate: z.number().min(0).max(1).default(0.05),
  complainedRate: z.number().min(0).max(1).default(0.01),
  delayMs: z.number().min(0).max(5000).default(100),
});

export async function registerWebhookSimulator(app: FastifyInstance): Promise<void> {
  // Only enable in non-production
  if (config.NODE_ENV === "production") {
    log.system.info({}, "webhook simulator disabled in production");
    return;
  }

  log.system.info({}, "webhook simulator enabled");

  // Simulate a delivered event for a specific recipient
  app.post("/test/webhook/delivered/:recipientId", async (request, reply) => {
    const { recipientId } = request.params as { recipientId: string };

    const recipient = await db.query.recipients.findFirst({
      where: eq(recipients.id, recipientId),
    });

    if (!recipient) {
      return reply.status(404).send({ error: "Recipient not found" });
    }

    await simulateEvent(recipientId, "email.delivered");
    return reply.send({ success: true, event: "delivered", recipientId });
  });

  // Simulate a bounced event for a specific recipient
  app.post("/test/webhook/bounced/:recipientId", async (request, reply) => {
    const { recipientId } = request.params as { recipientId: string };

    const recipient = await db.query.recipients.findFirst({
      where: eq(recipients.id, recipientId),
    });

    if (!recipient) {
      return reply.status(404).send({ error: "Recipient not found" });
    }

    await simulateEvent(recipientId, "email.bounced");
    return reply.send({ success: true, event: "bounced", recipientId });
  });

  // Simulate a complained event for a specific recipient
  app.post("/test/webhook/complained/:recipientId", async (request, reply) => {
    const { recipientId } = request.params as { recipientId: string };

    const recipient = await db.query.recipients.findFirst({
      where: eq(recipients.id, recipientId),
    });

    if (!recipient) {
      return reply.status(404).send({ error: "Recipient not found" });
    }

    await simulateEvent(recipientId, "email.complained");
    return reply.send({ success: true, event: "complained", recipientId });
  });

  // Simulate batch completion with configurable success/failure rates
  app.post("/test/webhook/batch/:batchId", async (request, reply) => {
    const { batchId } = request.params as { batchId: string };

    const batch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    if (!batch) {
      return reply.status(404).send({ error: "Batch not found" });
    }

    const params = simulateBatchSchema.parse(request.body || {});

    // Get all sent recipients for this batch
    const sentRecipients = await db.query.recipients.findMany({
      where: and(
        eq(recipients.batchId, batchId),
        eq(recipients.status, "sent")
      ),
    });

    if (sentRecipients.length === 0) {
      return reply.status(400).send({
        error: "No sent recipients to simulate",
        hint: "Recipients must have status 'sent' before simulating webhook events"
      });
    }

    const results = {
      delivered: 0,
      bounced: 0,
      complained: 0,
      total: sentRecipients.length,
    };

    // Process each recipient
    for (const recipient of sentRecipients) {
      const rand = Math.random();
      let eventType: ResendWebhookEvent["type"];

      if (rand < params.bouncedRate) {
        eventType = "email.bounced";
        results.bounced++;
      } else if (rand < params.bouncedRate + params.complainedRate) {
        eventType = "email.complained";
        results.complained++;
      } else if (rand < params.bouncedRate + params.complainedRate + params.deliveredRate) {
        eventType = "email.delivered";
        results.delivered++;
      } else {
        // Remaining percentage stays as 'sent' (no event)
        continue;
      }

      await simulateEvent(recipient.id, eventType);

      // Optional delay between events to simulate realistic timing
      if (params.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, params.delayMs));
      }
    }

    return reply.send({
      success: true,
      batchId,
      results,
      message: `Simulated ${results.delivered + results.bounced + results.complained} events`,
    });
  });

  // Get simulation status/help
  app.get("/test/webhook", async (_request, reply) => {
    return reply.send({
      status: "Webhook simulator active",
      endpoints: {
        "POST /test/webhook/delivered/:recipientId": "Simulate delivery for a recipient",
        "POST /test/webhook/bounced/:recipientId": "Simulate bounce for a recipient",
        "POST /test/webhook/complained/:recipientId": "Simulate complaint for a recipient",
        "POST /test/webhook/batch/:batchId": "Simulate batch webhook events (body: { deliveredRate, bouncedRate, complainedRate, delayMs })",
      },
      defaults: {
        deliveredRate: 0.9,
        bouncedRate: 0.05,
        complainedRate: 0.01,
        delayMs: 100,
      },
    });
  });
}

async function simulateEvent(
  recipientId: string,
  eventType: ResendWebhookEvent["type"]
): Promise<void> {
  const recipient = await db.query.recipients.findFirst({
    where: eq(recipients.id, recipientId),
  });

  if (!recipient) {
    throw new Error(`Recipient not found: ${recipientId}`);
  }

  // Create a fake provider message ID if none exists
  const providerMessageId = recipient.providerMessageId ||
    `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Update provider message ID if it wasn't set
  if (!recipient.providerMessageId) {
    await db
      .update(recipients)
      .set({ providerMessageId })
      .where(eq(recipients.id, recipientId));
  }

  // Process the event using the same logic as real webhooks
  const event: ResendWebhookEvent = {
    type: eventType,
    created_at: new Date().toISOString(),
    data: {
      email_id: providerMessageId,
      from: "simulated@test.local",
      to: [recipient.email],
      subject: "Simulated",
    },
  };

  await processWebhookEvent(event);
  log.webhook.debug({ type: eventType, email: recipient.email }, "simulated");
}
