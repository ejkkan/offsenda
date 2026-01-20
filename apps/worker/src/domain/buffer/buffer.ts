/**
 * Generic buffer implementation for batching items.
 * Used for buffered logging, event aggregation, etc.
 */

export interface Buffer<T> {
  /** Add single item to buffer */
  push(item: T): void;
  /** Add multiple items to buffer */
  pushMultiple(items: T[]): void;
  /** Check if buffer is at capacity */
  isFull(): boolean;
  /** Check if buffer has any items */
  isEmpty(): boolean;
  /** Get current item count */
  size(): number;
  /** Swap buffer contents with empty array (atomic for flushing) */
  swap(): T[];
  /** Clear buffer without returning items */
  clear(): void;
}

/**
 * Resizable buffer implementation.
 * Thread-safe for single-threaded async operations.
 */
export class ResizableBuffer<T> implements Buffer<T> {
  private items: T[] = [];

  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) {
      throw new Error("Buffer maxSize must be positive");
    }
  }

  push(item: T): void {
    this.items.push(item);
  }

  pushMultiple(items: T[]): void {
    this.items.push(...items);
  }

  isFull(): boolean {
    return this.items.length >= this.maxSize;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  size(): number {
    return this.items.length;
  }

  swap(): T[] {
    const current = this.items;
    this.items = [];
    return current;
  }

  clear(): void {
    this.items = [];
  }

  /** Get max size configuration */
  getMaxSize(): number {
    return this.maxSize;
  }
}

/**
 * Dual buffer for atomic swap operations.
 * Maintains two buffers - one for writing, one for reading during flush.
 */
export class DualBuffer<T> implements Buffer<T> {
  private writeBuffer: T[] = [];
  private readBuffer: T[] = [];
  private isSwapped = false;

  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) {
      throw new Error("Buffer maxSize must be positive");
    }
  }

  push(item: T): void {
    this.writeBuffer.push(item);
  }

  pushMultiple(items: T[]): void {
    this.writeBuffer.push(...items);
  }

  isFull(): boolean {
    return this.writeBuffer.length >= this.maxSize;
  }

  isEmpty(): boolean {
    return this.writeBuffer.length === 0;
  }

  size(): number {
    return this.writeBuffer.length;
  }

  swap(): T[] {
    // Swap buffers
    const temp = this.readBuffer;
    this.readBuffer = this.writeBuffer;
    this.writeBuffer = temp;
    this.writeBuffer.length = 0; // Clear the new write buffer

    return this.readBuffer;
  }

  clear(): void {
    this.writeBuffer = [];
    this.readBuffer = [];
  }

  /** Get items pending in read buffer (for retry scenarios) */
  getReadBuffer(): T[] {
    return this.readBuffer;
  }
}

/**
 * Options for AutoFlushBuffer
 */
export interface AutoFlushBufferOptions<T> {
  /** Callback when flush fails - receives the error and items that were dropped */
  onError?: (error: Error, droppedItems: T[]) => void;
}

/**
 * Buffer with automatic flush callback when full.
 */
export class AutoFlushBuffer<T> implements Buffer<T> {
  private buffer: ResizableBuffer<T>;
  private flushCallback: (items: T[]) => Promise<void>;
  private flushInProgress = false;
  private onError?: (error: Error, droppedItems: T[]) => void;

  constructor(
    maxSize: number,
    onFlush: (items: T[]) => Promise<void>,
    options?: AutoFlushBufferOptions<T>
  ) {
    this.buffer = new ResizableBuffer(maxSize);
    this.flushCallback = onFlush;
    this.onError = options?.onError;
  }

  push(item: T): void {
    this.buffer.push(item);
    this.checkFlush();
  }

  pushMultiple(items: T[]): void {
    this.buffer.pushMultiple(items);
    this.checkFlush();
  }

  private checkFlush(): void {
    if (this.buffer.isFull() && !this.flushInProgress) {
      this.flushInProgress = true;
      const items = this.buffer.swap();
      this.flushCallback(items)
        .catch((error) => {
          // Report dropped items to caller for logging/metrics
          if (this.onError) {
            this.onError(error instanceof Error ? error : new Error(String(error)), items);
          }
        })
        .finally(() => {
          this.flushInProgress = false;
        });
    }
  }

  isFull(): boolean {
    return this.buffer.isFull();
  }

  isEmpty(): boolean {
    return this.buffer.isEmpty();
  }

  size(): number {
    return this.buffer.size();
  }

  swap(): T[] {
    return this.buffer.swap();
  }

  clear(): void {
    this.buffer.clear();
  }

  /** Check if flush is currently in progress */
  isFlushInProgress(): boolean {
    return this.flushInProgress;
  }
}
