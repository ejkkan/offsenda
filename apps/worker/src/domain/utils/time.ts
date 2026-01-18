/**
 * Time provider abstraction for testable time-dependent code.
 * Allows injecting mock time in tests.
 */

export interface TimeProvider {
  /** Get current timestamp in milliseconds */
  now(): number;
}

/**
 * Default time provider using system clock.
 */
export class SystemTimeProvider implements TimeProvider {
  now(): number {
    return Date.now();
  }
}

/**
 * Mock time provider for testing.
 * Allows controlling time in unit tests.
 */
export class MockTimeProvider implements TimeProvider {
  private currentTime: number;

  constructor(initialTime: number = 0) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  /** Advance time by specified milliseconds */
  advanceBy(ms: number): void {
    this.currentTime += ms;
  }

  /** Set time to specific value */
  setTime(time: number): void {
    this.currentTime = time;
  }
}

// Default singleton for production use
let defaultTimeProvider: TimeProvider = new SystemTimeProvider();

/**
 * Get the default time provider.
 * Can be overridden for testing.
 */
export function getTimeProvider(): TimeProvider {
  return defaultTimeProvider;
}

/**
 * Set the default time provider (for testing).
 */
export function setTimeProvider(provider: TimeProvider): void {
  defaultTimeProvider = provider;
}

/**
 * Reset to system time provider.
 */
export function resetTimeProvider(): void {
  defaultTimeProvider = new SystemTimeProvider();
}
