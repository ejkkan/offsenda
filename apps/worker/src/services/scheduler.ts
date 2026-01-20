import { eq, and, lte } from "drizzle-orm";
import { batches } from "@batchsender/db";
import { db } from "../db.js";
import { NatsQueueService } from "../nats/queue-service.js";
import { log } from "../logger.js";
import { LeaderElectionService } from "./leader-election.js";

/**
 * Scheduler Service
 *
 * Periodically checks for scheduled batches that are ready to send
 * and queues them for processing.
 *
 * Runs every 30 seconds, finds batches where:
 * - status = 'scheduled'
 * - scheduledAt <= now
 *
 * Then updates status to 'queued' and publishes to NATS.
 *
 * IMPORTANT: Only runs on the leader worker to prevent duplicate processing
 * across multiple worker instances.
 */
export class SchedulerService {
  private intervalId?: ReturnType<typeof setInterval>;
  private isRunning = false;
  private readonly checkIntervalMs = 30_000; // 30 seconds
  private leaderElection?: LeaderElectionService;

  constructor(
    private queueService: NatsQueueService,
    leaderElection?: LeaderElectionService
  ) {
    this.leaderElection = leaderElection;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.intervalId) {
      log.system.warn("Scheduler already running");
      return;
    }

    log.system.info({ intervalMs: this.checkIntervalMs }, "Scheduler started");

    // Run immediately on start
    this.checkScheduledBatches().catch((err) => {
      log.system.error({ error: err }, "Scheduler check failed");
    });

    // Then run periodically
    this.intervalId = setInterval(() => {
      this.checkScheduledBatches().catch((err) => {
        log.system.error({ error: err }, "Scheduler check failed");
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      log.system.info("Scheduler stopped");
    }
  }

  /**
   * Check for scheduled batches and queue them
   */
  private async checkScheduledBatches(): Promise<void> {
    // Only run if we're the leader (or no leader election configured)
    if (this.leaderElection && !this.leaderElection.isCurrentLeader()) {
      return;
    }

    // Prevent concurrent runs
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      const now = new Date();

      // Find batches ready to send
      const readyBatches = await db
        .select({
          id: batches.id,
          userId: batches.userId,
          name: batches.name,
          scheduledAt: batches.scheduledAt,
        })
        .from(batches)
        .where(
          and(
            eq(batches.status, "scheduled"),
            lte(batches.scheduledAt, now)
          )
        )
        .limit(100);

      if (readyBatches.length === 0) {
        return;
      }

      log.system.info(
        { count: readyBatches.length },
        "Found scheduled batches ready to send"
      );

      for (const batch of readyBatches) {
        try {
          // Update status to queued (with optimistic locking)
          const result = await db
            .update(batches)
            .set({
              status: "queued",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(batches.id, batch.id),
                eq(batches.status, "scheduled") // Only update if still scheduled
              )
            );

          // Check if we actually updated the row (another worker might have gotten it)
          // Drizzle doesn't return rowCount easily, but the update won't fail
          // The NATS deduplication will prevent double-processing anyway

          // Queue for processing
          await this.queueService.enqueueBatch(batch.id, batch.userId);

          log.batch.info(
            {
              id: batch.id,
              name: batch.name,
              scheduledAt: batch.scheduledAt,
            },
            "Scheduled batch queued"
          );
        } catch (error) {
          log.batch.error(
            { id: batch.id, error },
            "Failed to queue scheduled batch"
          );
          // Continue with other batches
        }
      }
    } finally {
      this.isRunning = false;
    }
  }
}
