import { JetStreamClient, StringCodec, headers as natsHeaders } from "nats";
import { NatsClient } from "./client.js";
import { log, createTimer, getTraceId } from "../logger.js";
import { enqueueFailuresTotal, natsEmailsEnqueued } from "../metrics.js";

// Import shared types - single source of truth
import type {
  BatchJobData,
  ChunkJobData,
  EmbeddedSendConfig,
  JobData,
  EmailJobData,
  QueueStats,
  StreamStats,
  EnqueueResult,
} from "../types/jobs.js";

// Re-export for backwards compatibility
export type {
  BatchJobData,
  ChunkJobData,
  EmbeddedSendConfig,
  JobData,
  EmailJobData,
  QueueStats,
  StreamStats,
  EnqueueResult,
} from "../types/jobs.js";

export class NatsQueueService {
  private js: JetStreamClient;
  private sc = StringCodec();

  constructor(private natsClient: NatsClient) {
    this.js = natsClient.getJetStream();
  }

  // Batch operations
  async enqueueBatch(batchId: string, userId: string): Promise<void> {
    const timer = createTimer();
    const data: BatchJobData = { batchId, userId };

    // Add traceId to NATS message headers for distributed tracing
    const hdrs = natsHeaders();
    const traceId = getTraceId();
    if (traceId) {
      hdrs.set("X-Trace-Id", traceId);
    }

    try {
      const ack = await this.js.publish("sys.batch.process", this.sc.encode(JSON.stringify(data)), {
        msgID: `batch-${batchId}`, // Prevent duplicate processing
        headers: hdrs,
        expect: {
          streamName: "email-system",
        },
      });

      log.queue.info(
        {
          batchId,
          userId,
          seq: ack.seq,
          duplicate: ack.duplicate,
          duration: timer(),
        },
        "batch enqueued"
      );
    } catch (error) {
      log.queue.error({ error, batchId, userId }, "failed to enqueue batch");
      throw error;
    }
  }

  /**
   * Enqueue a chunk of recipients for batch processing
   * Each chunk contains multiple recipient IDs processed together
   */
  async enqueueRecipientChunk(chunk: ChunkJobData): Promise<void> {
    const timer = createTimer();
    const msgID = `chunk-${chunk.batchId}-${chunk.chunkIndex}`;

    // Add traceId to NATS message headers for distributed tracing
    const hdrs = natsHeaders();
    const traceId = getTraceId();
    if (traceId) {
      hdrs.set("X-Trace-Id", traceId);
    }

    try {
      const ack = await this.js.publish(
        `email.user.${chunk.userId}.chunk`,
        this.sc.encode(JSON.stringify(chunk)),
        {
          msgID, // Deduplication
          headers: hdrs,
          expect: {
            streamName: "email-system",
          },
        }
      );

      if (!ack.duplicate) {
        // Track individual emails enqueued (not just chunks)
        natsEmailsEnqueued.inc(chunk.recipientIds.length);

        log.queue.debug(
          {
            batchId: chunk.batchId,
            chunkIndex: chunk.chunkIndex,
            recipientCount: chunk.recipientIds.length,
            seq: ack.seq,
          },
          "chunk enqueued"
        );
      }
    } catch (error) {
      log.queue.error(
        { error, batchId: chunk.batchId, chunkIndex: chunk.chunkIndex },
        "failed to enqueue chunk"
      );
      throw error;
    }
  }

