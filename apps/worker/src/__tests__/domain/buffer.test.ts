import { describe, it, expect } from "vitest";
import {
  ResizableBuffer,
  DualBuffer,
  AutoFlushBuffer,
} from "../../domain/buffer/index.js";

describe("ResizableBuffer", () => {
  describe("constructor", () => {
    it("should create buffer with max size", () => {
      const buffer = new ResizableBuffer<number>(100);
      expect(buffer.getMaxSize()).toBe(100);
    });

    it("should throw for non-positive max size", () => {
      expect(() => new ResizableBuffer(0)).toThrow("Buffer maxSize must be positive");
      expect(() => new ResizableBuffer(-1)).toThrow("Buffer maxSize must be positive");
    });
  });

  describe("push", () => {
    it("should add single item", () => {
      const buffer = new ResizableBuffer<number>(10);
      buffer.push(1);
      expect(buffer.size()).toBe(1);
    });

    it("should add multiple items", () => {
      const buffer = new ResizableBuffer<number>(10);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      expect(buffer.size()).toBe(3);
    });
  });

  describe("pushMultiple", () => {
    it("should add array of items", () => {
      const buffer = new ResizableBuffer<number>(10);
      buffer.pushMultiple([1, 2, 3, 4, 5]);
      expect(buffer.size()).toBe(5);
    });

    it("should handle empty array", () => {
      const buffer = new ResizableBuffer<number>(10);
      buffer.pushMultiple([]);
      expect(buffer.size()).toBe(0);
    });
  });

  describe("isFull", () => {
    it("should return false when under capacity", () => {
      const buffer = new ResizableBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      expect(buffer.isFull()).toBe(false);
    });

    it("should return true when at capacity", () => {
      const buffer = new ResizableBuffer<number>(3);
      buffer.pushMultiple([1, 2, 3]);
      expect(buffer.isFull()).toBe(true);
    });

    it("should return true when over capacity", () => {
      const buffer = new ResizableBuffer<number>(3);
      buffer.pushMultiple([1, 2, 3, 4, 5]);
      expect(buffer.isFull()).toBe(true);
    });
  });

  describe("isEmpty", () => {
    it("should return true for empty buffer", () => {
      const buffer = new ResizableBuffer<number>(10);
      expect(buffer.isEmpty()).toBe(true);
    });

    it("should return false for non-empty buffer", () => {
      const buffer = new ResizableBuffer<number>(10);
      buffer.push(1);
      expect(buffer.isEmpty()).toBe(false);
    });
  });

  describe("swap", () => {
    it("should return all items", () => {
      const buffer = new ResizableBuffer<number>(10);
      buffer.pushMultiple([1, 2, 3]);
      const items = buffer.swap();
      expect(items).toEqual([1, 2, 3]);
    });

    it("should clear buffer after swap", () => {
      const buffer = new ResizableBuffer<number>(10);
      buffer.pushMultiple([1, 2, 3]);
      buffer.swap();
      expect(buffer.size()).toBe(0);
      expect(buffer.isEmpty()).toBe(true);
    });

    it("should return empty array for empty buffer", () => {
      const buffer = new ResizableBuffer<number>(10);
      const items = buffer.swap();
      expect(items).toEqual([]);
    });
  });

  describe("clear", () => {
    it("should remove all items", () => {
      const buffer = new ResizableBuffer<number>(10);
      buffer.pushMultiple([1, 2, 3]);
      buffer.clear();
      expect(buffer.size()).toBe(0);
      expect(buffer.isEmpty()).toBe(true);
    });
  });
});

describe("DualBuffer", () => {
  describe("constructor", () => {
    it("should create buffer with max size", () => {
      const buffer = new DualBuffer<number>(100);
      expect(buffer.isEmpty()).toBe(true);
    });

    it("should throw for non-positive max size", () => {
      expect(() => new DualBuffer(0)).toThrow("Buffer maxSize must be positive");
    });
  });

  describe("push and size", () => {
    it("should track items in write buffer", () => {
      const buffer = new DualBuffer<number>(10);
      buffer.push(1);
      buffer.push(2);
      expect(buffer.size()).toBe(2);
    });
  });

  describe("swap", () => {
    it("should swap write and read buffers", () => {
      const buffer = new DualBuffer<number>(10);
      buffer.pushMultiple([1, 2, 3]);

      const items = buffer.swap();

      expect(items).toEqual([1, 2, 3]);
      expect(buffer.size()).toBe(0); // Write buffer is now empty
    });

    it("should allow writing during read processing", () => {
      const buffer = new DualBuffer<number>(10);
      buffer.pushMultiple([1, 2, 3]);

      const readItems = buffer.swap();

      // Add new items while processing read buffer
      buffer.push(4);
      buffer.push(5);

      expect(readItems).toEqual([1, 2, 3]);
      expect(buffer.size()).toBe(2);
    });

    it("should provide access to read buffer for retry", () => {
      const buffer = new DualBuffer<number>(10);
      buffer.pushMultiple([1, 2, 3]);
      buffer.swap();

      const readBuffer = buffer.getReadBuffer();
      expect(readBuffer).toEqual([1, 2, 3]);
    });
  });

  describe("clear", () => {
    it("should clear both buffers", () => {
      const buffer = new DualBuffer<number>(10);
      buffer.pushMultiple([1, 2, 3]);
      buffer.swap();
      buffer.push(4);

      buffer.clear();

      expect(buffer.size()).toBe(0);
      expect(buffer.getReadBuffer()).toEqual([]);
    });
  });
});

describe("AutoFlushBuffer", () => {
  it("should not flush when under capacity", async () => {
    let flushCount = 0;
    const buffer = new AutoFlushBuffer<number>(5, async () => {
      flushCount++;
    });

    buffer.push(1);
    buffer.push(2);

    await new Promise((r) => setTimeout(r, 10));
    expect(flushCount).toBe(0);
  });

  it("should flush when reaching capacity", async () => {
    let flushedItems: number[] = [];
    const buffer = new AutoFlushBuffer<number>(3, async (items) => {
      flushedItems = items;
    });

    buffer.push(1);
    buffer.push(2);
    buffer.push(3); // Triggers flush

    await new Promise((r) => setTimeout(r, 10));
    expect(flushedItems).toEqual([1, 2, 3]);
  });

  it("should track flush in progress", async () => {
    let resolveFlush: () => void;
    const flushPromise = new Promise<void>((r) => {
      resolveFlush = r;
    });

    const buffer = new AutoFlushBuffer<number>(2, async () => {
      await flushPromise;
    });

    buffer.push(1);
    buffer.push(2); // Triggers flush

    await new Promise((r) => setTimeout(r, 10));
    expect(buffer.isFlushInProgress()).toBe(true);

    resolveFlush!();
    await new Promise((r) => setTimeout(r, 10));
    expect(buffer.isFlushInProgress()).toBe(false);
  });

  it("should allow manual swap", () => {
    const buffer = new AutoFlushBuffer<number>(10, async () => {});

    buffer.pushMultiple([1, 2, 3]);
    const items = buffer.swap();

    expect(items).toEqual([1, 2, 3]);
    expect(buffer.size()).toBe(0);
  });

  it("should handle flush errors gracefully", async () => {
    const buffer = new AutoFlushBuffer<number>(2, async () => {
      throw new Error("Flush failed");
    });

    // Should not throw
    buffer.push(1);
    buffer.push(2); // Triggers flush that fails

    await new Promise((r) => setTimeout(r, 10));
    expect(buffer.isFlushInProgress()).toBe(false);
  });
});
