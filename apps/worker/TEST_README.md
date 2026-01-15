# Testing Guide for BatchSender Worker

This guide explains how to run the test suite for the worker application after migrating from BullMQ/Dragonfly to NATS.

## Test Structure

```
apps/worker/
├── src/
│   ├── __tests__/
│   │   ├── e2e/                    # End-to-end tests via API
│   │   │   ├── basic-batch-flow.test.ts
│   │   │   ├── large-batch.test.ts
│   │   │   ├── concurrent-batches.test.ts
│   │   │   └── webhook-flow.test.ts
│   │   ├── integration/            # Integration tests (DB/ClickHouse)
│   │   │   ├── full-batch-flow.test.ts
│   │   │   └── webhook-deduplication.test.ts
│   │   └── helpers/
│   │       └── fixtures.ts
│   └── providers/
│       └── mock-provider.test.ts   # Unit tests
├── test/
│   ├── setup.ts                    # Global test setup
│   └── helpers.ts                  # E2E test helpers
├── vitest.config.ts                # Unit + integration test config
├── vitest.e2e.config.ts            # E2E test config
└── docker-compose.test.yml         # Test infrastructure
```

## Test Types

### 1. Unit Tests
Test individual components in isolation (e.g., MockEmailProvider).

**Run:** `pnpm test`

### 2. Integration Tests
Test database operations and ClickHouse without the full worker running.

**Run:** `pnpm test:integration`

### 3. E2E Tests ⭐ (Primary for NATS validation)
Test complete user journeys via HTTP API with real NATS queue.

**Run:** `pnpm test:e2e`

**What E2E tests validate:**
- ✅ Full async flow: API → DB → NATS → Worker → Email → Webhooks
- ✅ NATS queue operations (enqueue, consume, ack/nak)
- ✅ Worker processing (batch processor, email processor)
- ✅ Large batch handling (1k-10k emails)
- ✅ Concurrent batch processing
- ✅ Autoscaling readiness (queue metrics)
- ✅ Webhook processing (delivery, bounce, complaint)
- ✅ Error handling and retries

## Quick Start

### 1. Start Test Infrastructure

```bash
# Start NATS, PostgreSQL, and ClickHouse
pnpm test:infra

# Wait for services to be ready (check health)
docker-compose -f docker-compose.test.yml ps

# View logs
pnpm test:infra:logs
```

### 2. Run E2E Tests

```bash
# Run all E2E tests
pnpm test:e2e

# Run specific test file
pnpm test:e2e src/__tests__/e2e/basic-batch-flow.test.ts

# Watch mode (for development)
pnpm test:e2e:watch
```

### 3. Cleanup

```bash
# Stop and remove test infrastructure
pnpm test:infra:down
```

## Running All Tests

```bash
# Run unit tests + integration tests + E2E tests
pnpm test:all
```

## Test Environment

### Mock Email Provider

E2E tests use `MockEmailProvider` instead of real SES:
- **No real emails sent** ✅
- **No AWS costs** ✅
- **Fast execution** (configurable latency)
- **Deterministic** (controlled success/failure)

Configure via `EMAIL_PROVIDER=mock` in `.env.test`.

### Real Infrastructure (in Docker)

E2E tests use **real instances** of:
- ✅ NATS with JetStream
- ✅ PostgreSQL
- ✅ ClickHouse
- ✅ Worker process
- ✅ Fastify HTTP server

### Simulated Webhooks

Webhooks are simulated by POSTing SNS payloads to `/webhooks/ses`:

```typescript
const webhookPayload = buildSNSMessage(
  messageId,
  "Delivery",
  "user@example.com"
);

await fetch("http://localhost:3001/webhooks/ses", {
  method: "POST",
  headers: { "x-amz-sns-message-type": "Notification" },
  body: webhookPayload
});
```

## Key Test Scenarios

### Basic Batch Flow
```bash
pnpm test:e2e src/__tests__/e2e/basic-batch-flow.test.ts
```
- Small batches (3-5 emails)
- Variable substitution
- Webhook processing
- ClickHouse event logging

