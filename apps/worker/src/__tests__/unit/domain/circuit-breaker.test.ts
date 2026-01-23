import { describe, it, expect } from "vitest";
import {
  createInitialState,
  pruneOldFailures,
  checkCircuit,
  recordSuccess,
  recordFailure,
  getCircuitStatus,
  forceState,
} from "../../../domain/circuit-breaker/index.js";
import type { CircuitBreakerState, CircuitBreakerConfig } from "../../../domain/circuit-breaker/index.js";

describe("createInitialState", () => {
  it("should create closed circuit with empty failures", () => {
    const state = createInitialState();

    expect(state.state).toBe("closed");
    expect(state.failureTimestamps).toEqual([]);
    expect(state.circuitOpenedAt).toBe(0);
    expect(state.lastFailureTime).toBe(0);
  });
});

describe("pruneOldFailures", () => {
  it("should keep failures within window", () => {
    const now = 10000;
    const windowMs = 5000;
    const timestamps = [6000, 7000, 8000, 9000]; // All within window

    const result = pruneOldFailures(timestamps, windowMs, now);

    expect(result).toEqual([6000, 7000, 8000, 9000]);
  });

  it("should remove failures outside window", () => {
    const now = 10000;
    const windowMs = 5000;
    const timestamps = [3000, 4000, 6000, 8000]; // 3000, 4000 are outside

    const result = pruneOldFailures(timestamps, windowMs, now);

    expect(result).toEqual([6000, 8000]);
  });

  it("should return empty array if all failures are old", () => {
    const now = 10000;
    const windowMs = 5000;
    const timestamps = [1000, 2000, 3000];

    const result = pruneOldFailures(timestamps, windowMs, now);

    expect(result).toEqual([]);
  });

  it("should handle empty array", () => {
    const result = pruneOldFailures([], 5000, 10000);
    expect(result).toEqual([]);
  });
});

describe("checkCircuit", () => {
  const config: CircuitBreakerConfig = {
    threshold: 5,
    resetMs: 30000,
    windowMs: 60000,
  };

  it("should allow when circuit is closed", () => {
    const state: CircuitBreakerState = {
      state: "closed",
      failureTimestamps: [],
      circuitOpenedAt: 0,
      lastFailureTime: 0,
    };

    const result = checkCircuit(state, config, 10000);

    expect(result.canProceed).toBe(true);
    expect(result.newState).toBeUndefined();
  });

  it("should allow when circuit is half-open", () => {
    const state: CircuitBreakerState = {
      state: "half-open",
      failureTimestamps: [],
      circuitOpenedAt: 0,
      lastFailureTime: 0,
    };

    const result = checkCircuit(state, config, 10000);

    expect(result.canProceed).toBe(true);
  });

  it("should block when circuit is open and not expired", () => {
    const state: CircuitBreakerState = {
      state: "open",
      failureTimestamps: [],
      circuitOpenedAt: 10000,
      lastFailureTime: 10000,
    };

    // Only 15 seconds have passed, resetMs is 30 seconds
    const result = checkCircuit(state, config, 25000);

    expect(result.canProceed).toBe(false);
    expect(result.newState).toBeUndefined();
  });

  it("should transition to half-open when reset timeout passed", () => {
    const state: CircuitBreakerState = {
      state: "open",
      failureTimestamps: [],
      circuitOpenedAt: 10000,
      lastFailureTime: 10000,
    };

    // 35 seconds have passed, resetMs is 30 seconds
    const result = checkCircuit(state, config, 45000);

    expect(result.canProceed).toBe(true);
    expect(result.newState?.state).toBe("half-open");
  });
});

describe("recordSuccess", () => {
  it("should close circuit when in half-open state", () => {
    const state: CircuitBreakerState = {
      state: "half-open",
      failureTimestamps: [1000, 2000],
      circuitOpenedAt: 1000,
      lastFailureTime: 2000,
    };

    const newState = recordSuccess(state);

    expect(newState.state).toBe("closed");
    expect(newState.failureTimestamps).toEqual([]);
  });

  it("should not change closed state", () => {
    const state: CircuitBreakerState = {
      state: "closed",
      failureTimestamps: [1000],
      circuitOpenedAt: 0,
      lastFailureTime: 1000,
    };

    const newState = recordSuccess(state);

    expect(newState.state).toBe("closed");
    // Failures not cleared in closed state - they age out naturally
    expect(newState.failureTimestamps).toEqual([1000]);
  });
});

