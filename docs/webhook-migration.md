# Webhook Architecture Migration

## Overview

This document describes the migration of webhook handling from the web app to the worker service, fixing an architectural mistake where webhooks were incorrectly processed in the Next.js application.

## What Changed

### Before (Incorrect)
```
Provider Webhook → Web App (Next.js) → Synchronous DB Lookup → Response
                           ↓
                    queue-service.ts (NATS)
                    webhook-factory.ts
```

**Problems:**
- Webhook routes in wrong service (web app handles UI, not async processing)
- Synchronous ClickHouse lookups blocked webhook responses
- NATS dependencies added to web app (not installed)
- Slow response times (>100ms) due to blocking queries

### After (Correct)
```
Provider Webhook → Worker (Fastify) → Immediate Queue → Response (<100ms)
                                            ↓
                                   Async Processing (enrichment, DB updates)
```

**Benefits:**
- Proper separation of concerns
- True async processing with fast ACK
- All webhook infrastructure in one service
- Response time < 100ms (p99)

## Files Removed from Web App

```
apps/web/src/
├── app/api/webhooks/
│   ├── telnyx/route.ts
│   ├── telnyx-failover/route.ts
│   ├── resend/route.ts
│   ├── ses/route.ts
│   └── custom/[moduleId]/route.ts
└── lib/
    ├── queue-service.ts
    └── webhook-factory.ts
```

## Worker Webhook Routes

All webhooks are now handled in `/apps/worker/src/webhooks/routes.ts`:

| Endpoint | Provider | Description |
|----------|----------|-------------|
| `POST /webhooks/resend` | Resend | Email delivery webhooks |
| `POST /webhooks/ses` | AWS SES | Email delivery via SNS |
| `POST /webhooks/telnyx` | Telnyx | SMS delivery webhooks |
| `POST /webhooks/custom/:moduleId` | Custom | User-configured module webhooks |

## Processing Flow

1. **Webhook Received**: Worker validates signature (if configured)
2. **Immediate Queue**: Event enqueued to NATS (< 10ms)
3. **Fast Response**: Return `{ received: true }` to provider
4. **Async Enrichment**: Webhook worker looks up recipient info from ClickHouse
5. **Batch Processing**: Events batched and database updated efficiently

## Custom Module Webhooks

Custom modules can receive webhooks at:
```
POST /webhooks/custom/{moduleId}
```

**Configuration** (in sendConfig.config):
```json
{
  "webhookSecret": "your-secret-key",
  "signatureHeader": "x-webhook-signature"
}
```

**Event Type Mapping**:
- Events containing "delivered" → `delivered`
- Events containing "bounced" → `bounced`
- Events containing "failed" → `failed`
- Events containing "sent" → `sent`
- Events containing "opened" → `opened`
- Events containing "clicked" → `clicked`
- Unknown events → `custom.event`

## Configuration

### Worker Environment Variables
```env
# Webhook secrets (required in production)
WEBHOOK_SECRET=...              # Resend webhook secret
TELNYX_WEBHOOK_SECRET=...       # Telnyx webhook secret

# Processing configuration
WEBHOOK_BATCH_SIZE=100          # Events per batch
WEBHOOK_FLUSH_INTERVAL=1000     # Max wait before flush (ms)
```

### Web App
No webhook-related configuration needed. All webhook handling removed.

## Webhook URL Updates

Update provider webhook URLs from:
```
https://app.example.com/api/webhooks/{provider}
```

To:
```
https://worker.example.com/webhooks/{provider}
```

## Testing

Run webhook tests:
```bash
cd apps/worker
npm test -- --grep "webhook"
```

Key test files:
- `webhook-routes-async.test.ts` - Route tests without synchronous lookups
- `webhook-queue-flow.test.ts` - End-to-end queue processing
- `webhook-throughput.test.ts` - Performance tests
- `webhook-resilience.test.ts` - Failure handling

## Monitoring

### Metrics
- `webhooks_received_total` - Ingestion rate by provider
- `webhook_queue_depth` - Current buffer size
- `webhook_processing_duration` - Processing latency

### Alerts
- Queue depth > 10,000 (processing falling behind)
- Response time p99 > 100ms (performance degradation)
- Error rate > 1% (processing failures)

## Rollback

If issues occur:
1. Provider webhook URLs can be updated back to web app (if routes re-added)
2. NATS preserves unprocessed messages during downtime
3. Synchronous lookups can be temporarily re-enabled in worker routes
