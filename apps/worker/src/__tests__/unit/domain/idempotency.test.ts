import { describe, it, expect } from "vitest";
import {
  AlwaysAllowChecker,
  AlwaysBlockChecker,
  InMemoryIdempotencyChecker,
  CompositeIdempotencyChecker,
} from "../../../domain/idempotency/index.js";
import type { IdempotencyChecker, IdempotencyCheckResult } from "../../../domain/idempotency/index.js";

describe("AlwaysAllowChecker", () => {
  it("should always return not processed", async () => {
    const checker = new AlwaysAllowChecker();

    const result = await checker.check("batch-1", "recipient-1");

    expect(result.processed).toBe(false);
    expect(result.status).toBeNull();
    expect(result.source).toBe("unknown");
  });

  it("should return same result for any input", async () => {
    const checker = new AlwaysAllowChecker();

    const result1 = await checker.check("batch-1", "r1");
    const result2 = await checker.check("batch-2", "r2");
    const result3 = await checker.check("any", "thing");

    expect(result1.processed).toBe(false);
    expect(result2.processed).toBe(false);
    expect(result3.processed).toBe(false);
  });

  it("should always be available", () => {
    const checker = new AlwaysAllowChecker();

    expect(checker.isAvailable()).toBe(true);
  });
});

describe("AlwaysBlockChecker", () => {
  it("should always return processed with default status", async () => {
    const checker = new AlwaysBlockChecker();

    const result = await checker.check("batch-1", "recipient-1");

    expect(result.processed).toBe(true);
    expect(result.status).toBe("sent");
    expect(result.source).toBe("unknown");
  });

  it("should use custom status", async () => {
    const checker = new AlwaysBlockChecker("failed");

    const result = await checker.check("batch-1", "recipient-1");

    expect(result.processed).toBe(true);
    expect(result.status).toBe("failed");
  });

  it("should support all status types", async () => {
    const sentChecker = new AlwaysBlockChecker("sent");
    const failedChecker = new AlwaysBlockChecker("failed");
    const bouncedChecker = new AlwaysBlockChecker("bounced");
    const complainedChecker = new AlwaysBlockChecker("complained");

    expect((await sentChecker.check("b", "r")).status).toBe("sent");
    expect((await failedChecker.check("b", "r")).status).toBe("failed");
    expect((await bouncedChecker.check("b", "r")).status).toBe("bounced");
    expect((await complainedChecker.check("b", "r")).status).toBe("complained");
  });

  it("should always be available", () => {
    const checker = new AlwaysBlockChecker();

    expect(checker.isAvailable()).toBe(true);
  });
});

describe("InMemoryIdempotencyChecker", () => {
  it("should return not processed for new recipient", async () => {
    const checker = new InMemoryIdempotencyChecker();

    const result = await checker.check("batch-1", "recipient-1");

    expect(result.processed).toBe(false);
    expect(result.status).toBeNull();
    expect(result.source).toBe("cache");
  });

  it("should return processed after marking", async () => {
    const checker = new InMemoryIdempotencyChecker();

    checker.markProcessed("batch-1", "recipient-1", "sent");
    const result = await checker.check("batch-1", "recipient-1");

    expect(result.processed).toBe(true);
    expect(result.status).toBe("sent");
    expect(result.source).toBe("cache");
  });

  it("should track different batch/recipient combinations", async () => {
    const checker = new InMemoryIdempotencyChecker();

    checker.markProcessed("batch-1", "recipient-1", "sent");
    checker.markProcessed("batch-1", "recipient-2", "failed");
    checker.markProcessed("batch-2", "recipient-1", "bounced");

    expect((await checker.check("batch-1", "recipient-1")).status).toBe("sent");
    expect((await checker.check("batch-1", "recipient-2")).status).toBe("failed");
    expect((await checker.check("batch-2", "recipient-1")).status).toBe("bounced");
    expect((await checker.check("batch-2", "recipient-2")).processed).toBe(false);
  });

  it("should clear all records", async () => {
    const checker = new InMemoryIdempotencyChecker();

    checker.markProcessed("batch-1", "r1", "sent");
    checker.markProcessed("batch-1", "r2", "sent");

    checker.clear();

    expect((await checker.check("batch-1", "r1")).processed).toBe(false);
    expect((await checker.check("batch-1", "r2")).processed).toBe(false);
  });

  it("should always be available", () => {
    const checker = new InMemoryIdempotencyChecker();

    expect(checker.isAvailable()).toBe(true);
  });

  it("should update status on re-mark", async () => {
    const checker = new InMemoryIdempotencyChecker();

    checker.markProcessed("batch-1", "r1", "sent");
    expect((await checker.check("batch-1", "r1")).status).toBe("sent");

    checker.markProcessed("batch-1", "r1", "bounced");
    expect((await checker.check("batch-1", "r1")).status).toBe("bounced");
  });
});

