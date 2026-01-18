/**
 * Circuit breaker types.
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerState {
  /** Current state of the circuit */
  state: CircuitState;
  /** Timestamps of failures within the sliding window */
  failureTimestamps: number[];
  /** Timestamp when circuit was last opened */
  circuitOpenedAt: number;
  /** Timestamp of the last failure */
  lastFailureTime: number;
}

export interface CircuitBreakerConfig {
  /** Number of failures within window to trip circuit */
  threshold: number;
  /** Time in ms before attempting reset from open state */
  resetMs: number;
  /** Sliding window size in ms for counting failures */
  windowMs: number;
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  windowMs: number;
  isAvailable: boolean;
}
