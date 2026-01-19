# Rate Limiting: Managed vs BYOK Flows

This document explains the rate limiting architecture that handles two distinct flows:
- **Managed Mode**: Users share BatchSender's provider accounts
- **BYOK Mode**: Users bring their own provider credentials

## Overview

Rate limiting is implemented using a token bucket algorithm with Redis/Dragonfly for distributed coordination. The key innovation is that **managed mode users share provider-level limits**, while BYOK users only have per-config limits.

## Two Flows Explained

### Managed Flow

When users use BatchSender's managed infrastructure (e.g., our SES account, our Resend account):

```
Rate Limit = MIN(system, managed_provider, config)
```

- **System limit**: Global cap across all users (default: 10,000/sec)
- **Managed provider limit**: Shared by ALL managed users of that provider
  - SES: 14/sec (AWS default sandbox limit)
  - Resend: 100/sec
  - Telnyx: 50/sec
  - Mock: 5,000/sec (for testing)
- **Config limit**: Per sendConfig limit set by user

**Key insight**: All users sending via managed SES share the same 14/sec limit because they're using BatchSender's AWS account.

### BYOK Flow

When users bring their own API credentials:

```
Rate Limit = MIN(system, config)
```

- **System limit**: Same global cap
- **Config limit**: Per sendConfig limit

**Key insight**: BYOK users don't share provider limits because each has their own account with their own quotas.

## Redis Key Structure

```
rate_limit:system:bucket                    # System-wide (singleton)
rate_limit:managed:ses:bucket               # Shared by ALL managed SES users
rate_limit:managed:resend:bucket            # Shared by ALL managed Resend users
rate_limit:managed:telnyx:bucket            # Shared by ALL managed Telnyx users
rate_limit:config:{sendConfigId}:bucket     # Per-user config limit
```

### Debugging Keys

To inspect current rate limit state:

```bash
# Check system-wide limit
redis-cli HMGET rate_limit:system:bucket tokens last_update

# Check managed SES shared limit
redis-cli HMGET rate_limit:managed:ses:bucket tokens last_update

# Check a specific config's limit
redis-cli HMGET rate_limit:config:cfg_abc123:bucket tokens last_update
```

## Configuration Options

Add these to your `.env` file:

```bash
# System-wide limit (all requests)
SYSTEM_RATE_LIMIT=10000

# Managed provider limits (shared by all managed users)
MANAGED_SES_RATE_LIMIT=14
MANAGED_RESEND_RATE_LIMIT=100
MANAGED_TELNYX_RATE_LIMIT=50
MANAGED_MOCK_RATE_LIMIT=5000

# SMS provider for managed mode
SMS_PROVIDER=telnyx  # or "mock" for testing

# Disable rate limiting (for testing only!)
DISABLE_RATE_LIMIT=false
```

## Code Usage

### Acquiring Rate Limits

```typescript
import { acquireRateLimit } from './rate-limiting';

// In your worker/handler:
const result = await acquireRateLimit(sendConfig, userId, timeout);
if (!result.allowed) {
  throw new Error(`Rate limit exceeded (${result.limitingFactor})`);
}
```

### Getting Rate Limit Status

```typescript
import { getRateLimitStatus } from './rate-limiting';

const status = await getRateLimitStatus(sendConfig, userId);
// Returns: { system: { tokens, capacity, rate }, provider?: {...}, config: {...} }
```

## Flow Detection

The system automatically detects managed vs BYOK based on the module config:

**Email Module** (`EmailModuleConfig`):
- `mode: "managed"` → Managed flow
- `mode: "byok"` → BYOK flow

**SMS Module** (`SmsModuleConfig`):
- `mode: "managed"` → Managed flow
- `mode: "byok"` or not set → BYOK flow (backwards compatible)

## Testing Strategies

### Unit Tests

Test the rate limit registry composition:

