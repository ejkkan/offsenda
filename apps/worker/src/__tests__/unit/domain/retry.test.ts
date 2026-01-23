import { describe, it, expect, vi } from "vitest";
import {
  executeWithRetry,
  ExponentialBackoffRetry,
  NoRetryStrategy,
  InstantDelayProvider,
} from "../../../domain/utils/retry.js";

describe("executeWithRetry", () => {
  const instantDelay = new InstantDelayProvider();

  it("should return success on first try", async () => {
    const operation = vi.fn().mockResolvedValue("success");

    const result = await executeWithRetry(operation, { maxRetries: 3 }, instantDelay);

    expect(result.success).toBe(true);
    expect(result.value).toBe("success");
    expect(result.attempts).toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and succeed", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("success");

    const result = await executeWithRetry(operation, { maxRetries: 3 }, instantDelay);

    expect(result.success).toBe(true);
    expect(result.value).toBe("success");
    expect(result.attempts).toBe(3);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should fail after all retries exhausted", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("always fails"));

    const result = await executeWithRetry(operation, { maxRetries: 2 }, instantDelay);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe("always fails");
    expect(result.attempts).toBe(3); // initial + 2 retries
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should respect maxRetries = 0 (no retries)", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("fail"));

    const result = await executeWithRetry(operation, { maxRetries: 0 }, instantDelay);

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should call onRetry callback", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("success");

    const onRetry = vi.fn();

    await executeWithRetry(
      operation,
      { maxRetries: 3, onRetry },
      instantDelay
    );

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
    expect(onRetry).toHaveBeenCalledWith(2, expect.any(Error), expect.any(Number));
  });

  it("should use exponential backoff delays", async () => {
    const delayProvider = new InstantDelayProvider();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("success");

    await executeWithRetry(
      operation,
      { maxRetries: 3, baseDelayMs: 100, exponential: true },
      delayProvider
    );

    // First retry: 100ms, second retry: 200ms
    expect(delayProvider.delays).toEqual([100, 200]);
  });

  it("should use fixed delays when exponential is false", async () => {
    const delayProvider = new InstantDelayProvider();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("success");

    await executeWithRetry(
      operation,
      { maxRetries: 3, baseDelayMs: 100, exponential: false },
      delayProvider
    );

    expect(delayProvider.delays).toEqual([100, 100]);
  });
});

describe("ExponentialBackoffRetry", () => {
  it("should execute operation successfully", async () => {
    const strategy = new ExponentialBackoffRetry(
      { maxRetries: 3 },
      new InstantDelayProvider()
    );

    const result = await strategy.execute(() => Promise.resolve("value"));

    expect(result).toBe("value");
  });

  it("should retry and succeed", async () => {
    const strategy = new ExponentialBackoffRetry(
      { maxRetries: 3 },
      new InstantDelayProvider()
    );

    let attempts = 0;
    const result = await strategy.execute(() => {
      attempts++;
      if (attempts < 3) {
        return Promise.reject(new Error("fail"));
      }
      return Promise.resolve("success");
    });

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("should throw after all retries exhausted", async () => {
    const strategy = new ExponentialBackoffRetry(
      { maxRetries: 2 },
      new InstantDelayProvider()
    );

    await expect(
      strategy.execute(() => Promise.reject(new Error("always fails")))
    ).rejects.toThrow("always fails");
  });
});

describe("NoRetryStrategy", () => {
  it("should execute without retries", async () => {
    const strategy = new NoRetryStrategy();

    const result = await strategy.execute(() => Promise.resolve("value"));

    expect(result).toBe("value");
  });

  it("should throw immediately on failure", async () => {
    const strategy = new NoRetryStrategy();

    await expect(
      strategy.execute(() => Promise.reject(new Error("fail")))
    ).rejects.toThrow("fail");
  });
});

describe("InstantDelayProvider", () => {
  it("should track delay calls", async () => {
    const provider = new InstantDelayProvider();

    await provider.delay(100);
    await provider.delay(200);
    await provider.delay(300);

    expect(provider.delays).toEqual([100, 200, 300]);
  });

  it("should not actually delay", async () => {
    const provider = new InstantDelayProvider();
    const start = Date.now();

    await provider.delay(10000); // 10 seconds

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // Should be nearly instant
  });
});
