# Testing - Simple Setup

## Just Run These Commands

```bash
# Unit tests (fast - no infrastructure)
pnpm test

# Integration tests (needs manual infrastructure)
pnpm test:integration

# E2E tests (automatically manages infrastructure)
pnpm test:e2e

# All tests
pnpm test:all
```

## What Happens Automatically

### E2E Tests (`pnpm test:e2e`)

When you run this command, **everything is automatic**:

1. ✅ **Starts Docker** (NATS, PostgreSQL, ClickHouse)
2. ✅ **Waits for services** to be ready
3. ✅ **Starts worker** process
4. ✅ **Runs all E2E tests**
5. ✅ **Stops worker**
6. ✅ **Stops Docker** and cleans up

You don't need to manually manage any infrastructure!

### Unit Tests (`pnpm test`)

- No infrastructure needed
- Just runs tests immediately
- Super fast (~300ms)

### Integration Tests (`pnpm test:integration`)

- You need to manually start infrastructure first:
  ```bash
  cd apps/worker
  docker compose -f docker-compose.test.yml up -d postgres clickhouse
  pnpm test:integration
  docker compose -f docker-compose.test.yml down
  ```

## Examples

### Basic Workflow

```bash
# Quick unit tests
pnpm test

# Full E2E validation (automatic infra)
pnpm test:e2e
```

### Debug E2E Tests

```bash
DEBUG_WORKER=true pnpm test:e2e
```

### Run Single E2E Test

```bash
cd apps/worker
pnpm vitest run src/__tests__/e2e/basic-batch-flow.test.ts --config vitest.e2e.config.ts
```

## From Root Directory

All commands work from project root:

```bash
cd /Users/erikmagnusson/Programming/batchsender
pnpm test           # Unit tests
pnpm test:e2e       # E2E tests (auto infrastructure)
pnpm test:all       # All tests
```

## That's It!

No scripts to remember. No manual infrastructure. Just simple pnpm commands! 🎉
