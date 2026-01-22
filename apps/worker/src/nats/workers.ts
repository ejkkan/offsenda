import { JsMsg, StringCodec } from "nats";
import { eq, and, inArray } from "drizzle-orm";
import { batches, recipients } from "@batchsender/db";
import type { EmailModuleConfig, BatchPayload } from "@batchsender/db";
import { db } from "../db.js";
import { config } from "../config.js";
import { logEventBuffered, indexProviderMessageBuffered, getBufferedLogger } from "../buffered-logger.js";
import { getHotStateManager } from "../hot-state-manager.js";
import { BatchJobData, JobData, EmbeddedSendConfig, NatsQueueService } from "./queue-service.js";
import { NatsClient } from "./client.js";
import { getModule } from "../modules/index.js";
import type { JobPayload, JobResult } from "../modules/types.js";
import { buildJobPayload } from "../domain/payload-builders/index.js";
import { log, createTimer, withTraceAsync } from "../logger.js";
import { acquireRateLimit, closeRateLimitRegistry } from "../rate-limiting/index.js";
import {
  emailsSentTotal,
  emailErrorsTotal,
  emailSendDuration,
  batchesProcessedTotal,
  clickhouseEventsTotal,
} from "../metrics.js";
import { calculateNatsBackoff, calculateBatchBackoff, calculateEmailBackoff } from "../domain/utils/backoff.js";
import { streamRecipientPages, countRecipients, type RecipientRow } from "../domain/utils/recipient-pagination.js";

function getDefaultEmailConfig(): EmbeddedSendConfig {
  return {
    id: "default",
    module: "email",
    config: { mode: "managed" } as EmailModuleConfig,
    rateLimit: { perSecond: 100 },
  };
}

export class NatsEmailWorker {
  private activeConsumers = new Set<string>();
  private consumerCreationLocks = new Map<string, Promise<void>>();
  private runningConsumerPromises = new Map<string, Promise<void>>(); // Track running consumer loops
  private sc = StringCodec();
  private queueService: NatsQueueService;
  private isShuttingDown = false;

  constructor(private natsClient: NatsClient) {
    this.queueService = new NatsQueueService(natsClient);
  }

  private async startConsumerProcessor(consumerConfig: {
    consumerName: string;
    maxMessages: number;
    onMessage: (msg: JsMsg) => Promise<void>;
    onError?: (msg: JsMsg, error: Error) => Promise<void>;
  }): Promise<void> {
    const js = this.natsClient.getJetStream();

    // Create and track the processor promise
    const processorPromise = this.runConsumerLoop(consumerConfig, js);
    this.runningConsumerPromises.set(consumerConfig.consumerName, processorPromise);

    try {
      await processorPromise;
    } finally {
      this.runningConsumerPromises.delete(consumerConfig.consumerName);
      log.system.debug({ consumer: consumerConfig.consumerName }, "Consumer processor finished");
    }
  }

  private async runConsumerLoop(
    consumerConfig: {
      consumerName: string;
      maxMessages: number;
      onMessage: (msg: JsMsg) => Promise<void>;
      onError?: (msg: JsMsg, error: Error) => Promise<void>;
    },
    js: ReturnType<NatsClient["getJetStream"]>
  ): Promise<void> {
    try {
      const consumer = await js.consumers.get("email-system", consumerConfig.consumerName);
      const messages = await consumer.consume({ max_messages: consumerConfig.maxMessages });

      log.system.info({ consumer: consumerConfig.consumerName, maxMessages: consumerConfig.maxMessages }, "Consumer processor started (parallel mode)");

      // Track in-flight messages for graceful shutdown
      const inFlight = new Set<Promise<void>>();

      // Backpressure limit to prevent memory exhaustion
      const maxInFlight = config.MAX_CONCURRENT_REQUESTS || 1000;

      for await (const msg of messages) {
        if (this.isShuttingDown) break;

        // Backpressure: wait if we've hit the limit before accepting more
        if (inFlight.size >= maxInFlight) {
          await Promise.race(inFlight);
        }

        // Process message in parallel - don't await
        const processingPromise = (async () => {
          try {
            await consumerConfig.onMessage(msg);
            msg.ack();
          } catch (error) {
            try {
              if (consumerConfig.onError) {
                await consumerConfig.onError(msg, error as Error);
              } else {
                log.system.error({ error, seq: msg.seq, consumer: consumerConfig.consumerName }, "Message processing failed");
                msg.nak(calculateNatsBackoff(msg.info.redeliveryCount));
              }
            } catch (handlerError) {
              // Error handler itself failed - log and NAK to prevent message loss
              log.system.error(
                { error: handlerError, originalError: error, seq: msg.seq, consumer: consumerConfig.consumerName },
                "Error handler failed"
              );
              msg.nak(calculateNatsBackoff(msg.info.redeliveryCount));
            }
          }
        })();

        inFlight.add(processingPromise);
        processingPromise.finally(() => inFlight.delete(processingPromise));
      }

      // Wait for all in-flight messages to complete before exiting
      if (inFlight.size > 0) {
        log.system.info({ consumer: consumerConfig.consumerName, inFlight: inFlight.size }, "Waiting for in-flight messages");
        await Promise.allSettled(inFlight);
      }
    } catch (error) {
      const errorDetails = error instanceof Error
        ? { message: error.message, name: error.name, stack: error.stack }
        : { raw: String(error), type: typeof error };
      log.system.error({ error: errorDetails, consumer: consumerConfig.consumerName }, "Consumer processor error");
      throw error;
    }
  }

