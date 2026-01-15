# Architecture Design: Plugin System for Modular Platform

**Date:** 2026-01-13
**Status:** Design Phase
**Related:** Strategic Analysis (01-strategic-analysis-modular-platform.md)

## Current Architecture Assessment

### ✅ Strong Foundations (Keep These)
- **Queue System:** NATS JetStream - solid, scalable
- **Worker Isolation:** Per-user workers with rate limiting
- **Provider Pattern:** Email provider abstraction (Resend, Mock, SES)
- **Analytics:** ClickHouse event tracking
- **Infrastructure:** Kubernetes-ready, Docker-based deployment

### ❌ Email-Specific Blockers (Must Refactor)
- **Database Schema:** Email fields hardcoded (`fromEmail`, `subject`, `htmlContent`, `textContent`)
- **Job Types:** `EmailJobData` and `BatchJobData` are email-specific
- **Status Enums:** `delivered`, `bounced`, `complained` are email-only
- **Workers:** Template replacement and processing logic is email-specific
- **No Plugin System:** Can't add new job types without core changes

## Proposed Architecture

### Core Concept
```
User creates "Job"
  → Selects "Processor Module"
  → Defines "Payload"
  → System handles: queuing, rate limiting, retries, tracking, analytics
```

### Plugin System Interface

```typescript
// Core abstraction
interface JobProcessor<TPayload = any, TResult = any> {
  type: string; // "email", "sms", "webhook"

  // Validate job payload before enqueueing
  validate(payload: TPayload): Promise<ValidationResult>;

  // Process a single job
  process(job: Job<TPayload>): Promise<TResult>;

  // Optional: batch processing optimization
  processBatch?(jobs: Job<TPayload>[]): Promise<TResult[]>;

  // Rate limiting config
  getRateLimits(): RateLimitConfig;

  // Status mapping
  mapStatus(result: TResult): JobStatus;
}

// Plugin registry
class ProcessorRegistry {
  private processors = new Map<string, JobProcessor>();

  register(processor: JobProcessor): void {
    this.processors.set(processor.type, processor);
  }

  get(type: string): JobProcessor | undefined {
    return this.processors.get(type);
  }
}
```

### Job Structure Examples

#### Email Job (Current)
```typescript
{
  type: "email",
  payload: {
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Hello {{name}}",
    html: "<h1>Hi {{name}}</h1>",
    variables: { name: "John" }
  }
}
```

#### SMS Job
```typescript
{
  type: "sms",
  payload: {
    from: "+1234567890",
    to: "+9876543210",
    message: "Your code is {{code}}",
    provider: "twilio",
    variables: { code: "123456" }
  }
}
```

#### Webhook Job
```typescript
{
  type: "webhook",
  payload: {
    url: "https://api.customer.com/events",
    method: "POST",
    headers: { "Authorization": "Bearer {{token}}" },
    body: { event: "user.created", data: {...} },
    retries: 3,
    timeout: 5000
  }
}
```

## Database Schema Changes

```sql
-- Add to batches table
ALTER TABLE batches ADD COLUMN job_type VARCHAR(50) DEFAULT 'email';
ALTER TABLE batches ADD COLUMN payload JSONB;
ALTER TABLE batches ADD COLUMN processor_config JSONB;

-- Keep existing email fields for backward compatibility during transition
-- They'll be marked as deprecated and removed in v2.0

-- Add generic job_events table
CREATE TABLE job_events (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  user_id UUID NOT NULL,
  job_type VARCHAR(50) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_job_events_batch_id ON job_events(batch_id);
CREATE INDEX idx_job_events_type ON job_events(job_type, event_type);
```

## Worker System Updates

### Refactored Processing Flow

```typescript
async function processBatchJob(batchId: string, userId: string) {
  const batch = await db.query.batches.findFirst({
    where: eq(batches.id, batchId)
  });

  // Get processor for this job type
  const processor = processorRegistry.get(batch.jobType);
  if (!processor) {
    throw new Error(`No processor found for type: ${batch.jobType}`);
  }

  // Get pending recipients/jobs
  const pendingJobs = await getPendingJobs(batchId);

  // Enqueue to appropriate queue
  for (const job of pendingJobs) {
    await enqueueJob(job.id, userId, processor);
  }
}

async function processJob(jobId: string, processor: JobProcessor) {
  const job = await getJob(jobId);

  try {
    const result = await processor.process(job);
    const status = processor.mapStatus(result);

    await updateJobStatus(jobId, status, result);
    await logEvent({
      jobId,
      jobType: processor.type,
      eventType: status,
      metadata: result
    });
  } catch (error) {
    await updateJobStatus(jobId, "failed", { error: error.message });
  }
}
```

## File Structure

```
apps/worker/src/
├── plugins/
│   ├── types.ts                 # Core interfaces
│   ├── registry.ts              # Plugin registration
│   ├── email/
│   │   ├── processor.ts         # Email processor
│   │   └── providers/           # Resend, SES, etc.
│   ├── sms/
│   │   ├── processor.ts         # SMS processor
│   │   └── providers/           # Twilio, Vonage
│   ├── webhook/
│   │   └── processor.ts         # Webhook processor
│   └── crm/
│       ├── processor.ts         # CRM processor
│       └── providers/           # Salesforce, HubSpot
├── nats/
│   ├── workers.ts              # Generic job processing
│   ├── client.ts               # NATS client
│   └── queue-service.ts        # Queue operations
└── config.ts                   # Configuration
```

## Implementation Complexity

| Component | Complexity | Effort | Risk |
|-----------|-----------|--------|------|
| Schema redesign | HIGH | 3-4 weeks | HIGH - New tables, migration |
| Job processor abstraction | MEDIUM | 2 weeks | MEDIUM |
| Queue generalization | MEDIUM | 1-2 weeks | MEDIUM |
| Event system redesign | LOW | 1 week | LOW |
| **Total Estimated Effort** | | **8-12 weeks** | |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Schema migration breaks existing data** | HIGH | Incremental approach, keep old fields, thorough testing |
| **Plugin abstraction too rigid** | MEDIUM | Prototype webhook module first to validate |
| **Performance degradation** | MEDIUM | Benchmark before/after, optimize hot paths |
| **Module complexity explosion** | MEDIUM | Clear interfaces, good documentation |

## Next Steps

1. Choose implementation path (see roadmap document)
2. Design and validate plugin interfaces
3. Create migration strategy for existing email data
4. Set up testing framework for multi-module system
