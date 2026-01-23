import { describe, it, expect, beforeEach, vi } from "vitest";
import { HotStateManager } from "../../hot-state-manager.js";

// Mock Redis for unit testing
function createMockRedis() {
  const store = new Map<string, any>();
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();

  return {
    pipeline: () => {
      const commands: Array<() => Promise<any>> = [];
      const pipe = {
        hset: (key: string, data: Record<string, string>) => {
          commands.push(async () => {
            if (!hashes.has(key)) hashes.set(key, new Map());
            Object.entries(data).forEach(([k, v]) => hashes.get(key)!.set(k, v));
          });
          return pipe;
        },
        pexpire: () => {
          commands.push(async () => {});
          return pipe;
        },
        exec: async () => {
          for (const cmd of commands) await cmd();
          return [];
        },
      };
      return pipe;
    },
    hget: async (key: string, field: string) => {
      return hashes.get(key)?.get(field) || null;
    },
    hgetall: async (key: string) => {
      const hash = hashes.get(key);
      if (!hash) return {};
      return Object.fromEntries(hash.entries());
    },
    hincrby: async (key: string, field: string, increment: number) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const current = parseInt(hashes.get(key)!.get(field) || "0", 10);
      const newVal = current + increment;
      hashes.get(key)!.set(field, String(newVal));
      return newVal;
    },
    ping: async () => "PONG",
    quit: async () => {},
    on: () => {},
    defineCommand: () => {},
    // Mock the custom Lua script commands
    incrementSent: async () => [1, 0, 10, 0],
    incrementFailed: async () => [0, 1, 10, 0],
    checkRecipientStatus: async () => null,
  };
}

describe("HotStateManager Circuit Breaker", () => {
  let manager: HotStateManager;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRedis = createMockRedis();
    manager = new HotStateManager({
      redis: mockRedis as any,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 5000,
      circuitBreakerWindowMs: 10000, // 10 second window
    });
  });

  describe("Sliding window behavior", () => {
    it("should trip circuit after threshold failures within window", async () => {
      // Simulate 3 failures within the window
      for (let i = 0; i < 3; i++) {
        try {
          // Force a failure by making Redis throw
          mockRedis.hget = async () => {
            throw new Error("Connection failed");
          };
          await manager.checkRecipientProcessed("batch1", "recipient1");
        } catch (e) {
          // Expected
        }
      }

      const state = manager.getCircuitState();
      expect(state.state).toBe("open");
      expect(state.failures).toBe(3);
    });

    it("should not trip circuit if failures age out of window", async () => {
      // First failure
      try {
        mockRedis.hget = async () => {
          throw new Error("Connection failed");
        };
        await manager.checkRecipientProcessed("batch1", "recipient1");
      } catch (e) {
        // Expected
      }

      // Advance time past the window
      vi.advanceTimersByTime(15000); // 15 seconds > 10 second window

      // Two more failures (but first one aged out)
      for (let i = 0; i < 2; i++) {
        try {
          await manager.checkRecipientProcessed("batch1", "recipient1");
        } catch (e) {
          // Expected
        }
      }

      const state = manager.getCircuitState();
      // Should still be closed (only 2 failures in window, threshold is 3)
      expect(state.state).toBe("closed");
      expect(state.failures).toBe(2);
    });

    it("should include window size in circuit state", () => {
      const state = manager.getCircuitState();
      expect(state.windowMs).toBe(10000);
    });

    it("should clear failures when transitioning from half-open to closed", async () => {
      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        try {
          mockRedis.hget = async () => {
            throw new Error("Connection failed");
          };
          await manager.checkRecipientProcessed("batch1", "recipient1");
        } catch (e) {
          // Expected
        }
      }

      expect(manager.getCircuitState().state).toBe("open");

      // Wait for reset timeout
      vi.advanceTimersByTime(6000);

      // Restore Redis to working state
      mockRedis.hget = async () => null;

      // Successful request should close circuit and clear failures
      const result = await manager.checkRecipientProcessed("batch1", "recipient2");
      expect(result).toBeNull();

      const state = manager.getCircuitState();
      expect(state.state).toBe("closed");
      expect(state.failures).toBe(0);
    });
  });

  describe("Circuit breaker transitions", () => {
    it("should transition from open to half-open after reset timeout", async () => {
      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        try {
          mockRedis.hget = async () => {
            throw new Error("Connection failed");
          };
          await manager.checkRecipientProcessed("batch1", "recipient1");
        } catch (e) {
          // Expected
        }
      }

      expect(manager.getCircuitState().state).toBe("open");

      // Advance time past reset timeout (5 seconds)
      vi.advanceTimersByTime(6000);

      // Check circuit allows next attempt (half-open)
      expect(manager.isAvailable()).toBe(true);
    });

    it("should reopen circuit if half-open test fails", async () => {
      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        try {
          mockRedis.hget = async () => {
            throw new Error("Connection failed");
          };
          await manager.checkRecipientProcessed("batch1", "recipient1");
        } catch (e) {
          // Expected
        }
      }

      // Wait for reset timeout
      vi.advanceTimersByTime(6000);

      // Fail during half-open
      try {
        await manager.checkRecipientProcessed("batch1", "recipient1");
      } catch (e) {
        // Expected
      }

      const state = manager.getCircuitState();
      expect(state.state).toBe("open");
    });
  });
});

describe("HotStateManager isAvailable", () => {
  let manager: HotStateManager;

  beforeEach(() => {
    vi.useFakeTimers();
    const mockRedis = createMockRedis();
    manager = new HotStateManager({
      redis: mockRedis as any,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 5000,
    });
  });

  it("should return true when circuit is closed", () => {
    expect(manager.isAvailable()).toBe(true);
  });

  it("should return false when circuit is open and not expired", async () => {
    const mockRedis = createMockRedis();
    mockRedis.hget = async () => {
      throw new Error("Connection failed");
    };
    manager = new HotStateManager({
      redis: mockRedis as any,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 5000,
      circuitBreakerWindowMs: 60000,
    });

    // Trip the circuit
    for (let i = 0; i < 3; i++) {
      try {
        await manager.checkRecipientProcessed("batch1", "recipient1");
      } catch (e) {
        // Expected
      }
    }

    expect(manager.isAvailable()).toBe(false);
  });
});