  async startBatchProcessor(): Promise<void> {
    return this.startConsumerProcessor({
      consumerName: "batch-processor",
      maxMessages: config.CONCURRENT_BATCHES || 10,
      onMessage: (msg) => this.processBatchMessage(msg),
      onError: async (msg, error) => {
        log.batch.error({ error, seq: msg.seq }, "Failed to process batch");
        msg.nak(calculateBatchBackoff(msg.info.redeliveryCount));
      },
    });
  }

  private async processBatchMessage(msg: JsMsg): Promise<void> {
    let data: BatchJobData;
    try {
      data = JSON.parse(this.sc.decode(msg.data)) as BatchJobData;
    } catch (error) {
      log.batch.error({ error, seq: msg.seq }, "Failed to parse batch message");
      msg.ack();
      return;
    }

    const traceId = msg.headers?.get("X-Trace-Id") || undefined;

    return withTraceAsync(async () => {
      const { batchId, userId } = data;
      const timer = createTimer();

      log.batch.info({ id: batchId, userId }, "processing");

      const batch = await db.query.batches.findFirst({
        where: eq(batches.id, batchId),
        with: { sendConfig: true },
      });

      if (!batch) {
        log.batch.error({ id: batchId }, "not found");
        throw new Error(`Batch ${batchId} not found`);
      }

      if (batch.status === "paused") {
        log.batch.info({ id: batchId }, "skipped (paused)");
        return;
      }

      const embeddedConfig: EmbeddedSendConfig = batch.sendConfig
        ? {
            id: batch.sendConfig.id,
            module: batch.sendConfig.module,
            config: batch.sendConfig.config,
            rateLimit: batch.sendConfig.rateLimit,
          }
        : getDefaultEmailConfig();

      if (batch.status === "queued") {
        await db
          .update(batches)
          .set({ status: "processing", startedAt: new Date(), updatedAt: new Date() })
          .where(eq(batches.id, batchId));
      }

      // Count pending recipients first for hot state initialization
      // Uses COUNT query - doesn't load all recipients into memory
      const pendingCount = await countRecipients(batchId, "pending");

      if (pendingCount === 0) {
        // Check if batch should be marked complete
        const hotState = getHotStateManager();
        if (await hotState.isBatchComplete(batchId)) {
          await hotState.markBatchCompleted(batchId);
          log.batch.info({ id: batchId, duration: timer() }, "completed (no pending)");
        }
        return;
      }

      // Initialize hot state for O(1) completion checks BEFORE processing pages
      const hotState = getHotStateManager();
      await hotState.initializeBatch(batchId, pendingCount);

      // Stream recipients in pages to avoid OOM for large batches
      // Each page: update status, log events, enqueue jobs
      let totalEnqueued = 0;
      let totalFailed = 0;
      let pageCount = 0;

      for await (const page of streamRecipientPages(batchId, { pageSize: 1000, status: "pending" })) {
        pageCount++;
        const pageRecipients = page.recipients;

        // Mark this page as queued
        const recipientIds = pageRecipients.map((r) => r.id);
        await db
          .update(recipients)
          .set({ status: "queued", updatedAt: new Date() })
          .where(inArray(recipients.id, recipientIds));

        // Buffered ClickHouse logging for this page
        const queuedEvents = pageRecipients.map((r: RecipientRow) => ({
          event_type: "queued" as const,
          module_type: embeddedConfig.module,
          batch_id: batchId,
          recipient_id: r.id,
          user_id: userId,
          email: r.identifier || r.email || "",
        }));
        getBufferedLogger().logEvents(queuedEvents);
        clickhouseEventsTotal.inc({ event_type: "queued" }, queuedEvents.length);

        // Create jobs for this page
        // NOTE: Both `payload` (preferred) and legacy fields are included for backwards
        // compatibility. The payload builder handles priority: payload > legacy > config.
        // Legacy fields will be removed after database migration to payload-only storage.
        const jobs: JobData[] = pageRecipients.map((r: RecipientRow) => ({
          batchId,
          recipientId: r.id,
          userId,
          identifier: r.identifier || r.email || "",
          name: r.name || undefined,
          variables: r.variables as Record<string, string> | undefined,
          sendConfig: embeddedConfig,
          payload: batch.payload as BatchPayload | undefined,
          dryRun: batch.dryRun,
          // Legacy fields - kept for backwards compatibility with existing batches
          email: r.email || r.identifier || undefined,
          fromEmail: batch.fromEmail || undefined,
          fromName: batch.fromName || undefined,
          subject: batch.subject || undefined,
          htmlContent: batch.htmlContent || undefined,
          textContent: batch.textContent || undefined,
        }));

        // Enqueue this page
        const enqueueResult = await this.queueService.enqueueEmails(userId, jobs);
        totalEnqueued += enqueueResult.success;
        totalFailed += enqueueResult.failed;

        // Log progress for large batches
        if (pageCount % 10 === 0) {
          log.batch.debug({ id: batchId, pages: pageCount, enqueued: totalEnqueued }, "pagination progress");
        }
      }

      // Check total enqueue result and fail batch if too many dropped
      const totalJobs = totalEnqueued + totalFailed;
      if (totalFailed > 0 && totalJobs > 0) {
        const failureRate = totalFailed / totalJobs;
        if (failureRate > 0.01) { // More than 1% failed
          throw new Error(
            `Enqueue failed: ${totalFailed}/${totalJobs} messages dropped (${(failureRate * 100).toFixed(1)}% failure rate)`
          );
        }
        log.queue.warn(
          {
            batchId,
            success: totalEnqueued,
            failed: totalFailed,
            failureRate: `${(failureRate * 100).toFixed(2)}%`,
          },
          "some messages failed to enqueue (below threshold)"
        );
      }

      await this.ensureUserEmailProcessor(userId);

      log.batch.info({ id: batchId, jobs: totalEnqueued, pages: pageCount, module: embeddedConfig.module, duration: timer() }, "enqueued (paginated)");
    }, traceId);
  }

