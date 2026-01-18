/**
 * Circuit breaker pure functions.
 * All state transitions are pure - no side effects.
 */

import type {
  CircuitState,
  CircuitBreakerState,
  CircuitBreakerConfig,
  CircuitBreakerStatus,
} from "./types.js";

/**
 * Create initial circuit breaker state.
 */
export function createInitialState(): CircuitBreakerState {
  return {
    state: "closed",
    failureTimestamps: [],
    circuitOpenedAt: 0,
    lastFailureTime: 0,
  };
}

/**
 * Prune failure timestamps outside the sliding window.
 *
 * @param timestamps - Array of failure timestamps
 * @param windowMs - Sliding window size in ms
 * @param now - Current timestamp
 * @returns Filtered timestamps within window
 */
export function pruneOldFailures(
  timestamps: number[],
  windowMs: number,
  now: number
): number[] {
  const windowStart = now - windowMs;
  return timestamps.filter((ts) => ts >= windowStart);
}

/**
 * Check if circuit should allow operation.
 *
 * @param state - Current circuit state
 * @param config - Circuit breaker configuration
 * @param now - Current timestamp
 * @returns Object with canProceed flag and updated state if transitioning to half-open
 */
export function checkCircuit(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): { canProceed: boolean; newState?: CircuitBreakerState } {
  if (state.state === "closed" || state.state === "half-open") {
    return { canProceed: true };
  }

  // State is open - check if we should transition to half-open
  if (now - state.circuitOpenedAt >= config.resetMs) {
    return {
      canProceed: true,
      newState: {
        ...state,
        state: "half-open",
      },
    };
  }

  return { canProceed: false };
}

/**
 * Record a successful operation.
 *
 * @param state - Current circuit state
 * @returns New circuit state after success
 */
export function recordSuccess(state: CircuitBreakerState): CircuitBreakerState {
  if (state.state === "half-open") {
    // Successful test - close circuit and clear failures
    return {
      ...state,
      state: "closed",
      failureTimestamps: [],
    };
  }

  // In closed state, failures naturally age out
  return state;
}

/**
 * Record a failed operation.
 *
 * @param state - Current circuit state
 * @param config - Circuit breaker configuration
 * @param now - Current timestamp
 * @returns New circuit state after failure
 */
export function recordFailure(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): CircuitBreakerState {
  // Add new failure timestamp
  const newTimestamps = [...state.failureTimestamps, now];

  // Prune old failures outside window
  const prunedTimestamps = pruneOldFailures(newTimestamps, config.windowMs, now);

  if (state.state === "half-open") {
    // Failed during test - reopen circuit
    return {
      state: "open",
      failureTimestamps: prunedTimestamps,
      circuitOpenedAt: now,
      lastFailureTime: now,
    };
  }

  // Check if we should trip the circuit
  if (prunedTimestamps.length >= config.threshold) {
    return {
      state: "open",
      failureTimestamps: prunedTimestamps,
      circuitOpenedAt: now,
      lastFailureTime: now,
    };
  }

  // Stay closed but record failure
  return {
    ...state,
    failureTimestamps: prunedTimestamps,
    lastFailureTime: now,
  };
}

/**
 * Get circuit breaker status for monitoring.
 *
 * @param state - Current circuit state
 * @param config - Circuit breaker configuration
 * @param now - Current timestamp
 * @returns Status object for monitoring
 */
export function getCircuitStatus(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): CircuitBreakerStatus {
  const prunedTimestamps = pruneOldFailures(state.failureTimestamps, config.windowMs, now);

  const isAvailable =
    state.state === "closed" ||
    state.state === "half-open" ||
    (state.state === "open" && now - state.circuitOpenedAt >= config.resetMs);

  return {
    state: state.state,
    failures: prunedTimestamps.length,
    lastFailure: state.lastFailureTime,
    windowMs: config.windowMs,
    isAvailable,
  };
}

/**
 * Force circuit to specific state (for testing/admin).
 */
export function forceState(
  state: CircuitBreakerState,
  newCircuitState: CircuitState,
  now: number
): CircuitBreakerState {
  if (newCircuitState === "open") {
    return {
      ...state,
      state: "open",
      circuitOpenedAt: now,
    };
  }

  if (newCircuitState === "closed") {
    return {
      state: "closed",
      failureTimestamps: [],
      circuitOpenedAt: 0,
      lastFailureTime: state.lastFailureTime,
    };
  }

  return {
    ...state,
    state: newCircuitState,
  };
}
