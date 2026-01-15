import { ConsumerMessages, JsMsg, StringCodec } from "nats";
import { eq, and, sql } from "drizzle-orm";
import { batches, recipients } from "@batchsender/db";
import { db } from "../db.js";
import { config } from "../config.js";
import { logEmailEvent, indexProviderMessage, logEmailEvents } from "../clickhouse.js";
import { BatchJobData, EmailJobData, NatsQueueService } from "./queue-service.js";
import { NatsClient } from "./client.js";
import { getEmailProvider } from "../providers/index.js";
import { log, createTimer } from "../logger.js";
import { ProviderRateLimiter } from "../provider-rate-limiter.js";

// Get configured email provider (Resend, SES, or Mock)
const emailProvider = getEmailProvider();

// Initialize provider-specific rate limiter (only if not disabled)
// In test environments, DISABLE_RATE_LIMIT=true to avoid Redis connection
let providerRateLimiter: ProviderRateLimiter | null = null;

if (!config.DISABLE_RATE_LIMIT) {
  const providerRateLimitConfig = {
    ses: { provider: "ses", tokensPerSecond: config.SES_RATE_LIMIT },
    resend: { provider: "resend", tokensPerSecond: config.RESEND_RATE_LIMIT },
    mock: { provider: "mock", tokensPerSecond: config.MOCK_RATE_LIMIT },
  };

  const rateLimiterConfig = providerRateLimitConfig[emailProvider.name as keyof typeof providerRateLimitConfig]
    || { provider: emailProvider.name, tokensPerSecond: 100 };

  providerRateLimiter = new ProviderRateLimiter(rateLimiterConfig);
}

export class NatsEmailWorker {
  private activeConsumers = new Set<string>();  // Track active user processors
  private sc = StringCodec();
  private queueService: NatsQueueService;
  private isShuttingDown = false;

  constructor(private natsClient: NatsClient) {
    this.queueService = new NatsQueueService(natsClient);
  }

  // Utility: Calculate exponential backoff delay
  private calculateBackoff(
    redeliveryCount: number,
    baseDelayMs: number = 1000,
    maxDelayMs: number = 30000
  ): number {
    return Math.min(baseDelayMs * Math.pow(2, redeliveryCount), maxDelayMs);
  }

  // Generic consumer processor - reduces code duplication
  private async startConsumerProcessor(config: {
    consumerName: string;
    maxMessages: number;
    onMessage: (msg: JsMsg) => Promise<void>;
    onError?: (msg: JsMsg, error: Error) => Promise<void>;
  }): Promise<void> {
    const js = this.natsClient.getJetStream();

    try {
      const consumer = await js.consumers.get("email-system", config.consumerName);
      const messages = await consumer.consume({ max_messages: config.maxMessages });

      log.system.info({ consumer: config.consumerName }, "Consumer processor started");

      for await (const msg of messages) {
        if (this.isShuttingDown) break;

        try {
          await config.onMessage(msg);
          msg.ack();
        } catch (error) {
          if (config.onError) {
            await config.onError(msg, error as Error);
          } else {
            // Default error handling: log and nak with backoff
            log.system.error({ error, seq: msg.seq, consumer: config.consumerName }, "Message processing failed");
            msg.nak(this.calculateBackoff(msg.info.redeliveryCount));
          }
        }
      }
    } catch (error) {
      const errorDetails = error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : { raw: String(error), type: typeof error };
      log.system.error({ error: errorDetails, consumer: config.consumerName }, "Consumer processor error");
      throw error;
    }
  }

  // Start the batch processor
  async startBatchProcessor(): Promise<void> {
    return this.startConsumerProcessor({
      consumerName: "batch-processor",
      maxMessages: config.CONCURRENT_BATCHES || 10,
      onMessage: (msg) => this.processBatchMessage(msg),
      onError: async (msg, error) => {
        log.batch.error({ error, seq: msg.seq }, "Failed to process batch");
        // Longer backoff for batches (base 5s, max 60s)
        msg.nak(this.calculateBackoff(msg.info.redeliveryCount, 5000, 60000));
      },
    });
  }