  async ensureUserEmailProcessor(userId: string): Promise<void> {
    // Fast path: already active
    if (this.activeConsumers.has(userId)) return;

    // Check if there's already a creation in progress for this user
    const existingLock = this.consumerCreationLocks.get(userId);
    if (existingLock) {
      // Wait for the existing creation to complete
      await existingLock;
      return;
    }

    // Create a lock for this user's consumer creation
    const creationPromise = this.createUserProcessor(userId);
    this.consumerCreationLocks.set(userId, creationPromise);

    try {
      await creationPromise;
    } finally {
      this.consumerCreationLocks.delete(userId);
    }
  }

  private async createUserProcessor(userId: string): Promise<void> {
    // Double-check after acquiring lock (another call may have completed)
    if (this.activeConsumers.has(userId)) return;

    await this.natsClient.createUserConsumer(userId);
    this.activeConsumers.add(userId);

    this.startUserEmailProcessor(userId).catch((error) => {
      log.queue.error({ error, userId }, "Email processor crashed");
      this.activeConsumers.delete(userId);
    });
  }

  private async startUserEmailProcessor(userId: string): Promise<void> {
    try {
      await this.startConsumerProcessor({
        consumerName: `user-${userId}`,
        maxMessages: 1000, // Match max_ack_pending for optimal throughput
        onMessage: (msg) => this.processJobMessage(msg),
        onError: async (msg, error) => {
          log.email.error({ error, seq: msg.seq, userId }, "Failed to process user email");
          await this.handleEmailFailure(msg, error as Error);
        },
      });
    } finally {
      this.activeConsumers.delete(userId);
      log.queue.info({ userId }, "email processor stopped");
    }
  }

