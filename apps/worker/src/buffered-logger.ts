/**
 * Buffered Event Logger for ClickHouse
 *
 * High-throughput event logging with buffering to reduce ClickHouse insert frequency.
 * Flushes events every 5 seconds or when buffer reaches 10,000 events.
 *
 * This reduces per-message ClickHouse inserts from 1 to ~0.0001, significantly
 * improving throughput for high-volume batch processing.
 */

import { clickhouse, type EmailEvent, type EventType, type ModuleType } from "./clickhouse.js";
import { log } from "./logger.js";
import { calculateBackoff } from "./domain/utils/backoff.js";
import { bufferItemsDroppedTotal, clickhouseWriteFailuresTotal } from "./metrics.js";

export interface BufferedLoggerConfig {
  /** Maximum events to buffer before forced flush (default: 10000) */
  maxBufferSize?: number;
  /** Flush interval in milliseconds (default: 5000) */
  flushIntervalMs?: number;
  /** Maximum retries for failed flushes (default: 3) */
  maxRetries?: number;
}

const DEFAULT_CONFIG: Required<BufferedLoggerConfig> = {
  maxBufferSize: 10000,
  flushIntervalMs: 5000,
  maxRetries: 3,
};

/**
 * Buffered event logger that batches ClickHouse inserts for high throughput
 */
export class BufferedEventLogger {
  private buffer: EmailEvent[] = [];
  private messageIndexBuffer: Array<{
    provider_message_id: string;
    recipient_id: string;
    batch_id: string;
    user_id: string;
  }> = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private config: Required<BufferedLoggerConfig>;
  private isShuttingDown = false;
  private flushPromise: Promise<void> | null = null;
  private stats = {
    eventsLogged: 0,
    flushCount: 0,
    failedFlushes: 0,
    lastFlushTime: 0,
    lastFlushDuration: 0,
  };