  // Process a single batch message
  private async processBatchMessage(msg: JsMsg): Promise<void> {
    // Parse message data with error handling
    let data: BatchJobData;
    try {
      data = JSON.parse(this.sc.decode(msg.data)) as BatchJobData;
    } catch (error) {
      log.batch.error({ error, seq: msg.seq }, "Failed to parse batch message");
      msg.ack(); // Acknowledge malformed message to prevent redelivery
      return;
    }

    const { batchId, userId } = data;
    const timer = createTimer();

    log.batch.info({ id: batchId, userId }, "processing");

    const batch = await db.query.batches.findFirst({
      where: eq(batches.id, batchId),
    });

    if (!batch) {
      log.batch.error({ id: batchId }, "not found");
      throw new Error(`Batch ${batchId} not found`);
    }

    if (batch.status === "paused") {
      log.batch.info({ id: batchId }, "skipped (paused)");
      return;
    }

    // Update to processing
    if (batch.status === "queued") {
      await db
        .update(batches)
        .set({
          status: "processing",
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batchId));
    }

    // Get all pending recipients
    const pendingRecipients = await db.query.recipients.findMany({
      where: and(
        eq(recipients.batchId, batchId),
        eq(recipients.status, "pending")
      ),
    });

    if (pendingRecipients.length === 0) {
      const stats = await db.query.recipients.findMany({
        where: eq(recipients.batchId, batchId),
        columns: { status: true },
      });

      const allDone = stats.every((r: { status: string }) => r.status !== "pending");
      if (allDone) {
        await db
          .update(batches)
          .set({
            status: "completed",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(batches.id, batchId));
        log.batch.info({ id: batchId, duration: timer() }, "completed");
      }

      return;
    }

    // Mark all as queued in bulk
    await db
      .update(recipients)
      .set({ status: "queued", updatedAt: new Date() })
      .where(
        and(
          eq(recipients.batchId, batchId),
          eq(recipients.status, "pending")
        )
      );

    // Log queued events to ClickHouse in bulk
    const queuedEvents = pendingRecipients.map((r: { id: string; email: string }) => ({
      event_type: "queued" as const,
      batch_id: batchId,
      recipient_id: r.id,
      user_id: userId,
      email: r.email,
    }));

    await logEmailEvents(queuedEvents);

    // Create email jobs
    const emailJobs: EmailJobData[] = pendingRecipients.map((r: { id: string; email: string; name: string | null; variables: Record<string, string> | null }) => ({
      batchId,
      recipientId: r.id,
      userId,
      email: r.email,
      name: r.name || undefined,
      variables: r.variables as Record<string, string> | undefined,
      fromEmail: batch.fromEmail,
      fromName: batch.fromName || undefined,
      subject: batch.subject,
      htmlContent: batch.htmlContent || undefined,
      textContent: batch.textContent || undefined,
    }));

    // Enqueue emails to NATS
    await this.queueService.enqueueEmails(userId, emailJobs);

    // Ensure a consumer exists for this user
    await this.ensureUserEmailProcessor(userId);

    log.batch.info({ id: batchId, emails: emailJobs.length, duration: timer() }, "enqueued");
  }

  // Create or get email consumer for a specific user
  async ensureUserEmailProcessor(userId: string): Promise<void> {
    if (this.activeConsumers.has(userId)) {
      return;
    }

    // Create consumer if it doesn't exist
    await this.natsClient.createUserConsumer(userId);

    // Mark as active (prevent double-start)
    this.activeConsumers.add(userId);

    // Start processing in the background
    this.startUserEmailProcessor(userId).catch((error) => {
      log.queue.error({ error, userId }, "Email processor crashed");
      this.activeConsumers.delete(userId);
    });
  }

  // Start processor for a specific user
  private async startUserEmailProcessor(userId: string): Promise<void> {
    try {
      await this.startConsumerProcessor({
        consumerName: `user-${userId}`,
        maxMessages: 100, // Process up to 100 messages concurrently
        onMessage: (msg) => this.processEmailMessage(msg),
        onError: async (msg, error) => {
          log.email.error({ error, seq: msg.seq, userId }, "Failed to process user email");
          await this.handleEmailFailure(msg, error as Error);
        },
      });
    } finally {
      // Clean up when done
      this.activeConsumers.delete(userId);
      log.queue.info({ userId }, "email processor stopped");
    }
  }

  // Process a single email message
  private async processEmailMessage(msg: JsMsg): Promise<void> {
    // Parse message data with error handling
    let data: EmailJobData;
    try {
      data = JSON.parse(this.sc.decode(msg.data)) as EmailJobData;
    } catch (error) {
      log.email.error({ error, seq: msg.seq }, "Failed to parse email message");
      msg.ack(); // Acknowledge malformed message to prevent redelivery
      return;
    }

    const {
      batchId,
      recipientId,
      userId,
      email,
      name,
      variables,
      fromEmail,
      fromName,
      subject,
      htmlContent,
      textContent,
    } = data;

    // Template variable replacement
    let html = htmlContent || "";
    let text = textContent || "";

    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        html = html.replace(new RegExp(`{{${key}}}`, "g"), value);
        text = text.replace(new RegExp(`{{${key}}}`, "g"), value);
      }
    }

