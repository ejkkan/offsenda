# Rate Limit Testing Guide

Easy configuration for testing different provider rate limit scenarios.

## Quick Start

```typescript
import {
  RateLimitScenarios,
  calculateTestTimeout,
  verifyRateLimit,
} from "../../../test/rate-limit-helpers.js";

// Test AWS SES default limits (14/sec)
RateLimitScenarios.AWS_SES_DEFAULT();

// Test high throughput (100/sec)
RateLimitScenarios.HIGH_THROUGHPUT();

// Disable rate limiting (fastest tests)
RateLimitScenarios.NO_LIMIT();
```

## Available Scenarios

### `AWS_SES_DEFAULT()`
- **Rate**: 14 messages/second
- **Use for**: Testing real AWS SES constraints
- **Example**: New AWS account limits

### `AWS_SES_INCREASED()`
- **Rate**: 50 messages/second
- **Use for**: Testing after requesting AWS limit increase
- **Example**: After AWS approves your increase request

### `HIGH_THROUGHPUT()`
- **Rate**: 100 messages/second
- **Use for**: Testing system under high load
- **Example**: Simulating Resend or high-limit SES

### `ENTERPRISE_SCALE()`
- **Rate**: 500 messages/second
- **Use for**: Testing extreme volume scenarios
- **Example**: Future scaling, multiple providers

### `SLOW_PROVIDER()`
- **Rate**: 1 message/second
- **Use for**: Testing with extremely slow providers
- **Example**: Edge cases, timeout handling

### `NO_LIMIT()`
- **Rate**: Unlimited
- **Use for**: Fastest tests, when rate limiting isn't relevant
- **Example**: Unit tests, feature tests

### `MULTI_PROVIDER()`
- **Rates**: SES=14, Resend=100, Mock=1000
- **Use for**: Testing with multiple providers configured
- **Example**: Failover scenarios

## Helper Functions

### Calculate Test Timeout

Automatically calculate appropriate timeouts based on batch size and rate limit:

```typescript
const timeout = calculateTestTimeout(1000, 14);
// => 107142ms (1000 emails at 14/sec + 50% buffer)

it("should process batch", async () => {
  // ... test code
}, timeout);
```

### Verify Rate Limit

Check if actual throughput matches expected rate:

```typescript
const result = await verifyRateLimit(
  emailsSent,     // 140
  elapsedMs,      // 10000
  expectedLimit,  // 14
  tolerance       // 0.2 (20% tolerance, optional)
);

console.log(result.message);
// => "✓ Rate limit respected: 14.0/sec (expected 14/sec)"

expect(result.withinTolerance).toBe(true);
```

### Estimate Processing Time

Calculate how long a batch will take:

```typescript
import { estimateBatchTime } from "../../../test/rate-limit-helpers.js";

const time = estimateBatchTime(1000, 14);
// => 71428ms (71.4 seconds)
```

## Custom Configuration

Create your own scenarios:

```typescript
import { configureTestRateLimits } from "../../../test/rate-limit-helpers.js";

// Custom scenario
configureTestRateLimits({
  ses: 25,      // 25/sec
  resend: 150,  // 150/sec
  mock: 500     // 500/sec
});

// Disable entirely
configureTestRateLimits({ disabled: true });
```

## Example Test

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  RateLimitScenarios,
  calculateTestTimeout,
  verifyRateLimit,
  logRateLimitResults,
} from "../../../test/rate-limit-helpers.js";

describe("Rate Limiting", () => {
  it(
    "should respect AWS SES limits",
    async () => {
      // Configure for AWS SES
      RateLimitScenarios.AWS_SES_DEFAULT();

      const BATCH_SIZE = 140;
      const EXPECTED_RATE = 14;

      // Create and send batch
      const { id: batchId } = await createBatch({
        recipients: generateRecipients(BATCH_SIZE),
        autoSend: true,
      });

      const start = Date.now();

      // Wait for completion
      await waitFor(/* ... */, {
        timeout: calculateTestTimeout(BATCH_SIZE, EXPECTED_RATE),
      });

      const elapsed = Date.now() - start;

      // Verify rate limit
      const result = await verifyRateLimit(
        BATCH_SIZE,
        elapsed,
        EXPECTED_RATE
      );

      expect(result.withinTolerance).toBe(true);

      // Pretty output
      logRateLimitResults(
        "AWS SES Default",
        BATCH_SIZE,
        elapsed,
        EXPECTED_RATE
      );
    },
    { timeout: 300000 }
  );
});
```

## Output Example

```
╔════════════════════════════════════════════════════════════
║ Rate Limit Test: AWS SES Default (14/sec)
╠════════════════════════════════════════════════════════════
║ Emails Sent:      140
║ Time Elapsed:     10.05s
║ Expected Rate:    14/sec
║ Actual Rate:      13.93/sec
║ Compliance:       ✓ PASS
╚════════════════════════════════════════════════════════════
```

## Testing Different Scales

### Small Scale (Current: 14/sec)
```typescript
RateLimitScenarios.AWS_SES_DEFAULT();
// Test: 100-500 emails
// Time: ~7-35 seconds
```

### Medium Scale (Future: 50/sec)
```typescript
RateLimitScenarios.AWS_SES_INCREASED();
// Test: 1000-5000 emails
// Time: ~20-100 seconds
```

### Large Scale (Future: 100/sec)
```typescript
RateLimitScenarios.HIGH_THROUGHPUT();
// Test: 10,000 emails
// Time: ~100 seconds
```

### Enterprise Scale (Future: 500/sec)
```typescript
RateLimitScenarios.ENTERPRISE_SCALE();
// Test: 50,000+ emails
// Time: ~100 seconds
```

## Environment Variables

You can also set these directly in your test environment:

```bash
# In test setup
export SES_RATE_LIMIT=14
export RESEND_RATE_LIMIT=100
export MOCK_RATE_LIMIT=1000

# Run tests
pnpm test:e2e
```

## Best Practices

1. **Use `NO_LIMIT()` for non-rate-limit tests**
   - Faster test execution
   - Only test rate limiting when it's the focus

2. **Use appropriate timeouts**
   - Use `calculateTestTimeout()` helper
   - Add buffer for processing overhead

3. **Verify compliance**
   - Use `verifyRateLimit()` to check actual vs expected
   - Set reasonable tolerance (20% default)

4. **Log results**
   - Use `logRateLimitResults()` for debugging
   - Helps diagnose rate limit issues

5. **Test realistic scenarios**
   - `AWS_SES_DEFAULT` for production readiness
   - `ENTERPRISE_SCALE` for future planning
   - `SLOW_PROVIDER` for edge cases

## See Also

- Example tests: `src/__tests__/e2e/rate-limiting.test.ts.example`
- Rate limiter implementation: `src/provider-rate-limiter.ts`
- Configuration: `src/config.ts`
