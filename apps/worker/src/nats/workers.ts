import { JsMsg, StringCodec } from "nats";
import { eq, and, inArray } from "drizzle-orm";
import { batches, recipients } from "@batchsender/db";
import type { EmailModuleConfig, BatchPayload, Recipient } from "@batchsender/db";
import { db } from "../db.js";
import { config } from "../config.js";
import { logEventBuffered, indexProviderMessageBuffered, getBufferedLogger } from "../buffered-logger.js";
import { getHotStateManager } from "../hot-state-manager.js";
import { BatchJobData, ChunkJobData, JobData, EmbeddedSendConfig, NatsQueueService } from "./queue-service.js";
import { NatsClient } from "./client.js";
import { getModule } from "../modules/index.js";
import type { JobPayload, JobResult, BatchJobPayload, PROVIDER_LIMITS } from "../modules/types.js";
import { PROVIDER_LIMITS as ProviderLimits } from "../modules/types.js";
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
        // Handle backpressure (memory pressure) differently - delay longer to allow memory to free up
        if (error.message?.includes("memory_pressure")) {
          log.batch.warn({ error: error.message, seq: msg.seq }, "Batch delayed due to memory pressure");
          // Retry in 60 seconds to allow memory pressure to subside
          msg.nak(60000);
          return;
        }

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

      const batch = await db.query.batches.findFirst({
        where: eq(batches.id, batchId),
        with: { sendConfig: true },
      });

      if (!batch) {
        log.batch.error({ id: batchId }, "not found");
        throw new Error(`Batch ${batchId} not found`);
      }

      // Log with redelivery info (useful for debugging rolling update scenarios)
      const redeliveryCount = msg.info.redeliveryCount;
      log.batch.info(
        { id: batchId, userId, redeliveryCount, currentStatus: batch.status },
        redeliveryCount > 0 ? "processing (redelivery)" : "processing"
      );

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

      // Detect if this is a redelivery (batch already in "processing" state)
      const isRedelivery = batch.status === "processing";

      if (batch.status === "queued") {
        await db
          .update(batches)
          .set({ status: "processing", startedAt: new Date(), updatedAt: new Date() })
          .where(eq(batches.id, batchId));
      }

      // Count recipients that need processing
      // On redelivery, include "queued" recipients that may not have been enqueued to NATS
      // (worker may have died between marking "queued" and publishing to NATS)
      const statusesToProcess: ("pending" | "queued")[] = isRedelivery
        ? ["pending", "queued"]
        : ["pending"];
      const pendingCount = await countRecipients(batchId, statusesToProcess);

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

      // Determine chunk size from sendConfig or provider defaults
      const providerLimits = ProviderLimits[embeddedConfig.module] || ProviderLimits.webhook;
      const rateLimit = embeddedConfig.rateLimit as { recipientsPerRequest?: number } | null;
      const chunkSize = rateLimit?.recipientsPerRequest || providerLimits.maxBatchSize;

      // Stream recipients in pages to avoid OOM for large batches
      // Each page: update status, log events, build chunks
      let totalEnqueued = 0;
      let totalFailed = 0;
      let pageCount = 0;
      let chunkIndex = 0;
      let currentChunkIds: string[] = [];
      const chunksToEnqueue: ChunkJobData[] = [];

      for await (const page of streamRecipientPages(batchId, { pageSize: 1000, status: statusesToProcess })) {
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

        // Build chunks from this page
        for (const r of pageRecipients) {
          currentChunkIds.push(r.id);

          if (currentChunkIds.length >= chunkSize) {
            chunksToEnqueue.push({
              batchId,
              userId,
              chunkIndex,
              recipientIds: currentChunkIds,
              sendConfig: embeddedConfig,
              dryRun: batch.dryRun,
            });
            chunkIndex++;
            currentChunkIds = [];
          }
        }

        // Enqueue chunks accumulated so far (to avoid holding too many in memory)
        if (chunksToEnqueue.length >= 100) {
          const enqueueResult = await this.queueService.enqueueRecipientChunks(chunksToEnqueue);
          totalEnqueued += enqueueResult.success;
          totalFailed += enqueueResult.failed;
          chunksToEnqueue.length = 0;
        }

        // Log progress for large batches
        if (pageCount % 10 === 0) {
          log.batch.debug({ id: batchId, pages: pageCount, chunks: chunkIndex }, "pagination progress");
        }
      }

      // Final chunk (partial)
      if (currentChunkIds.length > 0) {
        chunksToEnqueue.push({
          batchId,
          userId,
          chunkIndex,
          recipientIds: currentChunkIds,
          sendConfig: embeddedConfig,
          dryRun: batch.dryRun,
        });
        chunkIndex++;
      }

      // Enqueue remaining chunks
      if (chunksToEnqueue.length > 0) {
        const enqueueResult = await this.queueService.enqueueRecipientChunks(chunksToEnqueue);
        totalEnqueued += enqueueResult.success;
        totalFailed += enqueueResult.failed;
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

      log.batch.info({ id: batchId, chunks: chunkIndex, chunkSize, pages: pageCount, module: embeddedConfig.module, duration: timer() }, "enqueued (chunked)");
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
    let data: JobData | ChunkJobData;
    try {
      data = JSON.parse(this.sc.decode(msg.data)) as JobData | ChunkJobData;
    } catch (error) {
      log.email.error({ error, seq: msg.seq }, "Failed to parse job message");
      msg.ack();
      return;
    }

    // Detect chunk vs individual job by checking for recipientIds array
    if ("recipientIds" in data && Array.isArray((data as ChunkJobData).recipientIds)) {
      return this.processChunkMessage(msg, data as ChunkJobData);
    }

    // Type narrowing: data is now JobData
    const jobData = data as JobData;
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
      } = jobData;

      const hotState = getHotStateManager();

      // Idempotency check: skip if already processed
      // Layer 1: Try Dragonfly (fast path)
      // Layer 2: Fall back to PostgreSQL if:
      //   - Dragonfly is unavailable (throws error)
      //   - Dragonfly returns null (data missing after restart)
      // This prevents duplicate sends when Dragonfly restarts and loses in-memory data
      let existingStatus: string | null = null;
      let needsPostgresFallback = false;

      try {
        existingStatus = await hotState.checkRecipientProcessed(batchId, recipientId);
        // If Dragonfly returns null, we need to check PostgreSQL as backup
        // This handles the case where Dragonfly restarted and lost data
        if (existingStatus === null) {
          needsPostgresFallback = true;
        }
      } catch (error) {
        // Dragonfly unavailable - fall back to PostgreSQL
        log.email.warn({ batchId, recipientId, error }, "Dragonfly unavailable for idempotency check, falling back to PostgreSQL");
        needsPostgresFallback = true;
      }

      // PostgreSQL fallback for idempotency (source of truth)
      if (needsPostgresFallback && !existingStatus) {
        const pgRecipient = await db.query.recipients.findFirst({
          where: eq(recipients.id, recipientId),
          columns: { status: true },
        });
        if (pgRecipient && (pgRecipient.status === "sent" || pgRecipient.status === "failed" || pgRecipient.status === "bounced" || pgRecipient.status === "complained")) {
          existingStatus = pgRecipient.status;
          // Warm the cache for next time (write-through)
          try {
            const redis = hotState.getRedis();
            const code = pgRecipient.status === "sent" ? "s" : pgRecipient.status === "failed" ? "f" : pgRecipient.status === "bounced" ? "b" : "c";
            await redis.hset(`batch:${batchId}:recipients`, recipientId, `${code}:`);
          } catch {
            // Cache warming is best-effort, don't fail the check
          }
          log.email.debug({ batchId, recipientId, status: existingStatus }, "idempotency check via PostgreSQL fallback");
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

  /**
   * Process a chunk of recipients using batch execution.
   * This is the new high-throughput path that uses executeBatch.
   */
  private async processChunkMessage(msg: JsMsg, chunk: ChunkJobData): Promise<void> {
    const traceId = msg.headers?.get("X-Trace-Id") || undefined;

    return withTraceAsync(async () => {
      const { batchId, userId, chunkIndex, recipientIds, sendConfig, dryRun } = chunk;
      const timer = createTimer();

      const hotState = getHotStateManager();

      // Batch idempotency check - get all already-processed recipients
      const alreadyProcessed = await hotState.checkRecipientsProcessedBatch(batchId, recipientIds);

      // Filter out already-processed recipients
      const toProcess = recipientIds.filter((id) => !alreadyProcessed.has(id));

      if (toProcess.length === 0) {
        log.email.debug({ batchId, chunkIndex, skipped: recipientIds.length }, "chunk skipped (all already processed)");
        return;
      }

      // Fetch recipient data from database
      const recipientRows = await db.query.recipients.findMany({
        where: inArray(recipients.id, toProcess),
      });

      if (recipientRows.length === 0) {
        log.email.warn({ batchId, chunkIndex, toProcess: toProcess.length }, "no recipients found in database");
        return;
      }

      // Fetch batch data for payload building (fromEmail, subject, etc.)
      const batch = await db.query.batches.findFirst({
        where: eq(batches.id, batchId),
        columns: {
          payload: true,
          fromEmail: true,
          fromName: true,
          subject: true,
          htmlContent: true,
          textContent: true,
        },
      });

      const module = getModule(sendConfig.module);
      if (!module) {
        throw new Error(`Unknown module type: ${sendConfig.module}`);
      }

      // Build payloads for batch execution
      const batchPayloads: BatchJobPayload[] = recipientRows.map((r: Recipient) => {
        const jobPayload = buildJobPayload({
          sendConfig,
          batchPayload: batch?.payload as BatchPayload | undefined,
          legacyFields: {
            fromEmail: batch?.fromEmail || undefined,
            fromName: batch?.fromName || undefined,
            subject: batch?.subject || undefined,
            htmlContent: batch?.htmlContent || undefined,
            textContent: batch?.textContent || undefined,
          },
          recipient: {
            identifier: r.identifier || r.email || "",
            name: r.name || undefined,
            variables: r.variables as Record<string, string> | undefined,
          },
          webhookData: undefined,
        });

        return {
          recipientId: r.id,
          payload: jobPayload,
        };
      });

      // Rate limiting - acquire ONE token for this batch request
      const rateLimitResult = await acquireRateLimit(sendConfig, userId, 10000);
      if (!rateLimitResult.allowed) {
        throw new Error(`Rate limit exceeded (${rateLimitResult.limitingFactor})`);
      }

      const sendTimer = emailSendDuration.startTimer({ provider: sendConfig.module, status: "success" });
      let batchResults: import("../modules/types.js").BatchJobResult[];

      if (dryRun) {
        // Dry run - simulate success for all
        const minLatency = config.DRY_RUN_LATENCY_MIN_MS;
        const maxLatency = config.DRY_RUN_LATENCY_MAX_MS;
        const simulatedLatency = config.HIGH_THROUGHPUT_TEST_MODE
          ? 1
          : minLatency + Math.random() * (maxLatency - minLatency);
        if (simulatedLatency > 1) {
          await new Promise((resolve) => setTimeout(resolve, simulatedLatency));
        }

        batchResults = batchPayloads.map((p) => ({
          recipientId: p.recipientId,
          result: {
            success: true,
            providerMessageId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            latencyMs: simulatedLatency,
          },
        }));
        log.email.debug({ batchId, chunkIndex, count: batchPayloads.length }, "dry run - skipped outbound calls");
      } else if (module.supportsBatch && module.executeBatch) {
        // Use batch execution
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
        batchResults = await module.executeBatch(batchPayloads, configForModule);
      } else {
        // Fallback to individual execution for non-batch modules
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
        batchResults = [];
        for (const p of batchPayloads) {
          const result = await module.execute(p.payload, configForModule);
          batchResults.push({ recipientId: p.recipientId, result });
        }
      }

      sendTimer();

      // Convert batch results to hot state format and record atomically
      const resultsForHotState = batchResults.map((r) => ({
        recipientId: r.recipientId,
        success: r.result.success,
        providerMessageId: r.result.providerMessageId,
        errorMessage: r.result.error,
      }));

      const { counters, isComplete } = await hotState.recordResultsBatch(batchId, resultsForHotState);

      // Log events to ClickHouse
      const recipientMap = new Map<string, Recipient>(recipientRows.map((r: Recipient) => [r.id, r]));
      for (const r of batchResults) {
        const recipient = recipientMap.get(r.recipientId);
        const identifier = recipient?.identifier || recipient?.email || "";

        if (r.result.success) {
          logEventBuffered({
            event_type: "sent",
            module_type: sendConfig.module,
            batch_id: batchId,
            recipient_id: r.recipientId,
            user_id: userId,
            email: identifier,
            provider_message_id: r.result.providerMessageId || "",
          });

          if (r.result.providerMessageId && sendConfig.module === "email") {
            indexProviderMessageBuffered({
              provider_message_id: r.result.providerMessageId,
              batch_id: batchId,
              recipient_id: r.recipientId,
              user_id: userId,
            });
          }

          emailsSentTotal.inc({ provider: sendConfig.module, status: "sent" });
          clickhouseEventsTotal.inc({ event_type: "sent" });
        } else {
          logEventBuffered({
            event_type: "failed",
            module_type: sendConfig.module,
            batch_id: batchId,
            recipient_id: r.recipientId,
            user_id: userId,
            email: identifier,
            error_message: r.result.error || "Unknown error",
          });

          emailErrorsTotal.inc({ provider: sendConfig.module, error_type: "permanent" });
          clickhouseEventsTotal.inc({ event_type: "failed" });
        }
      }

      const successCount = batchResults.filter((r) => r.result.success).length;
      const failCount = batchResults.length - successCount;

      log.email.debug(
        { batchId, chunkIndex, sent: successCount, failed: failCount, duration: timer() },
        "chunk processed"
      );

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