  constructor(config?: BufferedLoggerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the buffered logger (begins flush interval)
   */
  start(): void {
    if (this.flushInterval) {
      return; // Already started
    }

    this.flushInterval = setInterval(() => {
      this.flush().catch((error) => {
        log.system.error({ error }, "BufferedEventLogger flush failed");
      });
    }, this.config.flushIntervalMs);

    log.system.info(
      {
        maxBufferSize: this.config.maxBufferSize,
        flushIntervalMs: this.config.flushIntervalMs,
      },
      "BufferedEventLogger started"
    );
  }

  /**
   * Stop the buffered logger (flushes remaining events)
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Wait for any in-flight flush to complete
    if (this.flushPromise) {
      await this.flushPromise;
    }

    // Final flush
    await this.flush();

    log.system.info(
      {
        totalEventsLogged: this.stats.eventsLogged,
        totalFlushes: this.stats.flushCount,
        failedFlushes: this.stats.failedFlushes,
      },
      "BufferedEventLogger stopped"
    );
  }

  /**
   * Log an email event (buffered)
   */
  logEvent(event: EmailEvent): void {
    this.buffer.push(event);
    this.stats.eventsLogged++;

    // Trigger flush if buffer is full
    if (this.buffer.length >= this.config.maxBufferSize) {
      this.flush().catch((error) => {
        log.system.error({ error }, "BufferedEventLogger flush failed on buffer full");
      });
    }
  }

  /**
   * Log multiple events at once (buffered)
   */
  logEvents(events: EmailEvent[]): void {
    this.buffer.push(...events);
    this.stats.eventsLogged += events.length;

    // Trigger flush if buffer is full
    if (this.buffer.length >= this.config.maxBufferSize) {
      this.flush().catch((error) => {
        log.system.error({ error }, "BufferedEventLogger flush failed on buffer full");
      });
    }
  }

  /**
   * Index a provider message ID for webhook lookups (buffered)
   */
  indexProviderMessage(params: {
    provider_message_id: string;
    recipient_id: string;
    batch_id: string;
    user_id: string;
  }): void {
    this.messageIndexBuffer.push(params);

    // Use same trigger threshold
    if (this.messageIndexBuffer.length >= this.config.maxBufferSize) {
      this.flush().catch((error) => {
        log.system.error({ error }, "BufferedEventLogger flush failed on index buffer full");
      });
    }
  }

  /**
   * Flush all buffered events to ClickHouse
   */
  async flush(): Promise<void> {
    // Prevent concurrent flushes
    if (this.flushPromise) {
      return this.flushPromise;
    }

    this.flushPromise = this.doFlush();

    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  private async doFlush(): Promise<void> {
    const startTime = Date.now();

    // Swap buffers atomically
    const events = this.buffer;
    const messageIndexes = this.messageIndexBuffer;
    this.buffer = [];
    this.messageIndexBuffer = [];

    if (events.length === 0 && messageIndexes.length === 0) {
      return;
    }

    // Flush events
    if (events.length > 0) {
      await this.flushEventsWithRetry(events);
    }

    // Flush message indexes
    if (messageIndexes.length > 0) {
      await this.flushMessageIndexesWithRetry(messageIndexes);
    }

    this.stats.flushCount++;
    this.stats.lastFlushTime = Date.now();
    this.stats.lastFlushDuration = Date.now() - startTime;

    log.system.debug(
      {
        events: events.length,
        messageIndexes: messageIndexes.length,
        duration: this.stats.lastFlushDuration,
      },
      "BufferedEventLogger flushed"
    );
  }

  private async flushEventsWithRetry(events: EmailEvent[]): Promise<void> {
    const values = events.map((event) => ({
      event_type: event.event_type,
      module_type: event.module_type || "email",
      batch_id: event.batch_id,
      recipient_id: event.recipient_id,
      user_id: event.user_id,
      email: event.email,
      provider_message_id: event.provider_message_id || "",
      metadata: JSON.stringify(event.metadata || {}),
      error_message: event.error_message || "",
    }));

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        await clickhouse.insert({
          table: "email_events",
          values,
          format: "JSONEachRow",
        });
        return;
      } catch (error) {
        const isLastAttempt = attempt === this.config.maxRetries - 1;

        if (isLastAttempt) {
          this.stats.failedFlushes++;
          log.system.error(
            { error, eventCount: events.length, attempts: attempt + 1 },
            "BufferedEventLogger failed to flush events after all retries"
          );

          // Track dropped items in metrics
          bufferItemsDroppedTotal.inc({ buffer_type: "clickhouse_events" }, events.length);
          clickhouseWriteFailuresTotal.inc({ operation: "insert" });
        } else {
          log.system.warn(
            { error, attempt: attempt + 1, eventCount: events.length },
            "BufferedEventLogger flush retry"
          );
          // Exponential backoff using domain layer
          const delay = calculateBackoff(attempt, { baseDelayMs: 100, maxDelayMs: 1600 });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  private async flushMessageIndexesWithRetry(
    indexes: Array<{
      provider_message_id: string;
      recipient_id: string;
      batch_id: string;
      user_id: string;
    }>
  ): Promise<void> {
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        await clickhouse.insert({
          table: "email_message_index",
          values: indexes,
          format: "JSONEachRow",
        });
        return;
      } catch (error) {
        const isLastAttempt = attempt === this.config.maxRetries - 1;

        if (isLastAttempt) {
          this.stats.failedFlushes++;
          log.system.error(
            { error, indexCount: indexes.length, attempts: attempt + 1 },
            "BufferedEventLogger failed to flush message indexes after all retries"
          );

          // Track dropped items in metrics
          bufferItemsDroppedTotal.inc({ buffer_type: "clickhouse_indexes" }, indexes.length);
          clickhouseWriteFailuresTotal.inc({ operation: "insert" });
        } else {
          log.system.warn(
            { error, attempt: attempt + 1, indexCount: indexes.length },
            "BufferedEventLogger index flush retry"
          );
          // Exponential backoff using domain layer
          const delay = calculateBackoff(attempt, { baseDelayMs: 100, maxDelayMs: 1600 });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  /**
   * Get current buffer and flush statistics
   */
  getStats(): {
    bufferSize: number;
    messageIndexBufferSize: number;
    eventsLogged: number;
    flushCount: number;
    failedFlushes: number;
    lastFlushTime: number;
    lastFlushDuration: number;
  } {
    return {
      bufferSize: this.buffer.length,
      messageIndexBufferSize: this.messageIndexBuffer.length,
      ...this.stats,
    };
  }
}

// Singleton instance
let bufferedLogger: BufferedEventLogger | null = null;

/**
 * Get or create the singleton BufferedEventLogger instance
 */
export function getBufferedLogger(config?: BufferedLoggerConfig): BufferedEventLogger {
  if (!bufferedLogger) {
    bufferedLogger = new BufferedEventLogger(config);
  }
  return bufferedLogger;
}

/**
 * Convenience function to log a single event using the singleton logger
 */
export function logEventBuffered(event: EmailEvent): void {
  getBufferedLogger().logEvent(event);
}

/**
 * Convenience function to log multiple events using the singleton logger
 */
export function logEventsBuffered(events: EmailEvent[]): void {
  getBufferedLogger().logEvents(events);
}

/**
 * Convenience function to index a provider message using the singleton logger
 */
export function indexProviderMessageBuffered(params: {
  provider_message_id: string;
  recipient_id: string;
  batch_id: string;
  user_id: string;
}): void {
  getBufferedLogger().indexProviderMessage(params);
}