    html = html.replace(/{{name}}/g, name || "").replace(/{{email}}/g, email);
    text = text.replace(/{{name}}/g, name || "").replace(/{{email}}/g, email);

    // Acquire rate limit token before sending (respects provider limits like AWS SES 14/sec)
    // Rate limiting is disabled in test environments (providerRateLimiter will be null)
    if (providerRateLimiter) {
      const acquired = await providerRateLimiter.acquire(10000); // 10 second timeout
      if (!acquired) {
        throw new Error(`Provider rate limit timeout - could not send within 10 seconds`);
      }
    }

    // Send via configured email provider
    const result = await emailProvider.send({
      to: email,
      from: fromEmail,
      fromName,
      subject,
      html: html || undefined,
      text: text || " ",
    });

    if (!result.success) {
      throw new Error(result.error || "Failed to send email");
    }

    const providerMessageId = result.providerMessageId || "";

    // Update recipient status
    await db
      .update(recipients)
      .set({
        status: "sent",
        sentAt: new Date(),
        providerMessageId,
        updatedAt: new Date(),
      })
      .where(eq(recipients.id, recipientId));

    // Increment batch sent count atomically
    await db
      .update(batches)
      .set({
        sentCount: sql`${batches.sentCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(batches.id, batchId));

    // Log to ClickHouse
    await logEmailEvent({
      event_type: "sent",
      batch_id: batchId,
      recipient_id: recipientId,
      user_id: userId,
      email,
      provider_message_id: providerMessageId,
    });

    // Index message ID for webhook lookups
    await indexProviderMessage({
      provider_message_id: providerMessageId,
      batch_id: batchId,
      recipient_id: recipientId,
      user_id: userId,
    });

    log.email.debug({ batchId, to: email }, "sent");

    // Check if batch is complete
    await this.checkBatchCompletion(batchId);
  }

  // Handle email sending failures
  private async handleEmailFailure(msg: JsMsg, error: Error): Promise<void> {
    // Parse message data with error handling
    let data: EmailJobData;
    try {
      data = JSON.parse(this.sc.decode(msg.data)) as EmailJobData;
    } catch (parseError) {
      log.email.error({ error: parseError, seq: msg.seq }, "Failed to parse email message in error handler");
      msg.ack(); // Acknowledge malformed message
      return;
    }

    const { batchId, recipientId, userId, email } = data;

    // Check if this is the final attempt
    const isFinalAttempt = msg.info.redeliveryCount >= 4; // 5 total attempts

    if (isFinalAttempt) {
      // Mark as failed in database
      await db
        .update(recipients)
        .set({
          status: "failed",
          errorMessage: error.message,
          updatedAt: new Date(),
        })
        .where(eq(recipients.id, recipientId));

      // Increment failed count
      await db
        .update(batches)
        .set({
          failedCount: sql`${batches.failedCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(batches.id, batchId));

      // Log to ClickHouse
      await logEmailEvent({
        event_type: "failed",
        batch_id: batchId,
        recipient_id: recipientId,
        user_id: userId,
        email,
        error_message: error.message,
      });

      log.email.error(
        { batchId, recipientId, email, error: error.message },
        "permanently failed"
      );

      // Check if batch is complete
      await this.checkBatchCompletion(batchId);

      // Don't rethrow - acknowledge the message to remove it from queue
      msg.ack();
    } else {
      // Retry with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, msg.info.redeliveryCount), 30000);
      log.email.warn(
        { batchId, recipientId, email, attempt: msg.info.redeliveryCount + 1, delay },
        "retrying"
      );
      msg.nak(delay);
    }
  }

