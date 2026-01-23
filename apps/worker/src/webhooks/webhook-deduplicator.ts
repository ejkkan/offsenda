import { WebhookEvent } from "./queue-processor.js";
import { CacheService } from "../services/cache-service.js";
import { log } from "../logger.js";

export interface DeduplicationResult {
  newEvents: WebhookEvent[];
  duplicates: WebhookEvent[];
  stats: {
    total: number;
    duplicates: number;
    new: number;
    cacheHits: number;
    cacheMisses: number;
  };
}

/**
 * Service responsible for webhook deduplication
 *
 * Simplified deduplication strategy (no Dragonfly dedup):
 * 1. In-memory cache (fastest, 5 minutes) - catches rapid duplicates
 * 2. NATS JetStream dedup (1 hour) - catches duplicates at publish time
 * 3. PostgreSQL unique constraints (permanent) - final safety net
 *
 * The CacheService is still used for message lookup caching (not dedup).
 */
export class WebhookDeduplicator {
  private processedEvents = new Map<string, number>(); // In-memory cache with timestamp
  private readonly memoryTtlMs = 300_000; // 5 minutes in-memory cache (extended from 1 min)

  constructor(private cacheService: CacheService) {}

  /**
   * Check events for duplicates using simplified strategy:
   * 1. In-memory cache (fastest, 5 minutes) - catches rapid duplicates
   * 2. NATS JetStream handles 1-hour dedup at publish time
   * 3. PostgreSQL constraints handle permanent dedup
   *
   * No Dragonfly check - simplifies architecture and reduces memory usage.
   */
  async deduplicateBatch(events: WebhookEvent[]): Promise<DeduplicationResult> {
    const stats = {
      total: events.length,
      duplicates: 0,
      new: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };

    const newEvents: WebhookEvent[] = [];
    const duplicates: WebhookEvent[] = [];

    // Check in-memory cache only (NATS handles 1-hour dedup at publish)
    for (const event of events) {
      const key = this.getEventKey(event);
      const processedAt = this.processedEvents.get(key);

      if (processedAt && Date.now() - processedAt < this.memoryTtlMs) {
        duplicates.push(event);
        stats.duplicates++;
        stats.cacheHits++;
        log.webhook.debug({
          provider: event.provider,
          messageId: event.providerMessageId,
          eventType: event.eventType,
        }, "Duplicate found in memory cache");
      } else {
        newEvents.push(event);
        stats.new++;
        stats.cacheMisses++;
      }
    }

    // Clean up old entries from memory cache
    this.cleanupMemoryCache();

    return {
      newEvents,
      duplicates,
      stats,
    };
  }

  /**
   * Mark events as processed in in-memory cache.
   * No Dragonfly update needed - NATS handles 1-hour dedup, PostgreSQL handles permanent.
   */
  markProcessed(events: WebhookEvent[]): void {
    const now = Date.now();

    // Update in-memory cache only
    for (const event of events) {
      const key = this.getEventKey(event);
      this.processedEvents.set(key, now);
    }
  }

  /**
   * Generate a unique key for an event (used for in-memory dedup)
   */
  private getEventKey(event: WebhookEvent): string {
    return `${event.provider}:${event.providerMessageId}:${event.eventType}`;
  }

  /**
   * Clean up old entries from memory cache
   */
  private cleanupMemoryCache(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, timestamp] of this.processedEvents.entries()) {
      if (now - timestamp > this.memoryTtlMs) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.processedEvents.delete(key);
    }

    if (keysToDelete.length > 0) {
      log.webhook.debug({ count: keysToDelete.length }, "Cleaned up memory cache");
    }
  }

  /**
   * Get memory cache statistics
   */
  getStats() {
    return {
      memoryCacheSize: this.processedEvents.size,
      oldestEntry: Math.min(...Array.from(this.processedEvents.values())) || 0,
    };
  }

  /**
   * Clear all caches (for testing)
   */
  clearMemoryCache(): void {
    this.processedEvents.clear();
  }
}