# Testing Guide

Simple pnpm commands to run all tests. E2E tests automatically manage their own Docker infrastructure.

## Quick Start

```bash
# Unit tests (fast, no infrastructure needed)
pnpm test

# Integration tests (needs infrastructure)
pnpm test:integration

# E2E tests (automatically starts infrastructure)
pnpm test:e2e

# All tests
pnpm test:all
```

## Test Types

### 1. Unit Tests
**Fast** • **No infrastructure needed**

```bash
pnpm test
# or
pnpm test:unit
```

Tests individual components in isolation (e.g., MockEmailProvider).

**What it tests:**
- Mock provider modes (success, fail, random)
- Message ID generation
- Latency simulation
- Batch sending

**Runtime:** ~300ms

---

### 2. Integration Tests
**Medium** • **Needs infrastructure**

```bash
pnpm test:integration
```

Tests database operations and ClickHouse without NATS/Worker.

**What it tests:**
- Database CRUD operations
- Batch counter updates
- Recipient status tracking
- ClickHouse event logging
- Webhook deduplication

**Infrastructure needed:**
- PostgreSQL
- ClickHouse

**Note:** You need to manually start infrastructure for integration tests:
```bash
cd apps/worker
docker compose -f docker-compose.test.yml up -d postgres clickhouse
pnpm test:integration
docker compose -f docker-compose.test.yml down
```

---

### 3. E2E Tests ⭐
**Slow** • **Automatically manages infrastructure**

```bash
pnpm test:e2e
```

Tests complete user journeys via HTTP API. **Infrastructure automatically starts before tests and stops after.**

**What it tests:**
- Full async flow: API → DB → NATS → Worker → Email
- NATS queue operations
- Worker processing
- Large batches (1k-10k emails)
- Concurrent batches
- Webhook processing
- Autoscaling readiness

**Infrastructure (auto-managed):**
- ✅ NATS with JetStream
- ✅ PostgreSQL
- ✅ ClickHouse
- ✅ Worker process
- ✅ HTTP API

**Runtime:** 2-10 minutes

**Debug mode:**
```bash
DEBUG_WORKER=true pnpm test:e2e
```

---

## From Root Directory

All commands work from the project root:

```bash
# From /Users/erikmagnusson/Programming/batchsender
pnpm test              # Unit tests
pnpm test:integration  # Integration tests
pnpm test:e2e          # E2E tests
pnpm test:all          # All tests
```

## CI/CD Integration

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm test:unit

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm test:e2e  # Automatically handles Docker
```

## What Changed from BullMQ/Dragonfly

### Before
- ❌ No queue integration tests
- ❌ Manual infrastructure management
- ❌ Complex shell scripts
- ❌ No autoscaling validation

### After
- ✅ Full NATS queue testing
- ✅ Automatic infrastructure management
- ✅ Simple pnpm commands
- ✅ Autoscaling readiness validation
- ✅ Complete E2E flow validation

## Performance Expectations

Based on test results:

| Metric | Target |
|--------|--------|
| Throughput | >50 emails/sec |
| 10k batch | 3-5 minutes |
| Concurrent batches | 10+ simultaneously |
| Test suite runtime | ~2-5 minutes |

## Troubleshooting

### E2E tests fail to start

```bash
# Check Docker is running
docker ps

# Check ports are free
lsof -i :4222  # NATS
lsof -i :5433  # PostgreSQL
lsof -i :8124  # ClickHouse
lsof -i :3001  # Worker

# Manually clean up if needed
cd apps/worker
docker compose -f docker-compose.test.yml down -v
```

### Tests timeout

Increase timeout in `vitest.e2e.config.ts`:

```typescript
export default defineConfig({
  test: {
    testTimeout: 180000, // 3 minutes
  }
});
```

### Worker won't start

Enable debug mode:

```bash
DEBUG_WORKER=true pnpm test:e2e
```

## Key Files

```
apps/worker/
├── test/
│   ├── setup.ts              # Auto-manages Docker infrastructure
│   └── helpers.ts            # E2E test helpers
├── src/__tests__/
│   ├── e2e/                  # E2E tests (full system)
│   │   ├── basic-batch-flow.test.ts
│   │   ├── large-batch.test.ts
│   │   ├── concurrent-batches.test.ts
│   │   └── webhook-flow.test.ts
│   ├── integration/          # Integration tests (DB + ClickHouse)
│   │   ├── full-batch-flow.test.ts
│   │   └── webhook-deduplication.test.ts
│   └── helpers/
│       └── fixtures.ts
├── vitest.config.ts          # Unit + integration tests
├── vitest.e2e.config.ts      # E2E tests
└── docker-compose.test.yml   # Test infrastructure
```

## That's It!

No more manual infrastructure management. Just run:

```bash
pnpm test:e2e
```

And everything happens automatically! 🎉
