import { WebhookEvent } from "./queue-processor.js";
import { CacheService } from "../services/cache-service.js";
import { lookupByProviderMessageId } from "../clickhouse.js";
import { log } from "../logger.js";

export interface EnrichmentResult {
  enrichedEvents: WebhookEvent[];
  skippedEvents: WebhookEvent[];
  stats: {
    total: number;
    enriched: number;
    skipped: number;
    cacheHits: number;
    clickhouseLookups: number;
  };
}

/**
 * Service responsible for enriching webhook events with recipient information
 * Uses cache-first strategy with ClickHouse fallback
 */
export class WebhookEnricher {
  private lookupStats = {
    cacheHits: 0,
    cacheMisses: 0,
    clickhouseHits: 0,
    clickhouseMisses: 0,
  };

  constructor(private cacheService: CacheService) {}

  /**
   * Enrich a batch of events with recipient information
   */
  async enrichBatch(events: WebhookEvent[]): Promise<EnrichmentResult> {
    const stats = {
      total: events.length,
      enriched: 0,
      skipped: 0,
      cacheHits: 0,
      clickhouseLookups: 0,
    };

    const enrichedEvents: WebhookEvent[] = [];
    const skippedEvents: WebhookEvent[] = [];
    const eventsNeedingLookup: WebhookEvent[] = [];

    // First pass: separate events that already have recipient info
    for (const event of events) {
      if (event.recipientId) {
        enrichedEvents.push(event);
        stats.enriched++;
      } else if (!event.providerMessageId) {
        // Can't look up without provider message ID
        skippedEvents.push(event);
        stats.skipped++;
        log.webhook.debug({
          provider: event.provider,
          eventType: event.eventType,
        }, "Skipping event without provider message ID");
      } else {
        eventsNeedingLookup.push(event);
      }
    }

    // Second pass: check cache for events needing lookup
    const eventsNeedingClickHouse: WebhookEvent[] = [];

    for (const event of eventsNeedingLookup) {
      const cached = await this.cacheService.getCachedMessageLookup(event.providerMessageId);

      if (cached) {
        event.recipientId = cached.recipientId;
        event.batchId = cached.batchId;
        event.userId = cached.userId;
        enrichedEvents.push(event);
        stats.enriched++;
        stats.cacheHits++;
        this.lookupStats.cacheHits++;

        log.webhook.debug({
          messageId: event.providerMessageId,
          recipientId: cached.recipientId,
        }, "Found recipient info in cache");
      } else {
        eventsNeedingClickHouse.push(event);
        this.lookupStats.cacheMisses++;
      }
    }

    // Third pass: batch lookup from ClickHouse
    if (eventsNeedingClickHouse.length > 0) {
      await this.lookupFromClickHouse(
        eventsNeedingClickHouse,
        enrichedEvents,
        skippedEvents,
        stats
      );
    }

    return {
      enrichedEvents,
      skippedEvents,
      stats,
    };
  }

  /**
   * Lookup events from ClickHouse and update cache
   */
  private async lookupFromClickHouse(
    events: WebhookEvent[],
    enrichedEvents: WebhookEvent[],
    skippedEvents: WebhookEvent[],
    stats: {
      enriched: number;
      skipped: number;
      clickhouseLookups: number;
    }
  ): Promise<void> {
    // Process lookups in parallel with concurrency limit
    const concurrencyLimit = 10;
    const chunks = this.chunkArray(events, concurrencyLimit);

    for (const chunk of chunks) {
      const lookupPromises = chunk.map(async (event) => {
        try {
          stats.clickhouseLookups++;
          const lookup = await lookupByProviderMessageId(event.providerMessageId);

          if (lookup) {
            event.recipientId = lookup.recipient_id;
            event.batchId = lookup.batch_id;
            event.userId = lookup.user_id;
            enrichedEvents.push(event);
            stats.enriched++;
            this.lookupStats.clickhouseHits++;

            // Cache the result
            await this.cacheService.cacheMessageLookup(event.providerMessageId, {
              recipientId: lookup.recipient_id,
              batchId: lookup.batch_id,
              userId: lookup.user_id,
            });

            log.webhook.debug({
              messageId: event.providerMessageId,
              recipientId: lookup.recipient_id,
            }, "Found recipient info in ClickHouse");
          } else {
            skippedEvents.push(event);
            stats.skipped++;
            this.lookupStats.clickhouseMisses++;

            log.webhook.debug({
              messageId: event.providerMessageId,
            }, "Message not found in ClickHouse");
          }
        } catch (error) {
          skippedEvents.push(event);
          stats.skipped++;

          log.webhook.error({
            error,
            messageId: event.providerMessageId,
          }, "Failed to lookup message in ClickHouse");
        }
      });

      await Promise.all(lookupPromises);
    }

    // Log summary if there were skipped events
    if (skippedEvents.length > 0) {
      log.webhook.warn({
        count: skippedEvents.length,
        messageIds: skippedEvents.slice(0, 10).map(e => e.providerMessageId),
      }, "Events without recipient info will be skipped");
    }
  }

  /**
   * Split array into chunks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Get enrichment statistics
   */
  getStats() {
    return {
      ...this.lookupStats,
      hitRate: this.lookupStats.cacheHits / (this.lookupStats.cacheHits + this.lookupStats.cacheMisses) || 0,
    };
  }

  /**
   * Reset statistics (for testing)
   */
  resetStats(): void {
    this.lookupStats = {
      cacheHits: 0,
      cacheMisses: 0,
      clickhouseHits: 0,
      clickhouseMisses: 0,
    };
  }
}