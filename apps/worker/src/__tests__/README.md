# Rate Limiter Tests

## Overview

Tests for the distributed rate limiting system using Dragonfly.

## Test Files

### `rate-limiter.test.ts` - Unit Tests
Tests the `RateLimiterService` class directly without HTTP overhead.

**Tests:**
- ✅ Allows requests under limit
- ✅ Blocks requests over limit
- ✅ Returns correct remaining count
- ✅ Resets after window expiration
- ✅ Handles concurrent requests correctly
- ✅ Isolates different IPs
- ✅ Includes correct resetAt timestamp
- ✅ Health check functionality
- ✅ Gracefully handles Dragonfly being down (fail-open)

### `rate-limiter.integration.test.ts` - Integration Tests
Tests rate limiting through the actual HTTP API endpoints.

**Tests:**
- ✅ Enforces rate limits across multiple HTTP requests
- ✅ Includes rate limit headers (X-RateLimit-*)
- ✅ Isolates rate limits per IP
- ✅ Handles concurrent HTTP requests
- ✅ Returns correct retry-after header

## Running Tests

### Prerequisites

**For Unit Tests:**
```bash
# Start Dragonfly
docker-compose -f docker-compose.local.yml up dragonfly

# Or if running full stack:
docker-compose -f docker-compose.local.yml up
```

**For Integration Tests:**
```bash
# Start full stack (worker + dragonfly)
docker-compose -f docker-compose.local.yml up
```

### Run Unit Tests

```bash
# From project root
pnpm test:ratelimit

# Or from apps/worker
cd apps/worker
pnpm test:ratelimit
```

### Run Integration Tests

```bash
# From project root
pnpm --filter=worker test:ratelimit:integration

# Or from apps/worker
cd apps/worker
pnpm test:ratelimit:integration
```

### Run All Tests

```bash
# Unit + Integration + E2E
pnpm --filter=worker test:all
```

### Watch Mode

```bash
cd apps/worker
vitest src/__tests__/rate-limiter.test.ts
```

## Test Coverage

Run with coverage:
```bash
cd apps/worker
vitest run --coverage src/__tests__/rate-limiter.test.ts
```

## Troubleshooting

### "Connection refused" errors

**Problem:** Dragonfly isn't running or isn't accessible.

**Solution:**
```bash
# Check if Dragonfly is running
docker-compose -f docker-compose.local.yml ps dragonfly

# Start Dragonfly
docker-compose -f docker-compose.local.yml up dragonfly -d

# Test connection
redis-cli -p 6379 ping
# Should return: PONG
```

### Tests fail with "WRONGTYPE" errors

**Problem:** Stale rate limit keys from previous tests.

**Solution:**
```bash
# Clear all rate limit keys
redis-cli -p 6379 --scan --pattern "rate_limit:*" | xargs redis-cli -p 6379 del
```

### Integration tests timeout

**Problem:** Worker isn't running or isn't accessible.

**Solution:**
```bash
# Check worker is running
curl http://localhost:6001/health

# Start worker
docker-compose -f docker-compose.local.yml up worker -d

# Check logs
docker-compose -f docker-compose.local.yml logs worker
```

## Manual Testing

### Test Rate Limiting via CLI

```bash
# Make 100 requests to health endpoint
for i in {1..100}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "X-Forwarded-For: 192.168.1.100" \
    http://localhost:6001/health
done

# 101st request should return 429
curl -v -H "X-Forwarded-For: 192.168.1.100" http://localhost:6001/health
```

### Check Rate Limit Keys in Dragonfly

```bash
# List all rate limit keys
redis-cli -p 6379 --scan --pattern "rate_limit:*"

# Check specific IP
redis-cli -p 6379 ZCARD "rate_limit:ip:192.168.1.100"

# See all entries for an IP
redis-cli -p 6379 ZRANGE "rate_limit:ip:192.168.1.100" 0 -1 WITHSCORES

# Clear a specific IP
redis-cli -p 6379 DEL "rate_limit:ip:192.168.1.100"
```

### Test with curl and jq

```bash
# Check rate limit headers
curl -s -H "X-Forwarded-For: 192.168.1.100" http://localhost:6001/health -v 2>&1 | grep "X-RateLimit"

# Output:
# X-RateLimit-Limit: 100
# X-RateLimit-Remaining: 99
# X-RateLimit-Reset: 1704067200
```

## CI/CD

These tests are automatically run in CI when:
- Opening a PR
- Pushing to main
- Deploying to staging/production

**Note:** Integration tests require Dragonfly to be available in the CI environment.
