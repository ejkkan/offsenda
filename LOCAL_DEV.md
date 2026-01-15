# Local Development Setup

This guide covers running the full BatchSender stack locally with NATS and ClickHouse.

## Architecture (Local)

```
┌─────────────────────────────────────────────────────────────────┐
│                        LOCAL MACHINE                             │
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐    │
│  │   Web App      │  │    Worker      │  │   Neon DB      │    │
│  │  (Next.js)     │  │   (Fastify)    │  │   (Remote)     │    │
│  │  localhost:3000│  │  localhost:3001│  │   Frankfurt    │    │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘    │
│          │                   │                   │              │
│          └───────────────────┼───────────────────┘              │
│                              │                                  │
│  ┌───────────────────────────┼───────────────────────────────┐  │
│  │                    Docker Compose                          │  │
│  │  ┌────────────────┐  ┌────────────────┐                   │  │
│  │  │     NATS       │  │   ClickHouse   │                   │  │
│  │  │  (JetStream)   │  │   (Analytics)  │                   │  │
│  │  │  localhost:4222│  │  localhost:8123│                   │  │
│  │  └────────────────┘  └────────────────┘                   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js 20+
- pnpm 9+
- Docker & Docker Compose
- A Neon database (free tier works)
- A Resend API key (free tier: 3000 emails/month)

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Set up environment

```bash
cp .env.example .env
```

Edit `.env` with your values:
- `DATABASE_URL` - Your Neon connection string
- `RESEND_API_KEY` - Your Resend API key
- `NEXTAUTH_SECRET` - Generate with `openssl rand -base64 32`
- `WEBHOOK_SECRET` - Generate with `openssl rand -base64 32`

### 3. Push database schema

```bash
pnpm db:push
```

### 4. Start infrastructure (NATS + ClickHouse)

```bash
pnpm dev:infra
```

Or manually:
```bash
docker compose -f docker-compose.local.yml up -d nats clickhouse
```

### 5. Start services

In separate terminals:

```bash
# Terminal 1: Web app
pnpm dev:web

# Terminal 2: Worker
pnpm dev:worker
```

Or start everything at once:
```bash
pnpm dev
```

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Web App | http://localhost:3000 | User interface |
| Worker API | http://localhost:3001 | Batch sending API |
| NATS | localhost:4222 | JetStream message queue |
| NATS Monitor | http://localhost:8222 | NATS monitoring interface |
| ClickHouse | http://localhost:8123 | Analytics database |

## Worker API Endpoints

All API endpoints require authentication via `Authorization: Bearer <api_key>` header.

### Batches

```bash
# Create a batch
curl -X POST http://localhost:3001/api/batches \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Batch",
    "subject": "Hello {{name}}!",
    "fromEmail": "test@yourdomain.com",
    "fromName": "Test",
    "htmlContent": "<h1>Hello {{name}}!</h1>",
    "recipients": [
      {"email": "user1@example.com", "name": "User One"},
      {"email": "user2@example.com", "name": "User Two"}
    ]
  }'

# List batches
curl http://localhost:3001/api/batches \
  -H "Authorization: Bearer YOUR_API_KEY"

# Get batch details
curl http://localhost:3001/api/batches/{batch_id} \
  -H "Authorization: Bearer YOUR_API_KEY"

# Start sending
curl -X POST http://localhost:3001/api/batches/{batch_id}/send \
  -H "Authorization: Bearer YOUR_API_KEY"

# Pause sending
curl -X POST http://localhost:3001/api/batches/{batch_id}/pause \
  -H "Authorization: Bearer YOUR_API_KEY"

# Resume sending
curl -X POST http://localhost:3001/api/batches/{batch_id}/resume \
  -H "Authorization: Bearer YOUR_API_KEY"

# Get recipients
curl "http://localhost:3001/api/batches/{batch_id}/recipients?status=sent&limit=100" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Analytics

```bash
# User analytics (last 30 days)
curl "http://localhost:3001/api/analytics?days=30" \
  -H "Authorization: Bearer YOUR_API_KEY"

# Queue status
curl http://localhost:3001/api/queue/status \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Health & Webhooks

```bash
# Health check (no auth required)
curl http://localhost:3001/health

# Resend webhook (for testing)
curl -X POST http://localhost:3001/webhooks/resend \
  -H "Content-Type: application/json" \
  -d '{
    "type": "email.delivered",
    "data": {"email_id": "test-id", "to": ["user@example.com"]}
  }'
```

## Creating an API Key

Currently, API keys must be created manually in the database:

```sql
-- Generate a key: openssl rand -hex 32
-- Hash it: echo -n "YOUR_KEY" | sha256sum

INSERT INTO api_keys (user_id, name, key_hash, key_prefix)
VALUES (
  'YOUR_USER_ID',
  'My API Key',
  'SHA256_HASH_OF_KEY',
  'first_8_chars'
);
```

Or add this endpoint to the web app to create keys via UI.

## Testing Webhooks

For local webhook testing, use ngrok:

```bash
ngrok http 3001
```

Then configure the ngrok URL in Resend's webhook settings.

## Viewing ClickHouse Data

```bash
# Connect to ClickHouse
docker compose -f docker-compose.local.yml exec clickhouse clickhouse-client

# Query email events
SELECT * FROM batchsender.email_events ORDER BY created_at DESC LIMIT 10;

# Batch stats
SELECT * FROM batchsender.batch_stats_mv WHERE batch_id = 'YOUR_BATCH_ID';
```

## NATS Monitoring

```bash
# View NATS stats via HTTP
curl http://localhost:8222/jsz

# Check stream info
curl http://localhost:8222/jsz | jq '.streams[] | select(.name=="email-system")'

# Monitor consumer activity
curl http://localhost:8222/jsz | jq '.streams[0].consumer_detail'
```

## Running Load Tests

```bash
# Run NATS load test
pnpm --filter=worker load-test

# This will:
# - Queue 50 users × 30,000 emails each
# - Monitor processing rates
# - Report statistics every 5 seconds
```

## Stopping Infrastructure

```bash
docker compose -f docker-compose.local.yml down
```

## Troubleshooting

### Worker won't connect to NATS
```bash
# Check if NATS is running
docker compose -f docker-compose.local.yml ps

# View logs
docker compose -f docker-compose.local.yml logs nats

# Test NATS connection
curl http://localhost:8222/healthz
```

### ClickHouse schema not initialized
```bash
# Reinitialize
docker compose -f docker-compose.local.yml down -v
docker compose -f docker-compose.local.yml up -d clickhouse
```

### Database connection issues
Make sure your Neon database is awake (free tier pauses after inactivity).

### NATS JetStream not enabled
```bash
# Check if JetStream is enabled
curl http://localhost:8222/jsz

# Should see JetStream configuration
# If not, check docker-compose.local.yml has --jetstream flag
```