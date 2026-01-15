# Rate Limiting Quick Start

## 🚀 Super Quick Start

Test with different rate limits:

```bash
# Test with AWS SES default limit (14/sec)
pnpm test:rate:aws-ses

# Test with high throughput (100/sec)
pnpm test:rate:high

# Test enterprise scale (500/sec)
pnpm test:rate:enterprise

# Test with no rate limiting (fastest)
pnpm test:rate:no-limit

# Run all scenarios
pnpm test:rate:all
```

## 📖 What You Get

### 1. Automatic AWS SES Rate Limiting

Your system now **automatically respects** provider rate limits:

- ✅ AWS SES: 14 messages/second (your current limit)
- ✅ Works across multiple worker instances
- ✅ Prevents AWS throttling errors
- ✅ Easy to update when you get higher limits

### 2. Easy Testing

Test any scenario in your code:

```typescript
import { RateLimitScenarios } from "../../../test/rate-limit-helpers.js";

// Test AWS SES limits
RateLimitScenarios.AWS_SES_DEFAULT();

// Test future high volume
RateLimitScenarios.ENTERPRISE_SCALE();

// Fast tests (no rate limiting)
RateLimitScenarios.NO_LIMIT();
```

### 3. Smart Helpers

```typescript
// Calculate timeout for 1000 emails at 14/sec
const timeout = calculateTestTimeout(1000, 14);
// => 107142ms (auto-adds 50% buffer)

// Verify rate limit was respected
const result = await verifyRateLimit(sent, elapsed, 14);
expect(result.withinTolerance).toBe(true);
```

## 🎯 Common Use Cases

### Test Current AWS SES Limits

```bash
pnpm test:rate:aws-ses
```

This tests your system with your current 14/sec AWS limit.

### Test Future Scaling (100/sec)

```bash
pnpm test:rate:high
```

See how your system will perform after requesting higher AWS limits.

### Test Extreme Scale (500/sec)

```bash
pnpm test:rate:enterprise
```

Plan for future growth - how will your system handle enterprise volume?

### Fast Tests (Development)

```bash
pnpm test:rate:no-limit
```

Skip rate limiting for faster test runs during development.

## 📝 Available npm Scripts

| Script | Rate Limit | Use Case |
|--------|-----------|----------|
| `pnpm test:rate:aws-ses` | 14/sec | Test AWS SES default |
| `pnpm test:rate:high` | 100/sec | Test high throughput |
| `pnpm test:rate:enterprise` | 500/sec | Test enterprise scale |
| `pnpm test:rate:no-limit` | Unlimited | Fast development tests |
| `pnpm test:rate:all` | All scenarios | Full suite |

## 🔧 Production Configuration

In your `.env`:

```bash
# Current AWS SES limit
SES_RATE_LIMIT=14

# After AWS approves increase:
SES_RATE_LIMIT=50

# Or higher:
SES_RATE_LIMIT=100
```

**That's it!** Just update the number when AWS approves your limit increase.

## 📊 Example Output

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

## 📚 Available Scenarios

### Built-in Scenarios

```typescript
RateLimitScenarios.AWS_SES_DEFAULT()    // 14/sec  - Your current limit
RateLimitScenarios.AWS_SES_INCREASED()  // 50/sec  - After first increase
RateLimitScenarios.HIGH_THROUGHPUT()    // 100/sec - High volume
RateLimitScenarios.ENTERPRISE_SCALE()   // 500/sec - Enterprise
RateLimitScenarios.SLOW_PROVIDER()      // 1/sec   - Edge cases
RateLimitScenarios.NO_LIMIT()           // Unlimited - Fast tests
```

### Custom Scenario

```typescript
import { configureTestRateLimits } from "../../../test/rate-limit-helpers.js";

configureTestRateLimits({
  ses: 25,      // Custom rate
  resend: 150,
  mock: 1000
});
```

## 🎓 Full Documentation

- **Testing Guide**: `test/RATE_LIMIT_TESTING.md`
- **Example Tests**: `src/__tests__/e2e/rate-limiting.test.ts.example`
- **Production Setup**: `.env.ses-example`

## 💡 Tips

1. **Use `NO_LIMIT()` for most tests** - Fastest execution
2. **Use `AWS_SES_DEFAULT()` for production validation** - Ensure real limits work
3. **Use `ENTERPRISE_SCALE()` for planning** - See future performance
4. **Update `SES_RATE_LIMIT` as you scale** - No code changes needed

## 🚨 Important

The rate limiter is **distributed** - it works across all your worker instances:

```
Worker 1 (trying 20/sec) ┐
Worker 2 (trying 20/sec) ├─→ Rate Limiter ─→ AWS SES (14/sec) ✅
Worker 3 (trying 20/sec) ┘
```

All workers coordinate via Redis to respect the shared 14/sec limit.

## ✅ What's Next?

1. Run tests with current limits: `pnpm test:rate:aws-ses`
2. Test future scaling: `pnpm test:rate:high`
3. Request higher AWS limits
4. Update `.env` with new limit
5. Done! 🎉
