import { describe, it, expect } from "vitest";
import {
  calculateBackoff,
  calculateNatsBackoff,
  calculateBatchBackoff,
  calculateEmailBackoff,
} from "../../../domain/utils/backoff.js";

describe("calculateBackoff", () => {
  describe("default options", () => {
    it("should return base delay for first attempt", () => {
      expect(calculateBackoff(0)).toBe(1000);
    });

    it("should double delay for each attempt", () => {
      expect(calculateBackoff(0)).toBe(1000);
      expect(calculateBackoff(1)).toBe(2000);
      expect(calculateBackoff(2)).toBe(4000);
      expect(calculateBackoff(3)).toBe(8000);
      expect(calculateBackoff(4)).toBe(16000);
    });

    it("should cap at max delay", () => {
      expect(calculateBackoff(5)).toBe(30000); // 32000 capped to 30000
      expect(calculateBackoff(10)).toBe(30000);
      expect(calculateBackoff(100)).toBe(30000);
    });
  });

  describe("custom options", () => {
    it("should respect custom base delay", () => {
      expect(calculateBackoff(0, { baseDelayMs: 500 })).toBe(500);
      expect(calculateBackoff(1, { baseDelayMs: 500 })).toBe(1000);
      expect(calculateBackoff(2, { baseDelayMs: 500 })).toBe(2000);
    });

    it("should respect custom max delay", () => {
      expect(calculateBackoff(5, { maxDelayMs: 10000 })).toBe(10000);
      expect(calculateBackoff(10, { maxDelayMs: 10000 })).toBe(10000);
    });

    it("should handle both custom base and max", () => {
      const opts = { baseDelayMs: 100, maxDelayMs: 500 };
      expect(calculateBackoff(0, opts)).toBe(100);
      expect(calculateBackoff(1, opts)).toBe(200);
      expect(calculateBackoff(2, opts)).toBe(400);
      expect(calculateBackoff(3, opts)).toBe(500); // capped
    });
  });

  describe("jitter", () => {
    it("should add jitter when configured", () => {
      const results = new Set<number>();
      for (let i = 0; i < 100; i++) {
        results.add(calculateBackoff(2, { jitterFactor: 0.5 }));
      }
      // With jitter, we should get varying results
      // Base is 4000, with 0.5 jitter it ranges from 4000 to 6000
      expect(results.size).toBeGreaterThan(1);
    });

    it("should not exceed jitter bounds", () => {
      for (let i = 0; i < 100; i++) {
        const result = calculateBackoff(2, { jitterFactor: 0.5 });
        expect(result).toBeGreaterThanOrEqual(4000);
        expect(result).toBeLessThanOrEqual(6000);
      }
    });
  });

  describe("edge cases", () => {
    it("should handle attempt 0", () => {
      expect(calculateBackoff(0)).toBe(1000);
    });

    it("should handle negative attempts as 0", () => {
      // Math.pow(2, -1) = 0.5, so 1000 * 0.5 = 500
      expect(calculateBackoff(-1)).toBe(500);
    });
  });
});

describe("calculateNatsBackoff", () => {
  it("should convert 1-indexed redeliveryCount to 0-indexed", () => {
    // redeliveryCount 1 = attempt 0
    expect(calculateNatsBackoff(1)).toBe(1000);
    // redeliveryCount 2 = attempt 1
    expect(calculateNatsBackoff(2)).toBe(2000);
    // redeliveryCount 3 = attempt 2
    expect(calculateNatsBackoff(3)).toBe(4000);
  });

  it("should handle redeliveryCount 0 as attempt 0", () => {
    expect(calculateNatsBackoff(0)).toBe(1000);
  });

  it("should respect custom options", () => {
    expect(calculateNatsBackoff(1, { baseDelayMs: 500 })).toBe(500);
    expect(calculateNatsBackoff(2, { baseDelayMs: 500 })).toBe(1000);
  });
});

describe("calculateBatchBackoff", () => {
  it("should use batch-specific defaults (5s base, 60s max)", () => {
    expect(calculateBatchBackoff(1)).toBe(5000);
    expect(calculateBatchBackoff(2)).toBe(10000);
    expect(calculateBatchBackoff(3)).toBe(20000);
    expect(calculateBatchBackoff(4)).toBe(40000);
    expect(calculateBatchBackoff(5)).toBe(60000); // capped
    expect(calculateBatchBackoff(10)).toBe(60000);
  });
});

describe("calculateEmailBackoff", () => {
  it("should use email-specific defaults (1s base, 30s max)", () => {
    expect(calculateEmailBackoff(1)).toBe(1000);
    expect(calculateEmailBackoff(2)).toBe(2000);
    expect(calculateEmailBackoff(3)).toBe(4000);
    expect(calculateEmailBackoff(4)).toBe(8000);
    expect(calculateEmailBackoff(5)).toBe(16000);
    expect(calculateEmailBackoff(6)).toBe(30000); // capped
  });
});
