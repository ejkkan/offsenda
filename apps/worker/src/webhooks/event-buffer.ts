import { WebhookEvent } from "./queue-processor.js";
import { log } from "../logger.js";

export interface EventBufferConfig {
  maxSize: number;
  flushIntervalMs: number;
  onFlush: (events: WebhookEvent[]) => Promise<void>;
}

/**
 * Thread-safe event buffer with automatic flushing
 * Collects webhook events and flushes them in batches
 */
export class EventBuffer {
  private buffer: WebhookEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isClosed = false;
  private flushPromise: Promise<void> | null = null;

  constructor(private config: EventBufferConfig) {}

  /**
   * Add an event to the buffer
   * Returns true if event was buffered, false if buffer is closed
   */
  async add(event: WebhookEvent): Promise<boolean> {
    if (this.isClosed) {
      return false;
    }

    this.buffer.push(event);

    // Flush if buffer is full
    if (this.buffer.length >= this.config.maxSize) {
      await this.flush();
    } else {
      // Schedule flush if not already scheduled
      this.scheduleFlush();
    }

    return true;
  }

  /**
   * Add multiple events to the buffer
   */
  async addBatch(events: WebhookEvent[]): Promise<boolean> {
    if (this.isClosed) {
      return false;
    }

    this.buffer.push(...events);

    // Check if we need to flush
    if (this.buffer.length >= this.config.maxSize) {
      await this.flush();
    } else {
      this.scheduleFlush();
    }

    return true;
  }

  /**
   * Get current buffer size
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Flush the buffer immediately
   */
  async flush(): Promise<void> {
    // Cancel any scheduled flush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // If already processing, wait for it to complete
    if (this.flushPromise) {
      return this.flushPromise;
    }

    // Nothing to flush
    if (this.buffer.length === 0) {
      return;
    }

    // Start processing
    this.flushPromise = this.processFlush();

    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  /**
   * Process the flush operation
   */
  private async processFlush(): Promise<void> {
    // Swap buffers to allow concurrent collection
    const eventsToProcess = this.buffer;
    this.buffer = [];

    if (eventsToProcess.length === 0) {
      return;
    }

    try {
      await this.config.onFlush(eventsToProcess);
    } catch (error) {
      // Re-add events to buffer on error (at the front)
      this.buffer.unshift(...eventsToProcess);
      throw error;
    }
  }

  /**
   * Schedule a flush operation
   */
  private scheduleFlush(): void {
    if (this.flushTimer || this.isClosed) {
      return;
    }

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      if (!this.isClosed && this.buffer.length > 0) {
        await this.flush();
      }
    }, this.config.flushIntervalMs);
  }

  /**
   * Close the buffer and flush remaining events
   */
  async close(): Promise<void> {
    this.isClosed = true;

    // Cancel timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush remaining events
    if (this.buffer.length > 0) {
      await this.flush();
    }
  }

  /**
   * Get statistics about the buffer
   */
  getStats() {
    return {
      currentSize: this.buffer.length,
      isProcessing: this.isProcessing,
      isClosed: this.isClosed,
    };
  }
}