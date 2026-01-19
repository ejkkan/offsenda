import Redis from "ioredis";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Cache service for webhook deduplication and message lookup caching
 */
export class CacheService {
  private redis: Redis;
  private isConnected = false;

  constructor() {
    this.redis = new Redis(config.DRAGONFLY_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) {
          log.cache.error({ attempts: times }, "Cache connection failed");
          return null; // Stop retrying
        }
        return Math.min(times * 100, 2000);
      },
      reconnectOnError: (err) => {
        const targetError = "READONLY";
        if (err.message.includes(targetError)) {
          // Only reconnect when we get READONLY error
          return true;
        }
        return false;
      },
    });

    this.redis.on("connect", () => {
      this.isConnected = true;
      log.cache.info("Cache connected");
    });

    this.redis.on("error", (error) => {
      log.cache.error({ error }, "Cache error");
      this.isConnected = false;
    });

    this.redis.on("close", () => {
      this.isConnected = false;
      log.cache.info("Cache disconnected");
    });
  }

  /**
   * Check if webhook has been processed recently (deduplication)
   */
  async checkWebhookProcessed(
    provider: string,
    messageId: string,
    eventType: string
  ): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      const key = `webhook:${provider}:${messageId}:${eventType}`;
      const result = await this.redis.get(key);
      return result !== null;
    } catch (error) {
      log.cache.debug({ error }, "Failed to check webhook dedup");
      return false; // Fail open - process webhook if cache is down
    }
  }

  /**
   * Mark webhook as processed (for deduplication)
   */
  async markWebhookProcessed(
    provider: string,
    messageId: string,
    eventType: string,
    ttlSeconds: number = config.WEBHOOK_DEDUP_TTL
  ): Promise<void> {
    if (!this.isConnected) return;

    try {
      const key = `webhook:${provider}:${messageId}:${eventType}`;
      await this.redis.setex(key, ttlSeconds, "1");
    } catch (error) {
      log.cache.debug({ error }, "Failed to mark webhook processed");
      // Continue processing - fail open
    }
  }

  /**
   * Get cached message lookup result
   */
  async getCachedMessageLookup(
    providerMessageId: string
  ): Promise<{ recipientId: string; batchId: string; userId: string } | null> {
    if (!this.isConnected) return null;

    try {
      const key = `msgid:${providerMessageId}`;
      const result = await this.redis.get(key);
      if (result) {
        return JSON.parse(result);
      }
      return null;
    } catch (error) {
      log.cache.debug({ error }, "Failed to get cached message lookup");
      return null;
    }
  }

  /**
   * Cache message lookup result
   */
  async cacheMessageLookup(
    providerMessageId: string,
    lookup: { recipientId: string; batchId: string; userId: string },
    ttlSeconds: number = 86400 // 24 hours
  ): Promise<void> {
    if (!this.isConnected) return;

    try {
      const key = `msgid:${providerMessageId}`;
      await this.redis.setex(key, ttlSeconds, JSON.stringify(lookup));
    } catch (error) {
      log.cache.debug({ error }, "Failed to cache message lookup");
      // Continue - non-critical
    }
  }

  /**
   * Batch get cached message lookups
   */
  async batchGetCachedMessageLookups(
    messageIds: string[]
  ): Promise<Map<string, { recipientId: string; batchId: string; userId: string }>> {
    const results = new Map<string, { recipientId: string; batchId: string; userId: string }>();

    if (!this.isConnected || messageIds.length === 0) return results;

    try {
      const pipeline = this.redis.pipeline();

      for (const messageId of messageIds) {
        pipeline.get(`msgid:${messageId}`);
      }

      const pipelineResults = await pipeline.exec();

      if (pipelineResults) {
        pipelineResults.forEach((result, index) => {
          if (result && result[1]) {
            try {
              const parsed = JSON.parse(result[1] as string);
              results.set(messageIds[index], parsed);
            } catch (error) {
              log.cache.debug({ error, messageId: messageIds[index] }, "Failed to parse cached lookup");
            }
          }
        });
      }
    } catch (error) {
      log.cache.debug({ error }, "Failed to batch get cached lookups");
    }

    return results;
  }

  /**
   * Batch check for webhook deduplication
   */
  async batchCheckWebhooksProcessed(
    webhooks: Array<{ provider: string; messageId: string; eventType: string }>
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    if (!this.isConnected) {
      // Return all false if not connected
      webhooks.forEach((w) => {
        const key = `${w.provider}:${w.messageId}:${w.eventType}`;
        results.set(key, false);
      });
      return results;
    }

    try {
      const pipeline = this.redis.pipeline();
      const keys: string[] = [];

      webhooks.forEach((w) => {
        const redisKey = `webhook:${w.provider}:${w.messageId}:${w.eventType}`;
        const mapKey = `${w.provider}:${w.messageId}:${w.eventType}`;
        keys.push(mapKey);
        pipeline.exists(redisKey);
      });

      const pipelineResults = await pipeline.exec();

      if (pipelineResults) {
        pipelineResults.forEach((result, index) => {
          const exists = result && result[1] === 1;
          results.set(keys[index], exists);
        });
      }
    } catch (error) {
      log.cache.debug({ error }, "Failed to batch check webhooks");
      // Return all false on error
      webhooks.forEach((w) => {
        const key = `${w.provider}:${w.messageId}:${w.eventType}`;
        results.set(key, false);
      });
    }

    return results;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isConnected) return false;

    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// Singleton instance
let cacheService: CacheService | null = null;

export function getCacheService(): CacheService {
  if (!cacheService) {
    cacheService = new CacheService();
  }
  return cacheService;
}