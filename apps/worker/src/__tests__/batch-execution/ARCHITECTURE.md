# Batch Execution Architecture

## Overview

The Batchsender worker uses a **chunk-based batch execution model** that dramatically reduces API calls, NATS messages, and Dragonfly operations compared to processing recipients individually.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BATCH EXECUTION FLOW                                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────┐    ┌──────────────┐    ┌───────────┐    ┌──────────────┐
│  API     │───▶│ PostgreSQL   │───▶│  NATS     │───▶│  Worker      │
│ creates  │    │ stores batch │    │ sys.batch │    │ processes    │
│ batch    │    │ + recipients │    │ .process  │    │ batch        │
└──────────┘    └──────────────┘    └───────────┘    └──────┬───────┘
                                                            │
                                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        BATCH PROCESSOR                                       │
│                                                                              │
│  1. Load batch metadata from PostgreSQL                                      │
│  2. Get recipient IDs (not full data yet)                                   │
│  3. Determine chunk size from provider limits                                │
│  4. Split recipient IDs into chunks                                          │
│  5. Enqueue chunks to NATS                                                   │
│                                                                              │
│  Example: 1000 recipients → 20 chunks of 50 (for SES)                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ email.user.{userId}.chunk
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CHUNK PROCESSOR                                       │
│                                                                              │
│  1. Receive chunk (batchId, chunkIndex, recipientIds[], sendConfig)         │
│  2. Check idempotency (which recipients already processed?)                  │
│  3. Load recipient data from PostgreSQL (only unprocessed)                   │
│  4. Call module.executeBatch(payloads, sendConfig)                          │
│  5. Record results atomically to Dragonfly                                   │
│  6. Update counters in PostgreSQL                                            │
│  7. ACK message                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MODULE EXECUTION                                      │
│                                                                              │
│  EmailModule:   resend.batch.send([...50 emails...])  → 1 API call          │
│  WebhookModule: POST /webhook { recipients: [...50...] } → 1 API call       │
│  SmsModule:     50 parallel Telnyx calls (no batch API) → 50 API calls      │
│                                                                              │
│  Returns: BatchJobResult[] with success/failure per recipient               │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Concepts

### 1. Chunk vs Individual Message

**Old Model (Individual):**
```
1M recipients → 1M NATS messages → 1M API calls → 1M Dragonfly writes
```

**New Model (Chunked):**
```
1M recipients → 20K chunks → 20K NATS messages → 20K API calls → 20K Dragonfly writes
```

**Reduction: 50x fewer operations** (assuming 50 recipients per chunk)

### 2. ChunkJobData Structure

```typescript
interface ChunkJobData {
  batchId: string;           // Which batch this belongs to
  userId: string;            // Owner of the batch
  chunkIndex: number;        // 0, 1, 2... for deduplication
  recipientIds: string[];    // Array of recipient IDs in this chunk
  sendConfig: {              // Embedded config (no DB lookup needed)
    id: string;
    module: "email" | "sms" | "webhook" | "push";
    config: {...};           // Provider-specific config
    rateLimit?: {
      requestsPerSecond: number;    // API calls per second
      recipientsPerRequest: number; // Batch size
    };
  };
  dryRun?: boolean;          // Skip actual sends
}
```

### 3. Provider Limits

Each provider has different batch capabilities:

| Provider | Max Batch Size | Max Requests/Sec | Throughput/Sec |
|----------|---------------|------------------|----------------|
| SES      | 50            | 14               | 700            |
| Resend   | 100           | 100              | 10,000         |
| Telnyx   | 1 (no batch)  | 50               | 50             |
| Webhook  | 100           | 100              | 10,000         |

### 4. Rate Limiting

Rate limits apply **per API request**, not per recipient:

```typescript
// Old model: 1000 recipients/sec
// Sending 1 at a time = 1000 requests/sec

// New model: 20 requests/sec, 50 per request
// Effective throughput = 1000 recipients/sec
// But only 20 API calls, 20 rate limit tokens consumed
```

**First-come-first-served**: One batch can use the full rate limit. If multiple batches are processing, they compete for tokens.

## Data Flow

### Step 1: API Creates Batch

```
POST /api/batches
{
  "name": "Marketing Campaign",
  "sendConfigId": "config-123",
  "recipients": [
    { "email": "user1@example.com", "name": "User 1", "variables": {...} },
    { "email": "user2@example.com", "name": "User 2", "variables": {...} },
    ...1M more...
  ]
}
```

Recipients stored in PostgreSQL. Batch enqueued to NATS `sys.batch.process`.

### Step 2: Batch Processor