### Large Batches
```bash
pnpm test:e2e src/__tests__/e2e/large-batch.test.ts
```
- 1,000 email batch
- 10,000 email batch
- Throughput measurement
- Queue metrics for autoscaling

### Concurrent Batches
```bash
pnpm test:e2e src/__tests__/e2e/concurrent-batches.test.ts
```
- Multiple batches simultaneously
- Multiple users with separate queues
- Load testing (10 batches × 500 emails)

### Webhook Flow
```bash
pnpm test:e2e src/__tests__/e2e/webhook-flow.test.ts
```
- Delivery notifications
- Bounce handling
- Complaint handling
- Webhook deduplication

## Debugging Tests

### Enable Worker Logs

```bash
DEBUG_WORKER=true pnpm test:e2e
```

### Check Infrastructure Health

```bash
# NATS
curl http://localhost:8222/healthz

# PostgreSQL
docker exec batchsender-test-postgres pg_isready -U test

# ClickHouse
curl http://localhost:8124/ping
```

### View Database State

```bash
# Connect to PostgreSQL
docker exec -it batchsender-test-postgres psql -U test -d batchsender_test

# Query batches
SELECT id, status, sent_count, total_recipients FROM batches;

# Query recipients
SELECT batch_id, status, count(*) FROM recipients GROUP BY batch_id, status;
```

### View ClickHouse Events

```bash
# Connect to ClickHouse
docker exec -it batchsender-test-clickhouse clickhouse-client \
  --user test --password test --database batchsender_test

# Query events
SELECT event_type, count() FROM email_events GROUP BY event_type;
```

## Performance Expectations

Based on test results, the system should achieve:

- **Throughput:** >50 emails/sec (with mock provider)
- **Latency:** <50ms per email (mock provider overhead)
- **Concurrent batches:** Handle 10+ batches simultaneously
- **Large batches:** Process 10k emails within 3-5 minutes

Note: Real provider (SES) will have different performance characteristics based on rate limits.

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: pnpm install

      - name: Start test infrastructure
        run: pnpm test:infra

      - name: Wait for services
        run: sleep 10

      - name: Run E2E tests
        run: pnpm test:e2e

      - name: Cleanup
        if: always()
        run: pnpm test:infra:down
```

## Troubleshooting

### Tests Timeout

- Check if all infrastructure services are running: `docker ps`
- Increase test timeout in `vitest.e2e.config.ts`
- Check worker logs: `DEBUG_WORKER=true pnpm test:e2e`

### Worker Fails to Start

- Check NATS connection: `curl http://localhost:8222/healthz`
- Check DATABASE_URL in `.env.test`
- Check port 3001 is available: `lsof -i :3001`

### NATS Connection Refused

```bash
# Restart NATS
docker-compose -f docker-compose.test.yml restart nats

# Check NATS logs
docker logs batchsender-test-nats
```

### Database Migration Issues

```bash
# Run migrations manually
cd ../../packages/db
pnpm db:push

# Or reset database
docker-compose -f docker-compose.test.yml down -v
docker-compose -f docker-compose.test.yml up -d
```

## Next Steps

1. **Run tests locally** to verify everything works
2. **Add to CI/CD pipeline** for automated testing
3. **Monitor test performance** over time
4. **Add more scenarios** as needed (rate limiting, batch pausing, etc.)
5. **Set up staging environment** for testing with real SES (low volume)

## Key Differences from Old Tests

### Before (BullMQ/Dragonfly)
- ❌ No queue integration tests
- ❌ Mocked database operations
- ❌ No end-to-end flow validation
- ❌ No autoscaling validation

### After (NATS)
- ✅ Real NATS queue in tests
- ✅ Full E2E flow via API
- ✅ Large batch performance tests
- ✅ Queue metrics for autoscaling
- ✅ Real worker process testing
- ✅ Concurrent batch validation

This test suite gives **high confidence** that your NATS-based system works correctly and is ready for production!
