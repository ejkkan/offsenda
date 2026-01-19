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
 * Handles multi-layer deduplication strategy
 */
export class WebhookDeduplicator {
  private processedEvents = new Map<string, number>(); // In-memory cache with timestamp
  private readonly memoryTtlMs = 60_000; // 1 minute in-memory cache

  constructor(private cacheService: CacheService) {}

  /**
   * Check events for duplicates using multi-layer strategy
   * 1. In-memory cache (fastest, 1 minute)
   * 2. Redis/Dragonfly cache (fast, 24 hours)
   * 3. Database constraints (slowest, permanent)
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

    // First pass: Check in-memory cache
    const eventsNeedingCacheCheck: WebhookEvent[] = [];

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
        eventsNeedingCacheCheck.push(event);
      }
    }

    // Clean up old entries from memory cache
    this.cleanupMemoryCache();

    // Second pass: Check distributed cache
    if (eventsNeedingCacheCheck.length > 0) {
      const cacheChecks = eventsNeedingCacheCheck.map(e => ({
        provider: e.provider,
        messageId: e.providerMessageId,
        eventType: e.eventType,
      }));

      const processedMap = await this.cacheService.batchCheckWebhooksProcessed(cacheChecks);

      for (const event of eventsNeedingCacheCheck) {
        const key = this.getCacheKey(event);
        if (processedMap.get(key)) {
          duplicates.push(event);
          stats.duplicates++;
          stats.cacheHits++;
          // Add to memory cache
          this.processedEvents.set(this.getEventKey(event), Date.now());
        } else {
          newEvents.push(event);
          stats.new++;
          stats.cacheMisses++;
        }
      }
    }

    return {
      newEvents,
      duplicates,
      stats,
    };
  }

  /**
   * Mark events as processed in all cache layers
   */
  async markProcessed(events: WebhookEvent[]): Promise<void> {
    const now = Date.now();

    // Update in-memory cache
    for (const event of events) {
      const key = this.getEventKey(event);
      this.processedEvents.set(key, now);
    }

    // Update distributed cache
    const cachePromises = events.map(event =>
      this.cacheService.markWebhookProcessed(
        event.provider,
        event.providerMessageId,
        event.eventType
      )
    );

    try {
      await Promise.all(cachePromises);
    } catch (error) {
      log.webhook.warn({ error }, "Failed to mark some events as processed in cache");
      // Continue - cache is not critical
    }
  }

  /**
   * Generate a unique key for an event
   */
  private getEventKey(event: WebhookEvent): string {
    return `${event.provider}:${event.providerMessageId}:${event.eventType}`;
  }

  /**
   * Generate cache lookup key
   */
  private getCacheKey(event: WebhookEvent): string {
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