  // Check if a batch is complete and update its status
  private async checkBatchCompletion(batchId: string): Promise<void> {
    try {
      // Get all recipients for this batch
      const batchRecipients = await db.query.recipients.findMany({
        where: eq(recipients.batchId, batchId),
        columns: { status: true },
      });

      // Check if all recipients are in a final state (sent, failed, bounced, or complained)
      const allDone = batchRecipients.every((r: { status: string }) =>
        r.status === "sent" ||
        r.status === "failed" ||
        r.status === "bounced" ||
        r.status === "complained"
      );

      if (allDone) {
        // Get the current batch to check if it's not already completed
        const batch = await db.query.batches.findFirst({
          where: eq(batches.id, batchId),
          columns: { status: true },
        });

        if (batch && batch.status !== "completed") {
          await db
            .update(batches)
            .set({
              status: "completed",
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(batches.id, batchId));

          log.batch.info({ id: batchId }, "completed");
        }
      }
    } catch (error) {
      log.batch.error({ batchId, error }, "Failed to check batch completion");
    }
  }

  // Start the priority email processor
  async startPriorityProcessor(): Promise<void> {
    return this.startConsumerProcessor({
      consumerName: "priority-processor",
      maxMessages: 50, // Higher concurrency for priority emails
      onMessage: (msg) => this.processEmailMessage(msg),
      onError: async (msg, error) => {
        log.email.error({ error, seq: msg.seq }, "Failed to process priority email");
        await this.handleEmailFailure(msg, error as Error);
      },
    });
  }

  // Start all existing user workers (on startup)
  async startExistingUserWorkers(): Promise<void> {
    const jsm = this.natsClient.getJetStreamManager();

    try {
      const consumers = await jsm.consumers.list("email-system").next();

      for (const consumer of consumers) {
        // Skip system consumers
        if (consumer.name === "batch-processor" || consumer.name === "priority-processor") {
          continue;
        }

        // Extract userId from consumer name (format: user-{userId})
        const match = consumer.name.match(/^user-(.+)$/);
        if (match && consumer.num_pending > 0) {
          const userId = match[1];
          await this.ensureUserEmailProcessor(userId);
        }
      }

      log.system.info({ count: this.activeConsumers.size }, "Started existing user workers");
    } catch (error) {
      log.system.error({ error }, "Failed to start existing user workers");
    }
  }

  // Graceful shutdown
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    log.system.info({ activeConsumers: this.activeConsumers.size }, "Shutting down NATS workers");

    // The isShuttingDown flag will stop all processing loops
    // Wait for in-flight messages to complete
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Close provider rate limiter (if it was initialized)
    if (providerRateLimiter) {
      await providerRateLimiter.close();
    }

    this.activeConsumers.clear();
    log.system.info("NATS workers shutdown complete");
  }
}