  private async processJobMessage(msg: JsMsg): Promise<void> {
    let data: JobData;
    try {
      data = JSON.parse(this.sc.decode(msg.data)) as JobData;
    } catch (error) {
      log.email.error({ error, seq: msg.seq }, "Failed to parse job message");
      msg.ack();
      return;
    }

    const traceId = msg.headers?.get("X-Trace-Id") || undefined;

    return withTraceAsync(async () => {
      const {
        batchId,
        recipientId,
        userId,
        identifier,
        email,
        name,
        variables,
        sendConfig,
        payload: batchPayload,
        fromEmail,
        fromName,
        subject,
        htmlContent,
        textContent,
        data: webhookData,
        dryRun,
      } = data;

      const hotState = getHotStateManager();

      // Idempotency check: skip if already processed
      // Try Dragonfly first, fall back to PostgreSQL if unavailable
      let existingStatus: string | null = null;
      try {
        existingStatus = await hotState.checkRecipientProcessed(batchId, recipientId);
      } catch (error) {
        // Dragonfly unavailable - fall back to PostgreSQL
        log.email.warn({ batchId, recipientId, error }, "Dragonfly unavailable for idempotency check, falling back to PostgreSQL");
        const pgRecipient = await db.query.recipients.findFirst({
          where: eq(recipients.id, recipientId),
          columns: { status: true },
        });
        if (pgRecipient && (pgRecipient.status === "sent" || pgRecipient.status === "failed" || pgRecipient.status === "bounced" || pgRecipient.status === "complained")) {
          existingStatus = pgRecipient.status;
        }
      }
      if (existingStatus) {
        log.email.debug({ batchId, recipientId, status: existingStatus }, "skipped (already processed)");
        return;
      }

      const module = getModule(sendConfig.module);
      if (!module) {
        throw new Error(`Unknown module type: ${sendConfig.module}`);
      }

      const jobPayload = buildJobPayload({
        sendConfig,
        batchPayload,
        legacyFields: { fromEmail, fromName, subject, htmlContent, textContent },
        recipient: { identifier: identifier || email || "", name, variables },
        webhookData,
      });

      // Rate limiting (handles managed vs BYOK flows)
      const rateLimitResult = await acquireRateLimit(sendConfig, userId, 10000);
      if (!rateLimitResult.allowed) {
        throw new Error(`Rate limit exceeded (${rateLimitResult.limitingFactor})`);
      }

      const sendTimer = emailSendDuration.startTimer({ provider: sendConfig.module, status: "success" });

      let result: JobResult;

      if (dryRun) {
        // Use minimal latency in high-throughput test mode, otherwise simulate realistic provider delays
        const minLatency = config.DRY_RUN_LATENCY_MIN_MS;
        const maxLatency = config.DRY_RUN_LATENCY_MAX_MS;
        const simulatedLatency = config.HIGH_THROUGHPUT_TEST_MODE
          ? 1
          : minLatency + Math.random() * (maxLatency - minLatency);
        if (simulatedLatency > 1) {
          await new Promise((resolve) => setTimeout(resolve, simulatedLatency));
        }
        result = {
          success: true,
          providerMessageId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          latencyMs: simulatedLatency,
        };
        log.email.debug({ batchId, recipientId, module: sendConfig.module }, "dry run - skipped outbound call");
      } else {
        const configForModule = {
          id: sendConfig.id,
          userId,
          name: "embedded",
          module: sendConfig.module,
          config: sendConfig.config,
          rateLimit: sendConfig.rateLimit ?? null,
          isDefault: false,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        result = await module.execute(jobPayload, configForModule);
        if (!result.success) {
          throw new Error(result.error || `Failed to execute ${sendConfig.module} module`);
        }
      }

      const providerMessageId = result.providerMessageId || "";
      const recipientIdentifier = identifier || email || "";

      // Record sent in hot state (atomic counter increment + completion check)
      const { counters, isComplete } = await hotState.recordSent(batchId, recipientId, providerMessageId);

      // Buffered ClickHouse logging
      logEventBuffered({
        event_type: "sent",
        module_type: sendConfig.module,
        batch_id: batchId,
        recipient_id: recipientId,
        user_id: userId,
        email: recipientIdentifier,
        provider_message_id: providerMessageId,
      });

      if (providerMessageId && sendConfig.module === "email") {
        indexProviderMessageBuffered({
          provider_message_id: providerMessageId,
          batch_id: batchId,
          recipient_id: recipientId,
          user_id: userId,
        });
      }

      sendTimer();
      emailsSentTotal.inc({ provider: sendConfig.module, status: "sent" });
      clickhouseEventsTotal.inc({ event_type: "sent" });

      log.email.debug({ batchId, to: recipientIdentifier, module: sendConfig.module }, "sent");

      // O(1) completion check
      if (isComplete) {
        await hotState.markBatchCompleted(batchId);
        batchesProcessedTotal.inc({ status: "completed" });
        log.batch.info({ id: batchId, sent: counters.sent, failed: counters.failed }, "completed");
      }
    }, traceId);
  }

  private async handleEmailFailure(msg: JsMsg, error: Error): Promise<void> {
    let data: JobData;
    try {
      data = JSON.parse(this.sc.decode(msg.data)) as JobData;
    } catch (parseError) {
      log.email.error({ error: parseError, seq: msg.seq }, "Failed to parse job message in error handler");
      msg.ack();
      return;
    }

    const traceId = msg.headers?.get("X-Trace-Id") || undefined;

    return withTraceAsync(async () => {
      const { batchId, recipientId, userId, identifier, email, sendConfig } = data;
      const recipientIdentifier = identifier || email || "";
      const isFinalAttempt = msg.info.redeliveryCount >= 4;

      if (isFinalAttempt) {
        const hotState = getHotStateManager();
        const { counters, isComplete } = await hotState.recordFailed(batchId, recipientId, error.message);

        logEventBuffered({
          event_type: "failed",
          module_type: sendConfig.module,
          batch_id: batchId,
          recipient_id: recipientId,
          user_id: userId,
          email: recipientIdentifier,
          error_message: error.message,
        });

        emailErrorsTotal.inc({ provider: sendConfig.module, error_type: "permanent" });
        clickhouseEventsTotal.inc({ event_type: "failed" });

        log.email.error(
          { batchId, recipientId, identifier: recipientIdentifier, module: sendConfig.module, error: error.message },
          "permanently failed"
        );

        if (isComplete) {
          await hotState.markBatchCompleted(batchId);
          batchesProcessedTotal.inc({ status: "completed" });
          log.batch.info({ id: batchId, sent: counters.sent, failed: counters.failed }, "completed");
        }

        msg.ack();
      } else {
        const delay = Math.min(1000 * Math.pow(2, msg.info.redeliveryCount), 30000);
        log.email.warn(
          { batchId, recipientId, identifier: recipientIdentifier, attempt: msg.info.redeliveryCount + 1, delay },
          "retrying"
        );
        msg.nak(delay);
      }
    }, traceId);
  }

  async startPriorityProcessor(): Promise<void> {
    return this.startConsumerProcessor({
      consumerName: "priority-processor",
      maxMessages: 50,
      onMessage: (msg) => this.processJobMessage(msg),
      onError: async (msg, error) => {
        log.email.error({ error, seq: msg.seq }, "Failed to process priority email");
        await this.handleEmailFailure(msg, error as Error);
      },
    });
  }

  async startExistingUserWorkers(): Promise<void> {
    const jsm = this.natsClient.getJetStreamManager();

    try {
      const consumers = await jsm.consumers.list("email-system").next();

      for (const consumer of consumers) {
        if (consumer.name === "batch-processor" || consumer.name === "priority-processor") {
          continue;
        }

        const match = consumer.name.match(/^user-(.+)$/);
        if (match && consumer.num_pending > 0) {
          await this.ensureUserEmailProcessor(match[1]);
        }
      }

      log.system.info({ count: this.activeConsumers.size }, "Started existing user workers");
    } catch (error) {
      log.system.error({ error }, "Failed to start existing user workers");
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    const runningCount = this.runningConsumerPromises.size;
    log.system.info(
      { activeConsumers: this.activeConsumers.size, runningConsumers: runningCount },
      "Shutting down NATS workers, waiting for consumers to drain"
    );

    // Wait for all running consumer loops to finish (they check isShuttingDown flag)
    // Use Promise.allSettled to wait for all, even if some fail
    if (runningCount > 0) {
      const consumerPromises = Array.from(this.runningConsumerPromises.values());
      const results = await Promise.allSettled(consumerPromises);

      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        log.system.warn({ failedCount: failed.length }, "Some consumers failed during shutdown");
      }
    }

    // Close rate limit registry
    await closeRateLimitRegistry();
    this.activeConsumers.clear();
    this.consumerCreationLocks.clear();

    log.system.info({}, "NATS workers shutdown complete");
  }
}