```typescript
it('managed mode includes provider limiter', async () => {
  const context = buildManagedEmailContext('cfg_123', 'user_456');
  expect(context.mode).toBe('managed');
  // Verify provider limiter is included in chain
});

it('BYOK mode excludes provider limiter', async () => {
  const context = buildByokEmailContext(config, 'cfg_123', 'user_456');
  expect(context.mode).toBe('byok');
  // Verify no provider limiter in chain
});
```

### Integration Tests

Test shared limits with real Redis:

```typescript
it('multiple managed users share SES 14/sec limit', async () => {
  // Create 3 users with managed SES
  const users = ['user1', 'user2', 'user3'];

  // Send 20 requests simultaneously
  const results = await Promise.all(
    Array(20).fill(null).map((_, i) =>
      acquireRateLimit(managedSesConfig, users[i % 3], 1000)
    )
  );

  // Verify only ~14 succeed immediately (others wait or fail)
  const immediate = results.filter(r => r.allowed).length;
  expect(immediate).toBeLessThanOrEqual(14);
});

it('BYOK user not affected by managed limit', async () => {
  // Exhaust managed SES limit
  await exhaustManagedLimit('ses');

  // BYOK user should still succeed
  const result = await acquireRateLimit(byokSesConfig, 'byok_user', 100);
  expect(result.allowed).toBe(true);
});
```

### Load Testing (k6)

```javascript
// k6 script to verify managed users share limit
export default function() {
  // Simulate multiple users hitting managed endpoint
  const userId = `user_${__VU % 10}`;  // 10 users

  http.post(`${BASE_URL}/api/send`, {
    sendConfigId: 'managed_ses_config',
    // ...
  });
}

export function handleSummary(data) {
  // Check that total throughput matches provider limit
  const rps = data.metrics.http_reqs.values.rate;
  console.log(`Achieved RPS: ${rps}`);
  // Should be ~14/sec for SES regardless of VU count
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        acquireRateLimit()                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│    ┌──────────────┐     ┌───────────────┐     ┌─────────────┐  │
│    │ Detect Mode  │────▶│ Build Context │────▶│  Registry   │  │
│    └──────────────┘     └───────────────┘     └─────────────┘  │
│           │                     │                    │          │
│           ▼                     ▼                    ▼          │
│    ┌──────────────┐     ┌───────────────┐     ┌─────────────┐  │
│    │managed-flow  │     │ RateLimiter   │     │ Token Bucket│  │
│    │  or         │     │   Context     │     │   (Redis)   │  │
│    │byok-flow    │     │              │     │             │  │
│    └──────────────┘     └───────────────┘     └─────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

                    Managed Flow Chain:
┌──────────┐    ┌─────────────┐    ┌──────────────┐
│  System  │───▶│  Provider   │───▶│   Config     │
│  Limit   │    │   Limit     │    │   Limit      │
│ (shared) │    │  (shared)   │    │ (per-user)   │
└──────────┘    └─────────────┘    └──────────────┘

                     BYOK Flow Chain:
┌──────────┐    ┌──────────────┐
│  System  │───▶│   Config     │
│  Limit   │    │   Limit      │
│ (shared) │    │ (per-user)   │
└──────────┘    └──────────────┘
```

## Troubleshooting

### Rate Limits Not Working

1. Check if `DISABLE_RATE_LIMIT=true` in your env
2. Verify Dragonfly/Redis is accessible
3. Check the logs for rate limit errors

### Managed Users Seem Isolated

Verify they're using managed mode:
```typescript
// Check sendConfig.config.mode === 'managed'
```

### Provider Limit Too Low

Update environment variables:
```bash
MANAGED_SES_RATE_LIMIT=50  # After requesting limit increase from AWS
```

## Future Improvements

- [ ] Add tier-based rate limits (free, pro, enterprise)
- [ ] Add rate limit headers to API responses
- [ ] Add rate limit metrics to Prometheus
- [ ] Add alerting when approaching limits
