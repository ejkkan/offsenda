import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SystemTimeProvider,
  MockTimeProvider,
  getTimeProvider,
  setTimeProvider,
  resetTimeProvider,
} from "../../domain/utils/time.js";

describe("SystemTimeProvider", () => {
  it("should return current timestamp", () => {
    const provider = new SystemTimeProvider();
    const before = Date.now();
    const result = provider.now();
    const after = Date.now();

    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it("should return increasing timestamps", async () => {
    const provider = new SystemTimeProvider();
    const first = provider.now();

    await new Promise((r) => setTimeout(r, 10));
    const second = provider.now();

    expect(second).toBeGreaterThan(first);
  });
});

describe("MockTimeProvider", () => {
  it("should return initial time", () => {
    const provider = new MockTimeProvider(1000);

    expect(provider.now()).toBe(1000);
  });

  it("should default to 0", () => {
    const provider = new MockTimeProvider();

    expect(provider.now()).toBe(0);
  });

  it("should advance time by specified amount", () => {
    const provider = new MockTimeProvider(1000);

    provider.advanceBy(500);
    expect(provider.now()).toBe(1500);

    provider.advanceBy(200);
    expect(provider.now()).toBe(1700);
  });

  it("should set time to specific value", () => {
    const provider = new MockTimeProvider(1000);

    provider.setTime(5000);
    expect(provider.now()).toBe(5000);

    provider.setTime(100);
    expect(provider.now()).toBe(100);
  });

  it("should maintain time between calls", () => {
    const provider = new MockTimeProvider(1000);

    expect(provider.now()).toBe(1000);
    expect(provider.now()).toBe(1000);
    expect(provider.now()).toBe(1000);
  });
});

describe("Time provider singleton", () => {
  afterEach(() => {
    resetTimeProvider();
  });

  it("should default to SystemTimeProvider", () => {
    const provider = getTimeProvider();
    const before = Date.now();
    const result = provider.now();
    const after = Date.now();

    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it("should allow setting custom provider", () => {
    const mockProvider = new MockTimeProvider(5000);
    setTimeProvider(mockProvider);

    expect(getTimeProvider().now()).toBe(5000);
  });

  it("should reset to system provider", () => {
    const mockProvider = new MockTimeProvider(5000);
    setTimeProvider(mockProvider);

    resetTimeProvider();

    const provider = getTimeProvider();
    const before = Date.now();
    const result = provider.now();
    const after = Date.now();

    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  it("should share provider across calls", () => {
    const mockProvider = new MockTimeProvider(1000);
    setTimeProvider(mockProvider);

    mockProvider.advanceBy(500);

    expect(getTimeProvider().now()).toBe(1500);
  });
});