```typescript
// Worker receives batch message
const { batchId, userId } = message;

// Load batch + send config
const batch = await db.batches.findOne(batchId);
const sendConfig = await db.sendConfigs.findOne(batch.sendConfigId);

// Get pending recipient IDs only (not full data)
const recipientIds = await db.recipients
  .select(['id'])
  .where({ batchId, status: 'pending' });

// Determine chunk size
const provider = sendConfig.config.provider; // "ses", "resend", etc.
const chunkSize = sendConfig.rateLimit?.recipientsPerRequest
  || PROVIDER_LIMITS[provider].maxBatchSize;

// Split into chunks
const chunks: ChunkJobData[] = [];
for (let i = 0; i < recipientIds.length; i += chunkSize) {
  chunks.push({
    batchId,
    userId,
    chunkIndex: Math.floor(i / chunkSize),
    recipientIds: recipientIds.slice(i, i + chunkSize),
    sendConfig: {
      id: sendConfig.id,
      module: sendConfig.module,
      config: sendConfig.config,
      rateLimit: sendConfig.rateLimit,
    },
  });
}

// Enqueue all chunks
await queueService.enqueueRecipientChunks(chunks);
```

### Step 3: Chunk Processor

```typescript
// Worker receives chunk message
const chunk: ChunkJobData = message;

// Idempotency check - which recipients already processed?
const existingStates = await hotState.checkRecipientsProcessedBatch(
  chunk.batchId,
  chunk.recipientIds
);

// Filter to only unprocessed
const toProcess = chunk.recipientIds.filter(id => !existingStates.get(id));

if (toProcess.length === 0) {
  message.ack(); // Already done
  return;
}

// Load full recipient data for unprocessed only
const recipients = await db.recipients
  .select()
  .whereIn('id', toProcess);

// Build batch payloads
const payloads: BatchJobPayload[] = recipients.map(r => ({
  recipientId: r.id,
  payload: {
    to: r.identifier || r.email,
    name: r.name,
    fromEmail: batch.payload?.fromEmail,
    subject: batch.payload?.subject,
    htmlContent: batch.payload?.htmlContent,
    variables: r.variables,
  },
}));

// Acquire rate limit (1 token for entire batch request)
const rateLimitResult = await acquireRateLimit(chunk.sendConfig, chunk.userId);
if (!rateLimitResult.allowed) {
  message.nak(1000); // Retry in 1 second
  return;
}

// Execute batch via module
const module = getModule(chunk.sendConfig.module);
const results = await module.executeBatch(payloads, chunk.sendConfig);

// Record results atomically to Dragonfly
const counters = await hotState.recordResultsBatch(chunk.batchId, results);

// Update PostgreSQL counters
await db.batches.update(chunk.batchId, {
  sentCount: counters.sent,
  failedCount: counters.failed,
});

message.ack();
```

### Step 4: Module Execution

#### EmailModule (Resend)

```typescript
async executeBatch(payloads: BatchJobPayload[], sendConfig: SendConfig) {
  const resend = new Resend(apiKey);

  // Build batch request
  const emails = payloads.map(p => ({
    from: p.payload.fromEmail,
    to: p.payload.to,
    subject: p.payload.subject,
    html: p.payload.htmlContent,
  }));

  // Single API call for all recipients
  const result = await resend.batch.send(emails);

  // Map results back to recipients
  return payloads.map((p, i) => ({
    recipientId: p.recipientId,
    result: {
      success: !!result.data?.[i]?.id,
      providerMessageId: result.data?.[i]?.id,
      error: result.error?.message,
    },
  }));
}
```

#### WebhookModule

```typescript
async executeBatch(payloads: BatchJobPayload[], sendConfig: SendConfig) {
  const { url, method, headers } = sendConfig.config;

  // Single HTTP request with all recipients
  const response = await fetch(url, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipients: payloads.map(p => ({
        recipientId: p.recipientId,
        ...p.payload,
      })),
    }),
  });

  const data = await response.json();

  // Map per-recipient results if provided
  if (data.results) {
    return data.results.map(r => ({
      recipientId: r.recipientId,
      result: { success: r.success, error: r.error },
    }));
  }

  // Otherwise, all succeed or all fail
  return payloads.map(p => ({
    recipientId: p.recipientId,
    result: { success: response.ok },
  }));
}
```

#### SmsModule (Telnyx - No Batch API)