describe("CompositeIdempotencyChecker", () => {
  it("should throw when created with empty checkers", () => {
    expect(() => new CompositeIdempotencyChecker([])).toThrow(
      "At least one checker is required"
    );
  });

  it("should use first available checker", async () => {
    const primary = new InMemoryIdempotencyChecker();
    const fallback = new AlwaysAllowChecker();

    primary.markProcessed("batch-1", "r1", "sent");

    const composite = new CompositeIdempotencyChecker([primary, fallback]);
    const result = await composite.check("batch-1", "r1");

    expect(result.processed).toBe(true);
    expect(result.status).toBe("sent");
  });

  it("should skip unavailable checkers", async () => {
    const unavailableChecker: IdempotencyChecker = {
      check: async () => ({ processed: true, status: "sent", source: "unknown" }),
      isAvailable: () => false,
    };
    const fallback = new AlwaysAllowChecker();

    const composite = new CompositeIdempotencyChecker([unavailableChecker, fallback]);
    const result = await composite.check("batch-1", "r1");

    expect(result.processed).toBe(false); // From AlwaysAllowChecker
  });

  it("should fall back on error", async () => {
    const failingChecker: IdempotencyChecker = {
      check: async () => {
        throw new Error("Connection failed");
      },
      isAvailable: () => true,
    };
    const fallback = new AlwaysAllowChecker();

    const composite = new CompositeIdempotencyChecker([failingChecker, fallback]);
    const result = await composite.check("batch-1", "r1");

    expect(result.processed).toBe(false); // From AlwaysAllowChecker
  });

  it("should throw when all checkers fail", async () => {
    const failingChecker1: IdempotencyChecker = {
      check: async () => {
        throw new Error("Error 1");
      },
      isAvailable: () => true,
    };
    const failingChecker2: IdempotencyChecker = {
      check: async () => {
        throw new Error("Error 2");
      },
      isAvailable: () => true,
    };

    const composite = new CompositeIdempotencyChecker([failingChecker1, failingChecker2]);

    await expect(composite.check("batch-1", "r1")).rejects.toThrow(
      "All idempotency checkers failed"
    );
  });

  it("should throw when no checkers are available", async () => {
    const unavailable: IdempotencyChecker = {
      check: async () => ({ processed: false, status: null, source: "unknown" }),
      isAvailable: () => false,
    };

    const composite = new CompositeIdempotencyChecker([unavailable]);

    await expect(composite.check("batch-1", "r1")).rejects.toThrow(
      "No available idempotency checkers"
    );
  });

  it("should report available if any checker is available", () => {
    const available: IdempotencyChecker = {
      check: async () => ({ processed: false, status: null, source: "unknown" }),
      isAvailable: () => true,
    };
    const unavailable: IdempotencyChecker = {
      check: async () => ({ processed: false, status: null, source: "unknown" }),
      isAvailable: () => false,
    };

    const composite1 = new CompositeIdempotencyChecker([available, unavailable]);
    const composite2 = new CompositeIdempotencyChecker([unavailable, available]);
    const composite3 = new CompositeIdempotencyChecker([unavailable]);

    expect(composite1.isAvailable()).toBe(true);
    expect(composite2.isAvailable()).toBe(true);
    expect(composite3.isAvailable()).toBe(false);
  });

  it("should try checkers in order", async () => {
    const callOrder: string[] = [];

    const checker1: IdempotencyChecker = {
      check: async () => {
        callOrder.push("checker1");
        return { processed: false, status: null, source: "unknown" };
      },
      isAvailable: () => true,
    };
    const checker2: IdempotencyChecker = {
      check: async () => {
        callOrder.push("checker2");
        return { processed: false, status: null, source: "unknown" };
      },
      isAvailable: () => true,
    };

    const composite = new CompositeIdempotencyChecker([checker1, checker2]);
    await composite.check("batch-1", "r1");

    // First checker succeeds, so second should not be called
    expect(callOrder).toEqual(["checker1"]);
  });

  it("should call next checker only on failure", async () => {
    const callOrder: string[] = [];

    const failingChecker: IdempotencyChecker = {
      check: async () => {
        callOrder.push("failing");
        throw new Error("Failed");
      },
      isAvailable: () => true,
    };
    const successChecker: IdempotencyChecker = {
      check: async () => {
        callOrder.push("success");
        return { processed: true, status: "sent", source: "cache" };
      },
      isAvailable: () => true,
    };

    const composite = new CompositeIdempotencyChecker([failingChecker, successChecker]);
    const result = await composite.check("batch-1", "r1");

    expect(callOrder).toEqual(["failing", "success"]);
    expect(result.processed).toBe(true);
  });
});
