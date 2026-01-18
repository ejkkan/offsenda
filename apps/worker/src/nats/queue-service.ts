import { JetStreamClient, StringCodec, headers as natsHeaders } from "nats";
import type { SendConfig, SendConfigData, RateLimitConfig, ModuleType, BatchPayload } from "@batchsender/db";
import { NatsClient } from "./client.js";
import { log, createTimer, getTraceId } from "../logger.js";

// Job types
export interface BatchJobData {
  batchId: string;
  userId: string;
  dryRun?: boolean;
}

/**
 * Embedded send config - included in job messages to avoid DB lookups during processing
 */
export interface EmbeddedSendConfig {
  id: string;
  module: ModuleType;
  config: SendConfigData;
  rateLimit?: RateLimitConfig | null;
}

export interface JobData {
  batchId: string;
  recipientId: string;
  userId: string;
  // GENERIC: Works for any channel (email, phone, device token, URL)
  identifier: string;
  // LEGACY: Email address (for backwards compatibility)
  email?: string;
  name?: string;
  variables?: Record<string, string>;
  // Embedded send config (no DB lookup needed during processing)
  sendConfig: EmbeddedSendConfig;
  // GENERIC: Module-specific payload (new)
  payload?: BatchPayload;
  // LEGACY: Email-specific fields (for backwards compatibility)
  fromEmail?: string;
  fromName?: string;
  subject?: string;
  htmlContent?: string;
  textContent?: string;
  // Webhook-specific fields (for webhook module)
  data?: Record<string, unknown>;
  // Dry run mode - skip actual outbound calls
  dryRun?: boolean;
}

// Legacy alias for backwards compatibility
export type EmailJobData = JobData;

export interface QueueStats {
  pending: number;
  consumers: number;
  bytes: number;
  oldestMessageAge?: number;
}

export interface StreamStats {
  batch: QueueStats;
  email: QueueStats;
  priority: QueueStats;
}

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
  async enqueueEmails(userId: string, emails: EmailJobData[]): Promise<void> {
    if (emails.length === 0) return;

    const timer = createTimer();
    const CHUNK_SIZE = 1000;
    let successCount = 0;
    let duplicateCount = 0;
    const errors: any[] = [];

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
          errors.push({
            email: chunk[index].email,
            error: result.reason,
          });
        }
      });
    }

    log.queue.info(
      {
        userId,
        batchId: emails[0]?.batchId,
        total: emails.length,
        success: successCount,
        duplicates: duplicateCount,
        errors: errors.length,
        duration: timer(),
      },
      "bulk email enqueue completed"
    );

    if (errors.length > 0) {
      log.queue.error({ errors: errors.slice(0, 10) }, "some emails failed to enqueue");
    }
  }

  // Priority email operations
  async enqueuePriorityEmail(email: EmailJobData): Promise<void> {
    const msgID = `priority-${email.batchId}-${email.recipientId}`;

    // Add traceId to NATS message headers for distributed tracing
    const hdrs = natsHeaders();
    const traceId = getTraceId();
    if (traceId) {
      hdrs.set("X-Trace-Id", traceId);
    }

    try {
      const ack = await this.js.publish(
        "email.priority.send",
        this.sc.encode(JSON.stringify(email)),
        {
          msgID,
          headers: hdrs,
          expect: {
            streamName: "email-system",
          },
        }
      );

      log.queue.info(
        {
          recipientId: email.recipientId,
          to: email.email,
          seq: ack.seq,
          duplicate: ack.duplicate,
        },
        "priority email enqueued"
      );
    } catch (error) {
      log.queue.error(
        { error, recipientId: email.recipientId },
        "failed to enqueue priority email"
      );
      throw error;
    }
  }

  // Get queue statistics
  async getQueueStats(): Promise<StreamStats> {
    try {
      const jsm = this.natsClient.getJetStreamManager();
      const stream = await jsm.streams.info("email-system");

      // Get consumer info for each type
      const [batchConsumer, priorityConsumer] = await Promise.all([
        jsm.consumers.info("email-system", "batch-processor").catch(() => null),
        jsm.consumers.info("email-system", "priority-processor").catch(() => null),
      ]);

      // Count messages per subject pattern
      let batchPending = 0;
      let emailPending = 0;
      let priorityPending = 0;

      // NATS doesn't provide per-subject counts directly, so we estimate from total
      // In production, you'd want to track this separately or use stream subject transforms
      const totalMessages = stream.state.messages;

      return {
        batch: {
          pending: batchConsumer?.num_pending || 0,
          consumers: batchConsumer ? 1 : 0,
          bytes: Math.floor(stream.state.bytes * 0.1), // Estimate
        },
        email: {
          pending: totalMessages - (batchConsumer?.num_pending || 0) - (priorityConsumer?.num_pending || 0),
          consumers: stream.state.consumer_count - 2, // Minus batch and priority
          bytes: Math.floor(stream.state.bytes * 0.8), // Estimate
        },
        priority: {
          pending: priorityConsumer?.num_pending || 0,
          consumers: priorityConsumer ? 1 : 0,
          bytes: Math.floor(stream.state.bytes * 0.1), // Estimate
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
        if (consumer.name === "batch-processor" || consumer.name === "priority-processor") {
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
}