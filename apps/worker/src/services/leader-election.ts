/**
 * Leader Election Service
 *
 * Implements distributed leader election using Dragonfly (Redis) SET NX EX.
 * Only one worker becomes the leader and runs scheduled tasks like:
 * - SchedulerService (checking scheduled batches)
 * - BatchRecoveryService (detecting stuck batches)
 *
 * This prevents 50 workers from all running the same scheduler,
 * which wastes resources and can cause duplicate processing.
 */

import Redis from "ioredis";
import { config } from "../config.js";
import { log } from "../logger.js";

const LEADER_KEY = "batchsender:leader";
const LEADER_TTL_SECONDS = 30; // Lock expires after 30 seconds
const HEARTBEAT_INTERVAL_MS = 10_000; // Refresh lock every 10 seconds

interface LeaderElectionOptions {
  workerId?: string;
  ttlSeconds?: number;
  heartbeatIntervalMs?: number;
}

export class LeaderElectionService {
  private redis: Redis;
  private isLeader = false;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private readonly workerId: string;
  private readonly ttlSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private isRunning = false;
  private onBecomeLeader?: () => void;
  private onLoseLeadership?: () => void;

  constructor(options: LeaderElectionOptions = {}) {
    this.workerId = options.workerId || config.WORKER_ID || `worker-${process.pid}`;
    this.ttlSeconds = options.ttlSeconds || LEADER_TTL_SECONDS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS;

    const dragonflyUrl = config.DRAGONFLY_URL || "localhost:6379";
    this.redis = new Redis({
      host: dragonflyUrl.split(":")[0] || "localhost",
      port: parseInt(dragonflyUrl.split(":")[1] || "6379"),
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      lazyConnect: true,
    });

    this.redis.on("error", (error) => {
      log.system.error({ error }, "Leader election Redis error");
    });
  }

  /**
   * Check if this worker is currently the leader
   */
  isCurrentLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Register callback for when this worker becomes leader
   */
  onLeader(callback: () => void): void {
    this.onBecomeLeader = callback;
  }

  /**
   * Register callback for when this worker loses leadership
   */
  onLostLeadership(callback: () => void): void {
    this.onLoseLeadership = callback;
  }

  /**
   * Start the leader election process
   * Attempts to acquire leadership immediately, then maintains it with heartbeats
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log.system.warn({ workerId: this.workerId }, "Leader election already running");
      return;
    }

    try {
      await this.redis.connect();
    } catch (error) {
      log.system.error({ error }, "Failed to connect for leader election");
      // Continue without leader election - services will run on all workers
      return;
    }

    this.isRunning = true;

    // Try to become leader immediately
    await this.tryBecomeLeader();

    // Start heartbeat loop
    this.heartbeatInterval = setInterval(async () => {
      if (this.isLeader) {
        // Maintain leadership
        await this.maintainLeadership();
      } else {
        // Try to acquire leadership (current leader may have died)
        await this.tryBecomeLeader();
      }
    }, this.heartbeatIntervalMs);

    log.system.info(
      { workerId: this.workerId, isLeader: this.isLeader },
      "Leader election started"
    );
  }

  /**
   * Try to become the leader using SET NX EX (atomic set-if-not-exists with expiry)
   */
  private async tryBecomeLeader(): Promise<boolean> {
    try {
      // SET key value NX EX ttl - only sets if key doesn't exist
      const result = await this.redis.set(
        LEADER_KEY,
        this.workerId,
        "EX",
        this.ttlSeconds,
        "NX"
      );

      const wasLeader = this.isLeader;
      this.isLeader = result === "OK";

      if (this.isLeader && !wasLeader) {
        log.system.info({ workerId: this.workerId }, "Acquired leadership");
        this.onBecomeLeader?.();
      }

      return this.isLeader;
    } catch (error) {
      log.system.error({ error }, "Failed to acquire leadership");
      return false;
    }
  }

  /**
   * Maintain leadership by refreshing the TTL
   * Only the current leader should call this
   */
  private async maintainLeadership(): Promise<void> {
    try {
      // Use Lua script for atomic check-and-refresh
      // Only refresh if we still own the lock
      const script = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          redis.call("EXPIRE", KEYS[1], ARGV[2])
          return 1
        end
        return 0
      `;

      const result = await this.redis.eval(
        script,
        1,
        LEADER_KEY,
        this.workerId,
        this.ttlSeconds
      );

      if (result === 0) {
        // We lost leadership (someone else took over or key expired)
        if (this.isLeader) {
          log.system.warn({ workerId: this.workerId }, "Lost leadership");
          this.isLeader = false;
          this.onLoseLeadership?.();
        }
      }
    } catch (error) {
      log.system.error({ error }, "Failed to maintain leadership");
      // Assume we lost leadership on error
      if (this.isLeader) {
        this.isLeader = false;
        this.onLoseLeadership?.();
      }
    }
  }

  /**
   * Get the current leader's worker ID
   */
  async getCurrentLeader(): Promise<string | null> {
    try {
      return await this.redis.get(LEADER_KEY);
    } catch (error) {
      log.system.error({ error }, "Failed to get current leader");
      return null;
    }
  }

  /**
   * Voluntarily release leadership (for graceful shutdown)
   */
  async releaseLeadership(): Promise<void> {
    if (!this.isLeader) return;

    try {
      // Only delete if we still own the lock
      const script = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          redis.call("DEL", KEYS[1])
          return 1
        end
        return 0
      `;

      await this.redis.eval(script, 1, LEADER_KEY, this.workerId);
      log.system.info({ workerId: this.workerId }, "Released leadership");
    } catch (error) {
      log.system.error({ error }, "Failed to release leadership");
    }

    this.isLeader = false;
  }

  /**
   * Stop the leader election service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    // Release leadership gracefully
    await this.releaseLeadership();

    await this.redis.quit();
    log.system.info({ workerId: this.workerId }, "Leader election stopped");
  }
}

// Singleton instance
let leaderElectionInstance: LeaderElectionService | null = null;

/**
 * Get the singleton leader election service instance
 */
export function getLeaderElection(): LeaderElectionService {
  if (!leaderElectionInstance) {
    leaderElectionInstance = new LeaderElectionService();
  }
  return leaderElectionInstance;
}

/**
 * Close the singleton leader election (for cleanup)
 */
export async function closeLeaderElection(): Promise<void> {
  if (leaderElectionInstance) {
    await leaderElectionInstance.stop();
    leaderElectionInstance = null;
  }
}
