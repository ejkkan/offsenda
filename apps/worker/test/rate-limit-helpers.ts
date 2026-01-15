/**
 * Test Helpers for Rate Limiting
 *
 * Easy configuration of provider rate limits for different test scenarios
 */

/**
 * Configure rate limits for test scenarios
 *
 * @example
 * ```typescript
 * // Test AWS SES limits
 * configureTestRateLimits({ ses: 14 });
 *
 * // Test extreme high load
 * configureTestRateLimits({ ses: 1000 });
 *
 * // Test very slow provider
 * configureTestRateLimits({ ses: 1 });
 *
 * // No rate limiting (fastest tests)
 * configureTestRateLimits({ disabled: true });
 * ```
 */
export function configureTestRateLimits(config: {
  ses?: number;
  resend?: number;
  mock?: number;
  disabled?: boolean;
}) {
  if (config.disabled) {
    // Disable rate limiting entirely (fastest for tests)
    process.env.MOCK_RATE_LIMIT = "999999";
    process.env.SES_RATE_LIMIT = "999999";
    process.env.RESEND_RATE_LIMIT = "999999";
    return;
  }

  if (config.ses !== undefined) {
    process.env.SES_RATE_LIMIT = String(config.ses);
  }

  if (config.resend !== undefined) {
    process.env.RESEND_RATE_LIMIT = String(config.resend);
  }

  if (config.mock !== undefined) {
    process.env.MOCK_RATE_LIMIT = String(config.mock);
  }
}

/**
 * Predefined test scenarios
 */
export const RateLimitScenarios = {
  /**
   * AWS SES default limits (14/sec)
   * Use this to test real AWS SES constraints
   */
  AWS_SES_DEFAULT: () => configureTestRateLimits({ ses: 14, mock: 14 }),

  /**
   * AWS SES increased limits (50/sec)
   * Test scenario after requesting limit increase
   */
  AWS_SES_INCREASED: () => configureTestRateLimits({ ses: 50, mock: 50 }),

  /**
   * High throughput scenario (100/sec)
   * Test system under high load
   */
  HIGH_THROUGHPUT: () => configureTestRateLimits({ ses: 100, mock: 100 }),

  /**
   * Enterprise scale (500/sec)
   * Test extreme high volume
   */
  ENTERPRISE_SCALE: () => configureTestRateLimits({ ses: 500, mock: 500 }),

  /**
   * Very slow provider (1/sec)
   * Test system behavior with extremely slow provider
   */
  SLOW_PROVIDER: () => configureTestRateLimits({ ses: 1, mock: 1 }),

  /**
   * No rate limiting (fastest tests)
   * Use for unit tests where rate limiting isn't relevant
   */
  NO_LIMIT: () => configureTestRateLimits({ disabled: true }),

  /**
   * Multi-provider scenario
   * Different limits for different providers
   */
  MULTI_PROVIDER: () => configureTestRateLimits({
    ses: 14,      // AWS SES default
    resend: 100,  // Resend default
    mock: 1000    // Mock no limit
  }),
};

/**
 * Calculate expected time for a batch based on rate limit
 *
 * @example
 * ```typescript
 * const time = estimateBatchTime(1000, 14); // 1000 emails at 14/sec
 * console.log(`Expected time: ${time}ms (${time/1000}s)`);
 * // => Expected time: 71428ms (71.4s)
 * ```
 */
export function estimateBatchTime(
  emailCount: number,
  rateLimit: number
): number {
  return Math.ceil((emailCount / rateLimit) * 1000);
}

/**
 * Calculate appropriate test timeout for a batch
 * Adds 50% buffer for processing overhead
 *
 * @example
 * ```typescript
 * const timeout = calculateTestTimeout(1000, 14);
 *
 * it("should process batch", async () => {
 *   // ...
 * }, timeout);
 * ```
 */
export function calculateTestTimeout(
  emailCount: number,
  rateLimit: number,
  bufferMultiplier: number = 1.5
): number {
  const baseTime = estimateBatchTime(emailCount, rateLimit);
  return Math.ceil(baseTime * bufferMultiplier);
}

/**
 * Test helper to verify rate limiting is working
 * Measures actual throughput and compares to expected limit
 */
export async function verifyRateLimit(
  emailsSent: number,
  elapsedMs: number,
  expectedLimit: number,
  tolerance: number = 0.2 // 20% tolerance
): Promise<{
  actualRate: number;
  expectedRate: number;
  withinTolerance: boolean;
  message: string;
}> {
  const actualRate = (emailsSent / elapsedMs) * 1000;
  const lowerBound = expectedLimit * (1 - tolerance);
  const upperBound = expectedLimit * (1 + tolerance);
  const withinTolerance = actualRate >= lowerBound && actualRate <= upperBound;

  return {
    actualRate,
    expectedRate: expectedLimit,
    withinTolerance,
    message: withinTolerance
      ? `✓ Rate limit respected: ${actualRate.toFixed(2)}/sec (expected ${expectedLimit}/sec)`
      : `✗ Rate limit violated: ${actualRate.toFixed(2)}/sec (expected ${expectedLimit}/sec ±${tolerance * 100}%)`,
  };
}

/**
 * Print rate limit test results
 */
export function logRateLimitResults(
  scenario: string,
  emailCount: number,
  elapsedMs: number,
  rateLimit: number
) {
  const actualRate = (emailCount / elapsedMs) * 1000;
  console.log(`
╔════════════════════════════════════════════════════════════
║ Rate Limit Test: ${scenario}
╠════════════════════════════════════════════════════════════
║ Emails Sent:      ${emailCount}
║ Time Elapsed:     ${(elapsedMs / 1000).toFixed(2)}s
║ Expected Rate:    ${rateLimit}/sec
║ Actual Rate:      ${actualRate.toFixed(2)}/sec
║ Compliance:       ${Math.abs(actualRate - rateLimit) < rateLimit * 0.2 ? '✓ PASS' : '✗ FAIL'}
╚════════════════════════════════════════════════════════════
  `);
}
