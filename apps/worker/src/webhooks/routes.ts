import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { sendConfigs } from "@batchsender/db";
import { config } from "../config.js";
import { log } from "../logger.js";
import { WebhookQueueProcessor, WebhookEventFactory } from "./queue-processor.js";
import { db } from "../db.js";

// Route params interface
interface CustomWebhookParams {
  moduleId: string;
}

// =============================================================================
// Webhook Routes with Queue-Based Processing
// =============================================================================

/**
 * Register webhook routes with queue-based processing
 * All webhooks respond immediately and process asynchronously
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  queueProcessor: WebhookQueueProcessor
): void {
  // =============================================================================
  // Telnyx Webhook
  // =============================================================================
  app.post("/webhooks/telnyx", async (request, reply) => {
    const startTime = Date.now();

    try {
      // Verify signature if configured
      const signature = request.headers["telnyx-signature-ed25519"] as string;
      const timestamp = request.headers["telnyx-timestamp"] as string;

      if (config.NODE_ENV === "production" && config.TELNYX_WEBHOOK_SECRET) {
        if (!verifyTelnyxSignature(
          (request as any).rawBody,
          signature,
          timestamp,
          config.TELNYX_WEBHOOK_SECRET
        )) {
          log.webhook.warn("invalid Telnyx signature");
          return reply.status(401).send({ error: "Invalid signature" });
        }
      }

      const event = request.body as any;
      const webhookEvent = WebhookEventFactory.fromTelnyx(event);

      // Enqueue immediately for async processing (enrichment happens later)
      await queueProcessor.enqueueWebhook(webhookEvent);

      log.webhook.info({
        provider: "telnyx",
        eventType: webhookEvent.eventType,
        messageId: webhookEvent.providerMessageId,
        durationMs: Date.now() - startTime,
      }, "webhook received and queued");

      // Respond immediately
      return reply.send({ received: true });
    } catch (error) {
      log.webhook.error({ error }, "Telnyx webhook error");
      return reply.status(500).send({ error: "Processing failed" });
    }
  });

  // =============================================================================
  // Resend Webhook
  // =============================================================================
  app.post("/webhooks/resend", {
    config: { rawBody: true },
    handler: async (request, reply) => {
      const startTime = Date.now();

      try {
        // Verify signature in production
        if (config.NODE_ENV === "production") {
          const signature = request.headers["svix-signature"] as string;
          const timestamp = request.headers["svix-timestamp"] as string;
          const rawBody = (request as any).rawBody as string;

          if (!verifyResendSignature(rawBody, signature, timestamp)) {
            log.webhook.warn("invalid Resend signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        }

        const event = request.body as any;
        const webhookEvent = WebhookEventFactory.fromResend(event);

        // Enqueue immediately for async processing (enrichment happens later)
        await queueProcessor.enqueueWebhook(webhookEvent);

        log.webhook.info({
          provider: "resend",
          eventType: webhookEvent.eventType,
          emailId: webhookEvent.providerMessageId,
          durationMs: Date.now() - startTime,
        }, "webhook received and queued");

        return reply.send({ received: true });
      } catch (error) {
        log.webhook.error({ error }, "Resend webhook error");
        return reply.status(500).send({ error: "Processing failed" });
      }
    },
  });

  // =============================================================================
  // AWS SES/SNS Webhook
  // =============================================================================
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (req, body, done) => {
    done(null, body);
  });

  app.post("/webhooks/ses", async (request, reply) => {
    const startTime = Date.now();

    try {
      // Parse SNS envelope
      const snsMessage = JSON.parse(request.body as string) as any;

      // Handle subscription confirmation
      if (snsMessage.Type === "SubscriptionConfirmation") {
        if (snsMessage.SubscribeURL) {
          await fetch(snsMessage.SubscribeURL);
          log.webhook.info({ topicArn: snsMessage.TopicArn }, "SNS subscription confirmed");
        }
        return reply.send({ confirmed: true });
      }

      if (snsMessage.Type === "UnsubscribeConfirmation") {
        log.webhook.info({ topicArn: snsMessage.TopicArn }, "SNS unsubscribed");
        return reply.send({ received: true });
      }

      // Parse SES notification
      const sesNotification = JSON.parse(snsMessage.Message);
      const webhookEvent = WebhookEventFactory.fromSES(sesNotification);

      // Enqueue immediately for async processing (enrichment happens later)
      await queueProcessor.enqueueWebhook(webhookEvent);

      log.webhook.info({
        provider: "ses",
        eventType: webhookEvent.eventType,
        messageId: webhookEvent.providerMessageId,
        durationMs: Date.now() - startTime,
      }, "webhook received and queued");

      return reply.send({ received: true });
    } catch (error) {
      log.webhook.error({ error }, "SES webhook error");
      return reply.status(500).send({ error: "Processing failed" });
    }
  });

  // =============================================================================
  // Custom Module Webhook
  // =============================================================================
  app.post<{ Params: CustomWebhookParams }>("/webhooks/custom/:moduleId", async (request, reply) => {
    const startTime = Date.now();
    const { moduleId } = request.params;

    try {
      // Verify module exists and is webhook type
      const sendConfig = await db.query.sendConfigs.findFirst({
        where: and(
          eq(sendConfigs.id, moduleId),
          eq(sendConfigs.module, "webhook")
        )
      });

      if (!sendConfig) {
        return reply.status(404).send({ error: "Module not found" });
      }

      // Verify signature if configured
      const webhookConfig = sendConfig.config as any;
      if (webhookConfig.webhookSecret) {
        // Get signature header based on module config
        const signatureHeader = webhookConfig.signatureHeader || "x-webhook-signature";
        const signature = request.headers[signatureHeader.toLowerCase()] as string;

        if (signature) {
          // Simple HMAC verification (can be extended based on module requirements)
          const expectedSignature = crypto
            .createHmac("sha256", webhookConfig.webhookSecret)
            .update((request as any).rawBody || JSON.stringify(request.body))
            .digest("hex");

          if (signature !== expectedSignature) {
            log.webhook.warn({ moduleId }, "invalid custom webhook signature");
            return reply.status(401).send({ error: "Invalid signature" });
          }
        }
      }

      // Create webhook event
      const event = request.body as any;
      const webhookEvent = WebhookEventFactory.fromCustom(moduleId, event);

      // Enqueue immediately (NO LOOKUPS!)
      await queueProcessor.enqueueWebhook(webhookEvent);

      log.webhook.info({
        provider: "custom",
        moduleId,
        eventType: webhookEvent.eventType,
        durationMs: Date.now() - startTime,
      }, "custom webhook received and queued");

      return reply.send({ received: true });
    } catch (error) {
      log.webhook.error({ error, moduleId }, "Custom webhook error");
      return reply.status(500).send({ error: "Processing failed" });
    }
  });

  log.webhook.info("webhook routes registered with queue processor");
}

// =============================================================================
// Signature Verification
// =============================================================================

function verifyTelnyxSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string
): boolean {
  try {
    const signedPayload = `${timestamp}|${payload}`;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(signedPayload)
      .digest("base64");

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

function verifyResendSignature(
  payload: string,
  signature: string,
  timestamp: string
): boolean {
  try {
    const signedPayload = `${timestamp}.${payload}`;
    const expectedSignature = crypto
      .createHmac("sha256", config.WEBHOOK_SECRET)
      .update(signedPayload)
      .digest("base64");

    const sigParts = signature.split(",");
    const v1Sig = sigParts.find((p) => p.startsWith("v1,"))?.slice(3);

    return v1Sig ? crypto.timingSafeEqual(
      Buffer.from(v1Sig),
      Buffer.from(expectedSignature)
    ) : false;
  } catch {
    return false;
  }
}