  /**
   * Bulk enqueue recipient chunks
   */
  async enqueueRecipientChunks(chunks: ChunkJobData[]): Promise<EnqueueResult> {
    if (chunks.length === 0) {
      return { success: 0, failed: 0, errors: [] };
    }

    const timer = createTimer();
    let successCount = 0;
    const errors: Array<{ email: string; error: string }> = [];

    // Process chunks - no need for extra chunking, they're already sized
    const results = await Promise.allSettled(
      chunks.map((chunk) => this.enqueueRecipientChunk(chunk))
    );

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        successCount++;
      } else {
        const errorMessage = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        errors.push({
          email: `chunk-${chunks[index].chunkIndex}`,
          error: errorMessage,
        });
        enqueueFailuresTotal.inc({ queue: "chunk" });
      }
    });

    log.queue.info(
      {
        batchId: chunks[0]?.batchId,
        totalChunks: chunks.length,
        totalRecipients: chunks.reduce((sum, c) => sum + c.recipientIds.length, 0),
        success: successCount,
        failed: errors.length,
        duration: timer(),
      },
      "bulk chunk enqueue completed"
    );

    return {
      success: successCount,
      failed: errors.length,
      errors,
    };
  }

  // Email operations
  async enqueueEmail(userId: string, email: EmailJobData): Promise<void> {
    const msgID = `email-${email.batchId}-${email.recipientId}`;

    // Add traceId to NATS message headers for distributed tracing
    const hdrs = natsHeaders();
    const traceId = getTraceId();
    if (traceId) {
      hdrs.set("X-Trace-Id", traceId);
    }

    try {
      const ack = await this.js.publish(
        `email.user.${userId}.send`,
        this.sc.encode(JSON.stringify(email)),
        {
          msgID, // Deduplication
          headers: hdrs,
          expect: {
            streamName: "email-system",
          },
        }
      );

      if (!ack.duplicate) {
        log.queue.debug(
          {
            batchId: email.batchId,
            recipientId: email.recipientId,
            to: email.email,
            seq: ack.seq,
          },
          "email enqueued"
        );
      }
    } catch (error) {
      log.queue.error(
        { error, batchId: email.batchId, recipientId: email.recipientId },
        "failed to enqueue email"
      );
      throw error;
    }
  }

  // Bulk email operations (optimized for performance)
  async enqueueEmails(userId: string, emails: EmailJobData[]): Promise<EnqueueResult> {
    if (emails.length === 0) {
      return { success: 0, failed: 0, errors: [] };
    }

    const timer = createTimer();
    const CHUNK_SIZE = 1000;
    let successCount = 0;
    const errors: Array<{ email: string; error: string }> = [];

    // Process in chunks to avoid overwhelming NATS
    for (let i = 0; i < emails.length; i += CHUNK_SIZE) {
      const chunk = emails.slice(i, i + CHUNK_SIZE);

      // Use Promise.allSettled to handle partial failures
      const results = await Promise.allSettled(
        chunk.map((email) => this.enqueueEmail(userId, email))
      );

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          successCount++;
        } else {
          const errorMessage = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
          errors.push({
            email: chunk[index].email || chunk[index].identifier || "",
            error: errorMessage,
          });
          enqueueFailuresTotal.inc({ queue: "email" });
        }
      });
    }

    log.queue.info(
      {
        userId,
        batchId: emails[0]?.batchId,
        total: emails.length,
        success: successCount,
        failed: errors.length,
        duration: timer(),
      },
      "bulk email enqueue completed"
    );

    if (errors.length > 0) {
      log.queue.error(
        {
          errors: errors.slice(0, 10),
          totalFailed: errors.length,
          totalAttempted: emails.length,
        },
        "some emails failed to enqueue"
      );
    }

    return {
      success: successCount,
      failed: errors.length,
      errors,
    };
  }

  // Get queue statistics
  async getQueueStats(): Promise<StreamStats> {
    try {
      const jsm = this.natsClient.getJetStreamManager();
      const stream = await jsm.streams.info("email-system");

      // Get consumer info
      const batchConsumer = await jsm.consumers.info("email-system", "batch-processor").catch(() => null);

      const totalMessages = stream.state.messages;

      return {
        batch: {
          pending: batchConsumer?.num_pending || 0,
          consumers: batchConsumer ? 1 : 0,
          bytes: Math.floor(stream.state.bytes * 0.1), // Estimate
        },
        email: {
          pending: totalMessages - (batchConsumer?.num_pending || 0),
          consumers: stream.state.consumer_count - 1, // Minus batch
          bytes: Math.floor(stream.state.bytes * 0.9), // Estimate
        },
      };
    } catch (error) {
      log.queue.error({ error }, "failed to get queue stats");
      throw error;
    }
  }

  // Get user-specific queue stats
  async getUserQueueStats(userId: string): Promise<QueueStats | null> {
    try {
      const jsm = this.natsClient.getJetStreamManager();
      const consumerName = `user-${userId}`;

      const consumer = await jsm.consumers.info("email-system", consumerName).catch(() => null);

      if (!consumer) {
        return null;
      }

      return {
        pending: consumer.num_pending,
        consumers: 1,
        bytes: 0, // Not available per-consumer
        oldestMessageAge: consumer.delivered.stream_seq > 0
          ? Date.now() - new Date(consumer.created).getTime()
          : 0,
      };
    } catch (error) {
      log.queue.error({ error, userId }, "failed to get user queue stats");
      return null;
    }
  }

  // Check if a specific job exists (for deduplication)
  async jobExists(msgID: string): Promise<boolean> {
    try {
      const jsm = this.natsClient.getJetStreamManager();
      const stream = await jsm.streams.info("email-system");

      // This is a simplified check - in production you might want to
      // maintain a separate KV store for job tracking
      return false; // NATS handles deduplication internally via msgID
    } catch (error) {
      log.queue.error({ error, msgID }, "failed to check job existence");
      return false;
    }
  }

  // Clean up old consumers (maintenance task)
  async cleanupIdleConsumers(): Promise<void> {
    try {
      const jsm = this.natsClient.getJetStreamManager();
      const consumers = await jsm.consumers.list("email-system").next();

      let cleaned = 0;
      for (const consumer of consumers) {
        // Skip system consumers
        if (consumer.name === "batch-processor") {
          continue;
        }

        // Check if consumer is idle (no pending messages and old)
        if (
          consumer.num_pending === 0 &&
          consumer.delivered.consumer_seq > 0 &&
          Date.now() - new Date(consumer.created).getTime() > 3600000 // 1 hour
        ) {
          try {
            await jsm.consumers.delete("email-system", consumer.name);
            cleaned++;
            log.queue.info({ consumer: consumer.name }, "deleted idle consumer");
          } catch (error) {
            log.queue.error({ error, consumer: consumer.name }, "failed to delete consumer");
          }
        }
      }

      if (cleaned > 0) {
        log.queue.info({ count: cleaned }, "cleaned up idle consumers");
      }
    } catch (error) {
      log.queue.error({ error }, "failed to cleanup idle consumers");
    }
  }

  // Webhook operations
  async enqueueWebhook(event: {
    id: string;
    provider: string;
    eventType: string;
    providerMessageId: string;
    recipientId?: string;
    batchId?: string;
    userId?: string;
    timestamp: string;
    metadata?: Record<string, any>;
    rawEvent?: any;
  }): Promise<void> {
    const timer = createTimer();

    try {
      const ack = await this.js.publish(
        `webhook.${event.provider}.${event.eventType}`,
        this.sc.encode(JSON.stringify(event)),
        {
          msgID: event.id, // Prevent duplicate processing
          expect: {
            streamName: "webhooks",
          },
        }
      );

      log.webhook.debug(
        {
          provider: event.provider,
          eventType: event.eventType,
          seq: ack.seq,
          duplicate: ack.duplicate,
          duration: timer(),
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
}