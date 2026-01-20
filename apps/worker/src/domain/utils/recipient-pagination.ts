/**
 * Recipient Pagination Utility
 *
 * Provides cursor-based pagination for loading recipients in pages.
 * Prevents OOM by streaming recipients instead of loading all into memory.
 *
 * For a batch with 1M recipients:
 * - Without pagination: Loads all 1M into memory (OOM risk)
 * - With pagination: Loads 1000 at a time, processes, continues
 */

import { eq, and, gt, asc, sql, inArray } from "drizzle-orm";
import { recipients } from "@batchsender/db";
import { db } from "../../db.js";
import { log } from "../../logger.js";

const DEFAULT_PAGE_SIZE = 1000;

/**
 * Recipient row type from database query
 */
export interface RecipientRow {
  id: string;
  batchId: string;
  identifier: string | null;
  email: string | null;
  name: string | null;
  variables: unknown;
  status: string;
}

/**
 * Options for pagination
 */
export interface PaginationOptions {
  /** Number of recipients per page (default: 1000) */
  pageSize?: number;
  /** Only fetch recipients with this status (default: 'pending') */
  status?: string;
}

/**
 * Result of a single page fetch
 */
export interface RecipientPage {
  /** Recipients in this page */
  recipients: RecipientRow[];
  /** Last ID for cursor (use as cursor for next page) */
  lastId: string | null;
  /** Whether there are more pages */
  hasMore: boolean;
  /** Page number (1-indexed) */
  pageNumber: number;
}

/**
 * Fetch a single page of recipients for a batch
 *
 * Uses cursor-based pagination (id > lastSeenId ORDER BY id ASC)
 * which is much more efficient than OFFSET for large datasets.
 */
export async function fetchRecipientPage(
  batchId: string,
  cursor: string | null,
  options: PaginationOptions = {}
): Promise<RecipientPage> {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const status = options.status || "pending";

  // Build where clause
  const whereConditions = cursor
    ? and(
        eq(recipients.batchId, batchId),
        eq(recipients.status, status),
        gt(recipients.id, cursor)
      )
    : and(
        eq(recipients.batchId, batchId),
        eq(recipients.status, status)
      );

  // Fetch page + 1 to check if there are more
  const rows = await db.query.recipients.findMany({
    where: whereConditions,
    orderBy: [asc(recipients.id)],
    limit: pageSize + 1,
  });

  const hasMore = rows.length > pageSize;
  const pageRecipients = hasMore ? rows.slice(0, pageSize) : rows;
  const lastId = pageRecipients.length > 0
    ? pageRecipients[pageRecipients.length - 1].id
    : null;

  return {
    recipients: pageRecipients as RecipientRow[],
    lastId,
    hasMore,
    pageNumber: 0, // Will be set by iterator
  };
}

/**
 * Async generator for streaming recipients in pages
 *
 * Usage:
 * ```typescript
 * for await (const page of streamRecipientPages(batchId)) {
 *   // Process page.recipients
 *   await processPage(page.recipients);
 * }
 * ```
 */
export async function* streamRecipientPages(
  batchId: string,
  options: PaginationOptions = {}
): AsyncGenerator<RecipientPage, void, unknown> {
  let cursor: string | null = null;
  let pageNumber = 0;
  let totalRecipients = 0;

  log.batch.debug({ batchId, pageSize: options.pageSize || DEFAULT_PAGE_SIZE }, "starting paginated fetch");

  while (true) {
    pageNumber++;
    const page = await fetchRecipientPage(batchId, cursor, options);
    page.pageNumber = pageNumber;
    totalRecipients += page.recipients.length;

    if (page.recipients.length === 0) {
      break;
    }

    yield page;

    if (!page.hasMore) {
      break;
    }

    cursor = page.lastId;
  }

  log.batch.debug(
    { batchId, totalPages: pageNumber, totalRecipients },
    "paginated fetch complete"
  );
}

/**
 * Async generator for streaming individual recipients
 *
 * Usage:
 * ```typescript
 * for await (const recipient of streamRecipients(batchId)) {
 *   await processRecipient(recipient);
 * }
 * ```
 */
export async function* streamRecipients(
  batchId: string,
  options: PaginationOptions = {}
): AsyncGenerator<RecipientRow, void, unknown> {
  for await (const page of streamRecipientPages(batchId, options)) {
    for (const recipient of page.recipients) {
      yield recipient;
    }
  }
}

/**
 * Count total recipients for a batch with a specific status
 *
 * Uses COUNT(*) query - doesn't load all records into memory
 * Useful for progress tracking and capacity planning
 */
export async function countRecipients(
  batchId: string,
  status: string = "pending"
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recipients)
    .where(
      and(
        eq(recipients.batchId, batchId),
        eq(recipients.status, status)
      )
    );
  return result[0]?.count ?? 0;
}

/**
 * Batch update recipients status by IDs
 *
 * More efficient than updating one by one when processing a page
 */
export async function updateRecipientsStatus(
  recipientIds: string[],
  newStatus: string
): Promise<void> {
  if (recipientIds.length === 0) return;

  await db
    .update(recipients)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(inArray(recipients.id, recipientIds));
}
