import { db } from "../db.js";
import { recipients, batches } from "@batchsender/db";
import { eq, and, or, sql } from "drizzle-orm";
import { log } from "../logger.js";
import { getCacheService } from "./cache-service.js";
import { lookupByProviderMessageId } from "../clickhouse.js";

/**
 * Webhook Matching Service
 *
 * Implements flexible matching strategies to link incoming webhooks
 * to recipients and batches. Supports multiple identification methods:
 * - Provider message ID (primary)
 * - Email address
 * - Phone number
 * - Custom identifiers
 */

export interface WebhookMatchResult {
  recipientId: string;
  batchId: string;
  userId: string;
  matchType: "messageId" | "identifier" | "custom";
}

export interface MatchingStrategy {
  /**
   * Name of the strategy for logging
   */
  name: string;

  /**
   * Try to match the webhook to a recipient
   */
  match(event: any): Promise<WebhookMatchResult | null>;
}

/**
 * Match by provider message ID (most reliable)
 */
class MessageIdMatcher implements MatchingStrategy {
  name = "messageId";

  async match(event: any): Promise<WebhookMatchResult | null> {
    const messageId = event.providerMessageId;
    if (!messageId) return null;

    const cacheService = getCacheService();

    // Try cache first
    const cached = await cacheService.getCachedMessageLookup(messageId);
    if (cached) {
      return {
        recipientId: cached.recipientId,
        batchId: cached.batchId,
        userId: cached.userId,
        matchType: "messageId",
      };
    }

    // Try database
    const recipient = await db.query.recipients.findFirst({
      where: eq(recipients.providerMessageId, messageId),
      with: {
        batch: {
          columns: {
            id: true,
            userId: true,
          },
        },
      },
    });

    if (recipient && recipient.batch) {
      const result = {
        recipientId: recipient.id,
        batchId: recipient.batch.id,
        userId: recipient.batch.userId,
        matchType: "messageId" as const,
      };

      // Cache the result
      await cacheService.cacheMessageLookup(messageId, result);

      return result;
    }

    // Try ClickHouse as last resort
    try {
      const lookup = await lookupByProviderMessageId(messageId);
      if (lookup) {
        const result = {
          recipientId: lookup.recipient_id,
          batchId: lookup.batch_id,
          userId: lookup.user_id,
          matchType: "messageId" as const,
        };

        // Cache the result
        await cacheService.cacheMessageLookup(messageId, result);

        return result;
      }
    } catch (error) {
      log.webhook.debug({ error, messageId }, "ClickHouse lookup failed");
    }

    return null;
  }
}

/**
 * Match by identifier (email, phone, etc.)
 * Uses a time window to avoid matching old sends
 */
class IdentifierMatcher implements MatchingStrategy {
  name = "identifier";
  private timeWindowHours: number;

  constructor(timeWindowHours: number = 24) {
    this.timeWindowHours = timeWindowHours;
  }

  async match(event: any): Promise<WebhookMatchResult | null> {
    // Extract identifier from event metadata
    const identifier =
      event.metadata?.email ||
      event.metadata?.phone ||
      event.metadata?.identifier ||
      event.metadata?.to?.[0];

    if (!identifier) return null;

    // Look for recent recipient with this identifier
    const cutoffTime = new Date(Date.now() - this.timeWindowHours * 60 * 60 * 1000);

    const recipient = await db.query.recipients.findFirst({
      where: and(
        or(
          eq(recipients.identifier, identifier),
          eq(recipients.email, identifier)
        ),
        sql`${recipients.createdAt} >= ${cutoffTime}`
      ),
      orderBy: sql`${recipients.createdAt} DESC`,
      with: {
        batch: {
          columns: {
            id: true,
            userId: true,
          },
        },
      },
    });

    if (recipient && recipient.batch) {
      return {
        recipientId: recipient.id,
        batchId: recipient.batch.id,
        userId: recipient.batch.userId,
        matchType: "identifier",
      };
    }

    return null;
  }
}

/**
 * Match using custom module-specific logic
 * Allows modules to define their own matching rules
 */
class CustomMatcher implements MatchingStrategy {
  name = "custom";

  async match(event: any): Promise<WebhookMatchResult | null> {
    // For custom modules, we can use metadata to find matches
    const moduleId = event.metadata?.moduleId;
    const customId = event.metadata?.customId || event.metadata?.externalId;

    if (!moduleId || !customId) return null;

    // Look for recipient with matching custom metadata
    const recipient = await db.query.recipients.findFirst({
      where: sql`
        ${recipients.variables}->>'customId' = ${customId} OR
        ${recipients.variables}->>'externalId' = ${customId}
      `,
      with: {
        batch: {
          columns: {
            id: true,
            userId: true,
          },
        },
      },
    });

    if (recipient && recipient.batch) {
      return {
        recipientId: recipient.id,
        batchId: recipient.batch.id,
        userId: recipient.batch.userId,
        matchType: "custom",
      };
    }

    return null;
  }
}

/**
 * Main webhook matcher service
 */
export class WebhookMatcher {
  private strategies: MatchingStrategy[];

  constructor() {
    this.strategies = [
      new MessageIdMatcher(),
      new IdentifierMatcher(24), // 24 hour window
      new CustomMatcher(),
    ];
  }

  /**
   * Try all strategies to match a webhook to a recipient
   */
  async matchWebhook(event: any): Promise<WebhookMatchResult | null> {
    const timer = log.startTimer();

    for (const strategy of this.strategies) {
      try {
        const result = await strategy.match(event);
        if (result) {
          log.webhook.debug({
            strategy: strategy.name,
            recipientId: result.recipientId,
            duration: timer(),
          }, "Webhook matched");
          return result;
        }
      } catch (error) {
        log.webhook.error({
          error,
          strategy: strategy.name,
          event,
        }, "Matching strategy failed");
      }
    }

    log.webhook.debug({
      provider: event.provider,
      eventType: event.eventType,
      duration: timer(),
    }, "No match found for webhook");

    return null;
  }

  /**
   * Batch match multiple webhooks
   */
  async batchMatch(events: any[]): Promise<Map<string, WebhookMatchResult | null>> {
    const results = new Map<string, WebhookMatchResult | null>();

    // Group events by provider message ID for efficient cache lookup
    const messageIdEvents = events.filter(e => e.providerMessageId);
    const otherEvents = events.filter(e => !e.providerMessageId);

    // Batch lookup message IDs from cache
    if (messageIdEvents.length > 0) {
      const cacheService = getCacheService();
      const messageIds = messageIdEvents.map(e => e.providerMessageId);
      const cachedLookups = await cacheService.batchGetCachedMessageLookups(messageIds);

      for (const event of messageIdEvents) {
        const cached = cachedLookups.get(event.providerMessageId);
        if (cached) {
          results.set(event.id, {
            ...cached,
            matchType: "messageId",
          });
        }
      }
    }

    // Match remaining events individually
    const unmatchedEvents = events.filter(e => !results.has(e.id));
    const matchPromises = unmatchedEvents.map(async (event) => {
      const result = await this.matchWebhook(event);
      results.set(event.id, result);
    });

    await Promise.all(matchPromises);

    return results;
  }
}

// Singleton instance
let matcher: WebhookMatcher | null = null;

export function getWebhookMatcher(): WebhookMatcher {
  if (!matcher) {
    matcher = new WebhookMatcher();
  }
  return matcher;
}