```typescript
async executeBatch(payloads: BatchJobPayload[], sendConfig: SendConfig) {
  const maxParallel = 10; // Concurrency control

  // Process in parallel with controlled concurrency
  const results: BatchJobResult[] = [];

  for (let i = 0; i < payloads.length; i += maxParallel) {
    const batch = payloads.slice(i, i + maxParallel);
    const batchResults = await Promise.all(
      batch.map(async (p) => {
        try {
          const response = await this.sendViaTelnyx(p.payload, sendConfig);
          return {
            recipientId: p.recipientId,
            result: { success: true, providerMessageId: response.id },
          };
        } catch (error) {
          return {
            recipientId: p.recipientId,
            result: { success: false, error: error.message },
          };
        }
      })
    );
    results.push(...batchResults);
  }

  return results;
}
```

## State Management

### HotStateManager (Dragonfly)

Tracks recipient states in Redis/Dragonfly for fast idempotency checks:

```
batch:{batchId}:recipients (HASH)
  r1 → "s:1705924800000:msg-abc123"  (sent)
  r2 → "f:Invalid email"              (failed)
  r3 → "p"                            (pending)
```

**Batch operations:**
- `HMGET batch:{batchId}:recipients r1 r2 r3 ...` - Check multiple recipients
- `HMSET batch:{batchId}:recipients r1 "s:..." r2 "f:..." ...` - Update multiple recipients

### PostgreSQL

Stores permanent state:
- `batches` - Batch metadata, counters
- `recipients` - Recipient data, final status
- `send_configs` - User's send configurations

## NATS Subjects

```
email-system (stream)
├── sys.batch.process          # Batch processing triggers
├── email.user.{userId}.chunk  # Chunk messages per user
├── email.user.{userId}.send   # Legacy individual messages
└── email.priority.send        # High-priority sends

webhooks (stream)
└── webhook.{provider}.{event} # Webhook event processing
```

## Throughput Scenarios

### 1M Email Campaign via SES

```
Recipients:    1,000,000
Chunk size:    50 (SES limit)
Requests/sec:  14 (SES limit)

Chunks:        20,000 (1M / 50)
NATS messages: 20,000 (vs 1M individual)
API calls:     20,000 (vs 1M individual)
Dragonfly ops: 20,000 (vs 1M individual)

Throughput:    700 recipients/sec (14 × 50)
Duration:      ~24 minutes
```

### 1M Email Campaign via Resend

```
Recipients:    1,000,000
Chunk size:    100 (Resend limit)
Requests/sec:  100 (Resend limit)

Chunks:        10,000
Throughput:    10,000 recipients/sec
Duration:      ~100 seconds (1.7 minutes)
```

### 10K SMS via Telnyx

```
Recipients:    10,000
Chunk size:    1 (no batch API)
Requests/sec:  50 (Telnyx limit)

Chunks:        10,000
Throughput:    50 SMS/sec
Duration:      ~200 seconds (3.3 minutes)
```

## Error Handling

### Partial Batch Failure

If some recipients in a batch fail:
1. Successful recipients marked as `sent` in Dragonfly
2. Failed recipients marked as `failed` with error message
3. Counters updated atomically
4. Message ACKed (chunk considered complete)

### Provider API Down

If entire batch API call fails:
1. All recipients in chunk marked as `failed`
2. Message NACKed for retry (up to max_deliver)
3. After max retries, moved to dead letter

### Idempotency

If chunk is reprocessed (NATS redelivery):
1. Check Dragonfly for already-processed recipients
2. Skip already-processed, only process pending
3. No duplicate sends

## Configuration

### User-Configurable Rate Limits

```typescript
sendConfig.rateLimit = {
  requestsPerSecond: 20,     // Max API calls per second
  recipientsPerRequest: 50,  // Batch size
  dailyLimit: 100000,        // Total daily limit
};
```

### Provider Defaults

```typescript
PROVIDER_LIMITS = {
  ses:     { maxBatchSize: 50,  maxRequestsPerSecond: 14  },
  resend:  { maxBatchSize: 100, maxRequestsPerSecond: 100 },
  telnyx:  { maxBatchSize: 1,   maxRequestsPerSecond: 50  },
  webhook: { maxBatchSize: 100, maxRequestsPerSecond: 100 },
  mock:    { maxBatchSize: 100, maxRequestsPerSecond: 10000 },
};
```

## Testing

Run the batch execution tests:

```bash
cd apps/worker
pnpm test src/__tests__/batch-execution/
```

Test files:
- `module-batch-execution.test.ts` - Module executeBatch() tests
- `chunk-processing.test.ts` - Chunking logic tests
- `rate-limiting.test.ts` - Rate limit model tests
- `integration-batch-flow.test.ts` - Full flow integration tests
