/**
 * Test Helpers for Rate Limiting
 *
 * For most tests, rate limiting is disabled via DISABLE_RATE_LIMIT=true.
 * These helpers are for specific rate limiting integration tests.
 */

/**
 * Disable rate limiting for tests (default behavior)
 */
export function disableRateLimiting() {
  process.env.DISABLE_RATE_LIMIT = "true";
}

/**
 * Enable rate limiting for integration tests
 */
export function enableRateLimiting() {
  process.env.DISABLE_RATE_LIMIT = "false";
}

/**
 * Configure managed mode rate limits for testing
 */
export function configureManagedRateLimits(config: {
  system?: number;
  ses?: number;
  resend?: number;
  telnyx?: number;
}) {
  if (config.system !== undefined) {
    process.env.SYSTEM_RATE_LIMIT = String(config.system);
  }
  if (config.ses !== undefined) {
    process.env.MANAGED_SES_RATE_LIMIT = String(config.ses);
  }
  if (config.resend !== undefined) {
    process.env.MANAGED_RESEND_RATE_LIMIT = String(config.resend);
  }
  if (config.telnyx !== undefined) {
    process.env.MANAGED_TELNYX_RATE_LIMIT = String(config.telnyx);
  }
}

/**
 * Calculate expected time for a batch based on rate limit
 */
export function estimateBatchTime(
  messageCount: number,
  rateLimit: number
): number {
  return Math.ceil((messageCount / rateLimit) * 1000);
}

/**
 * Calculate appropriate test timeout for a batch
 * Adds 50% buffer for processing overhead
 */
export function calculateTestTimeout(
  messageCount: number,
  rateLimit: number,
  bufferMultiplier: number = 1.5
): number {
  const baseTime = estimateBatchTime(messageCount, rateLimit);
  return Math.ceil(baseTime * bufferMultiplier);
}