describe("recordFailure", () => {
  const config: CircuitBreakerConfig = {
    threshold: 3,
    resetMs: 30000,
    windowMs: 60000,
  };

  it("should add failure timestamp", () => {
    const state: CircuitBreakerState = {
      state: "closed",
      failureTimestamps: [1000],
      circuitOpenedAt: 0,
      lastFailureTime: 1000,
    };

    const newState = recordFailure(state, config, 5000);

    expect(newState.failureTimestamps).toContain(5000);
    expect(newState.lastFailureTime).toBe(5000);
  });

  it("should trip circuit when threshold reached", () => {
    const state: CircuitBreakerState = {
      state: "closed",
      failureTimestamps: [1000, 2000], // 2 failures already
      circuitOpenedAt: 0,
      lastFailureTime: 2000,
    };

    // Third failure should trip circuit
    const newState = recordFailure(state, config, 3000);

    expect(newState.state).toBe("open");
    expect(newState.circuitOpenedAt).toBe(3000);
  });

  it("should not trip circuit below threshold", () => {
    const state: CircuitBreakerState = {
      state: "closed",
      failureTimestamps: [1000], // 1 failure
      circuitOpenedAt: 0,
      lastFailureTime: 1000,
    };

    // Second failure - still below threshold of 3
    const newState = recordFailure(state, config, 2000);

    expect(newState.state).toBe("closed");
    expect(newState.failureTimestamps.length).toBe(2);
  });

  it("should reopen circuit when half-open fails", () => {
    const state: CircuitBreakerState = {
      state: "half-open",
      failureTimestamps: [],
      circuitOpenedAt: 1000,
      lastFailureTime: 1000,
    };

    const newState = recordFailure(state, config, 35000);

    expect(newState.state).toBe("open");
    expect(newState.circuitOpenedAt).toBe(35000);
  });

  it("should prune old failures when recording new one", () => {
    const state: CircuitBreakerState = {
      state: "closed",
      failureTimestamps: [1000, 2000], // These are old (> 60s ago)
      circuitOpenedAt: 0,
      lastFailureTime: 2000,
    };

    // Now is 100000, window is 60000, so failures before 40000 should be pruned
    const newState = recordFailure(state, config, 100000);

    expect(newState.failureTimestamps).toEqual([100000]); // Only new failure
    expect(newState.state).toBe("closed"); // Didn't trip because old failures pruned
  });
});

describe("getCircuitStatus", () => {
  const config: CircuitBreakerConfig = {
    threshold: 3,
    resetMs: 30000,
    windowMs: 60000,
  };

  it("should return status for closed circuit", () => {
    const state: CircuitBreakerState = {
      state: "closed",
      failureTimestamps: [50000, 55000],
      circuitOpenedAt: 0,
      lastFailureTime: 55000,
    };

    const status = getCircuitStatus(state, config, 60000);

    expect(status.state).toBe("closed");
    expect(status.failures).toBe(2);
    expect(status.lastFailure).toBe(55000);
    expect(status.windowMs).toBe(60000);
    expect(status.isAvailable).toBe(true);
  });

  it("should return unavailable for open circuit", () => {
    const state: CircuitBreakerState = {
      state: "open",
      failureTimestamps: [50000, 55000, 60000],
      circuitOpenedAt: 60000,
      lastFailureTime: 60000,
    };

    const status = getCircuitStatus(state, config, 70000);

    expect(status.state).toBe("open");
    expect(status.isAvailable).toBe(false);
  });

  it("should return available when open circuit can transition", () => {
    const state: CircuitBreakerState = {
      state: "open",
      failureTimestamps: [],
      circuitOpenedAt: 10000,
      lastFailureTime: 10000,
    };

    // Reset timeout (30s) has passed
    const status = getCircuitStatus(state, config, 50000);

    expect(status.state).toBe("open");
    expect(status.isAvailable).toBe(true); // Can transition to half-open
  });

  it("should prune old failures in status", () => {
    const state: CircuitBreakerState = {
      state: "closed",
      failureTimestamps: [10000, 20000, 80000, 90000],
      circuitOpenedAt: 0,
      lastFailureTime: 90000,
    };

    // Now is 100000, window is 60000, so only 80000 and 90000 are in window
    const status = getCircuitStatus(state, config, 100000);

    expect(status.failures).toBe(2);
  });
});

describe("forceState", () => {
  it("should force circuit open", () => {
    const state: CircuitBreakerState = {
      state: "closed",
      failureTimestamps: [],
      circuitOpenedAt: 0,
      lastFailureTime: 0,
    };

    const newState = forceState(state, "open", 10000);

    expect(newState.state).toBe("open");
    expect(newState.circuitOpenedAt).toBe(10000);
  });

  it("should force circuit closed and clear failures", () => {
    const state: CircuitBreakerState = {
      state: "open",
      failureTimestamps: [1000, 2000, 3000],
      circuitOpenedAt: 3000,
      lastFailureTime: 3000,
    };

    const newState = forceState(state, "closed", 10000);

    expect(newState.state).toBe("closed");
    expect(newState.failureTimestamps).toEqual([]);
    expect(newState.circuitOpenedAt).toBe(0);
  });

  it("should force half-open state", () => {
    const state: CircuitBreakerState = {
      state: "open",
      failureTimestamps: [1000, 2000],
      circuitOpenedAt: 2000,
      lastFailureTime: 2000,
    };

    const newState = forceState(state, "half-open", 10000);

    expect(newState.state).toBe("half-open");
    // Other state preserved
    expect(newState.failureTimestamps).toEqual([1000, 2000]);
  });
});
