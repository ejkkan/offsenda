# BatchSender Architecture

## Overview

BatchSender is a high-throughput message delivery platform split into two deployment zones:
- **External (Edge)**: User-facing web app on Cloudflare/Vercel
- **Internal (Hetzner K8s)**: Processing workers with minimal external exposure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL ZONE                                   │
│                         (Cloudflare / Vercel)                               │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                        Next.js Web App                               │   │
│   │                                                                      │   │
│   │   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │   │
│   │   │    Auth      │  │  Dashboard   │  │      API Routes          │  │   │
│   │   │  (NextAuth)  │  │     UI       │  │                          │  │   │
│   │   │              │  │              │  │  POST /api/batches       │  │   │
│   │   │  - Login     │  │  - Batches   │  │  POST /api/recipients    │  │   │
│   │   │  - Register  │  │  - Analytics │  │  POST /api/send-configs  │  │   │
│   │   │  - API Keys  │  │  - Configs   │  │  GET  /api/batches/:id   │  │   │
│   │   └──────────────┘  └──────────────┘  └──────────────────────────┘  │   │
│   │                                                                      │   │
│   └──────────────────────────────────┬──────────────────────────────────┘   │
│                                      │                                       │
└──────────────────────────────────────┼───────────────────────────────────────┘
                                       │
                                       ▼
                        ┌──────────────────────────┐
                        │   PostgreSQL (Neon)      │
                        │                          │
                        │  - users                 │
                        │  - batches               │
                        │  - recipients            │
                        │  - send_configs          │
                        │  - api_keys              │
                        └──────────────────────────┘
                                       ▲
                                       │
┌──────────────────────────────────────┼───────────────────────────────────────┐
│                                      │                                       │
│                           INTERNAL ZONE                                      │
│                    (Hetzner Kubernetes Cluster)                             │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                    EXPOSED: Webhook Receiver                           │ │
│  │                         (K8s Ingress)                                  │ │
│  │                                                                        │ │
│  │   POST /webhooks/resend  <── Resend (email delivery events)           │ │
│  │   POST /webhooks/ses     <── AWS SES/SNS (email events)               │ │
│  │   POST /webhooks/telnyx  <── Telnyx (SMS events)                      │ │
│  │   POST /webhooks/custom  <── Custom integrations                      │ │
│  │                                                                        │ │
│  │   - Signature verification (svix, SNS, ed25519)                       │ │
│  │   - Immediate 200 response                                            │ │
│  │   - Enqueue to NATS for async processing                              │ │
│  │                                                                        │ │
│  │   GET /metrics           <── Prometheus/KEDA (internal only)          │ │
│  │   GET /health            <── K8s probes (internal only)               │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                       │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         NATS JetStream                                 │ │
│  │                      (3-node HA cluster)                               │ │
│  │                                                                        │ │
│  │   Stream: email-system                                                 │ │
│  │   ├── sys.batch.process         (batch jobs)                          │ │
│  │   ├── sys.email.priority        (priority emails)                     │ │
│  │   └── email.user.{userId}.send  (per-user email jobs)                 │ │
│  │                                                                        │ │
│  │   Stream: webhooks                                                     │ │
│  │   └── webhook.{provider}.{event} (delivery events)                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                       │
│         ┌────────────────────────────┼────────────────────────────┐         │
│         │                            │                            │         │
│         ▼                            ▼                            ▼         │
│  ┌──────────────┐           ┌──────────────┐           ┌──────────────┐    │
│  │    Batch     │           │    Sender    │           │   Webhook    │    │
│  │  Discoverer  │           │   Workers    │           │  Processor   │    │
│  │              │           │              │           │              │    │
│  │ (leader only)│           │  (N replicas)│           │ (N replicas) │    │
│  └──────────────┘           └──────────────┘           └──────────────┘    │
│         │                            │                            │         │
│         │                            │                            │         │
│         ▼                            ▼                            ▼         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                          Dragonfly                                     │ │
│  │                    (Redis-compatible, HA)                              │ │
│  │                                                                        │ │
│  │   - Leader election (SET NX EX)                                       │ │
│  │   - Rate limiting (token bucket)                                      │ │
│  │   - Idempotency checks                                                │ │
│  │   - Batch completion counters                                         │ │
│  │   - Hot state cache                                                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                      │                                       │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         ClickHouse                                     │ │
│  │                    (Analytics database)                                │ │
│  │                                                                        │ │
│  │   - email_events (sent, delivered, bounced, etc.)                     │ │
│  │   - email_message_index (provider message ID -> batch/recipient)      │ │
│  │   - audit_logs                                                        │ │
│  │   - Cold storage: Backblaze B2                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Service Breakdown

### 1. Next.js Web App (External)

**Deployment**: Cloudflare Pages / Vercel
**Purpose**: User-facing dashboard and API

```
Responsibilities:
├── Authentication (NextAuth)
│   ├── Email/password login
│   ├── OAuth providers
│   └── API key management
│
├── Batch Management
│   ├── Create batches
│   ├── Add recipients (chunked upload)
│   ├── Set batch status -> 'queued'
│   └── View batch progress
│
├── Send Configuration
│   ├── Create email/SMS/webhook configs
│   ├── Configure providers (Resend, SES, Telnyx)
│   └── BYOK (Bring Your Own Key) setup
│
└── Analytics Dashboard
    ├── Delivery rates
    ├── Bounce/complaint rates
    └── Historical trends

Database Access: Direct PostgreSQL (Neon)
External APIs: None (writes to DB only)
```

### 2. Webhook Receiver (Hetzner - Exposed)

**Deployment**: K8s Deployment + Ingress
**Purpose**: Receive provider webhooks with low latency

```
Responsibilities:
├── Receive webhooks from providers
│   ├── Resend (Svix signature)
│   ├── AWS SES/SNS (SNS signature)
│   ├── Telnyx (ed25519 signature)
│   └── Custom webhooks (HMAC)
│
├── Verify signatures
├── Return 200 immediately
└── Enqueue to NATS (webhook.{provider}.{event})

Exposed Endpoints:
├── POST /webhooks/resend
├── POST /webhooks/ses
├── POST /webhooks/telnyx
├── POST /webhooks/custom/:moduleId
├── GET  /metrics          (internal - Prometheus)
└── GET  /health           (internal - K8s probes)

Dependencies: NATS (publish only)
Replicas: 2-3 (HPA based on CPU)
```

### 3. Batch Discoverer (Hetzner - Internal)

**Deployment**: Part of leader worker or separate
**Purpose**: Poll DB for new batches, publish to NATS

```
Responsibilities:
├── Leader election (Dragonfly)
├── Poll PostgreSQL every 2-5 seconds
│   └── SELECT * FROM batches WHERE status = 'queued'
├── Publish to NATS (sys.batch.process)
├── Update batch status -> 'processing'
└── Handle scheduled batches (scheduledAt <= now)

Dependencies: PostgreSQL (read), NATS (publish), Dragonfly (leader election)
Replicas: N (but only leader is active)
```

### 4. Batch Processor (Hetzner - Internal)

**Deployment**: K8s Deployment
**Purpose**: Expand batches into individual jobs

```
Responsibilities:
├── Consume from NATS (sys.batch.process)
├── Load batch from PostgreSQL
├── Page through recipients (1000 at a time)
├── Initialize hot state in Dragonfly
├── Publish individual jobs to NATS
│   └── email.user.{userId}.send
└── Log 'queued' events to ClickHouse

Dependencies: PostgreSQL (read), NATS (consume/publish), Dragonfly, ClickHouse
Replicas: 1-2 (limited by CONCURRENT_BATCHES)
```

### 5. Sender Workers (Hetzner - Internal)

**Deployment**: K8s Deployment + KEDA autoscaling
**Purpose**: Send emails/SMS via providers

```
Responsibilities:
├── Consume from NATS
│   ├── email.user.{userId}.send
│   └── sys.email.priority
│
├── Idempotency check (Dragonfly)
├── Rate limiting (Dragonfly)
│   ├── System-wide limit
│   ├── Per-provider limit (managed mode)
│   └── Per-config limit (BYOK mode)
│
├── Execute send via provider
│   ├── Resend API
│   ├── AWS SES API
│   ├── Telnyx API (SMS)
│   └── Custom webhooks
│
├── Record result (Dragonfly counters)
├── Log event to ClickHouse
└── Check batch completion

Dependencies: NATS, Dragonfly, ClickHouse, Provider APIs
Replicas: 2-50 (KEDA scales based on queue depth)
```

### 6. Webhook Processor (Hetzner - Internal)

**Deployment**: K8s Deployment
**Purpose**: Process delivery events, update statuses

```
Responsibilities:
├── Consume from NATS (webhook.>)
├── Batch events (for efficiency)
├── Enrich events
│   └── Lookup batch/recipient by provider message ID
├── Deduplicate (Dragonfly TTL)
├── Update recipient status in PostgreSQL
├── Update batch counters
└── Log events to ClickHouse

Dependencies: PostgreSQL (read/write), NATS, Dragonfly, ClickHouse
Replicas: 1-5 (scales with webhook volume)
```

### 7. Background Services (Hetzner - Leader Only)

**Deployment**: Part of worker deployment
**Purpose**: Singleton coordination tasks

```
Services:
├── PostgreSQL Sync Service
│   ├── Runs every 2 seconds
│   └── Syncs Dragonfly hot state -> PostgreSQL
│
├── Batch Recovery Service
│   ├── Runs every 5 minutes
│   └── Recovers stuck batches
│
└── Audit Service
    └── Buffered logging to ClickHouse

Dependencies: PostgreSQL, Dragonfly, ClickHouse
Leader Election: Dragonfly (SET NX EX pattern)
```

---

## Data Flow

### Flow 1: Create and Send Batch

```
1. User creates batch via dashboard
   Browser -> Next.js -> PostgreSQL

2. User adds recipients
   Browser -> Next.js -> PostgreSQL (chunked)

3. User clicks "Send"
   Browser -> Next.js -> PostgreSQL (status='queued')

4. Batch Discoverer finds batch
   Discoverer -> PostgreSQL poll -> NATS publish

5. Batch Processor expands batch
   NATS -> Processor -> PostgreSQL read -> NATS publish (per recipient)

6. Sender sends email
   NATS -> Sender -> Dragonfly (idempotency) -> Provider API -> Dragonfly (counter)

7. Provider confirms delivery
   Provider -> Webhook Receiver -> NATS -> Webhook Processor -> PostgreSQL
```

### Flow 2: Webhook Processing

```
1. Provider sends webhook
   Resend/SES/Telnyx -> POST /webhooks/{provider}

2. Webhook Receiver validates
   Verify signature -> Return 200 -> Publish to NATS

3. Webhook Processor enriches
   NATS consume -> ClickHouse lookup -> Batch events

4. Update recipient status
   PostgreSQL UPDATE -> ClickHouse log
```

---

## Kubernetes Resources

### Namespace: batchsender

```yaml
Deployments:
├── webhook-receiver     (2 replicas, HPA)
├── batch-processor      (1-2 replicas)
├── sender-worker        (2-50 replicas, KEDA)
├── webhook-processor    (1-5 replicas)
└── leader-worker        (N replicas, 1 active leader)

StatefulSets:
├── nats                 (3 replicas)
├── dragonfly            (1 replica, persistence)
└── clickhouse           (1 replica, persistence)

Services:
├── webhook-receiver     (ClusterIP + Ingress)
├── nats                 (Headless for clustering)
├── dragonfly            (ClusterIP)
└── clickhouse           (ClusterIP)

Ingress:
└── webhooks.batchsender.com
    └── /webhooks/* -> webhook-receiver:6001

ConfigMaps:
├── nats-config
├── clickhouse-config
└── worker-config

Secrets (Sealed):
├── database-url
├── provider-api-keys
├── webhook-signing-keys
└── nats-credentials

PodDisruptionBudgets:
├── nats-pdb             (minAvailable: 2)
├── webhook-receiver-pdb (minAvailable: 1)
└── sender-worker-pdb    (minAvailable: 1)

ScaledObjects (KEDA):
└── sender-worker-scaler
    ├── minReplicas: 2
    ├── maxReplicas: 50
    └── trigger: NATS queue depth
```

---

## Multi-Region Setup

```
┌─────────────────────────────────────┐     ┌─────────────────────────────────────┐
│      REGION: EU (Falkenstein)       │     │      REGION: US (Ashburn)           │
│            PRIMARY                  │     │           SECONDARY                 │
│                                     │     │                                     │
│  ┌─────────────────────────────┐   │     │   ┌─────────────────────────────┐   │
│  │     Webhook Receiver        │<──┼──┐  │   │     Webhook Receiver        │   │
│  └─────────────────────────────┘   │  │  │   └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │  │  │   ┌─────────────────────────────┐   │
│  │     Sender Workers          │   │  │  │   │     Sender Workers          │   │
│  └─────────────────────────────┘   │  │  │   └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │  │  │   ┌─────────────────────────────┐   │
│  │     NATS Cluster            │<──┼──┼──┼──>│     NATS Cluster            │   │
│  └─────────────────────────────┘   │  │  │   └─────────────────────────────┘   │
│  ┌─────────────────────────────┐   │  │  │   ┌─────────────────────────────┐   │
│  │     Dragonfly               │   │  │  │   │     Dragonfly               │   │
│  └─────────────────────────────┘   │  │  │   └─────────────────────────────┘   │
│                                     │  │  │                                     │
└─────────────────────────────────────┘  │  └─────────────────────────────────────┘
                                         │
                              DNS Failover / GeoDNS
                              webhooks.batchsender.com
```

**Cross-Region Communication**:
- NATS Gateway for cluster federation
- Each region has independent Dragonfly (no cross-region state)
- PostgreSQL (Neon) accessed from both regions
- ClickHouse replicated or region-local

---

## Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Web App | Next.js 14 | Dashboard, Auth, API |
| Web Hosting | Cloudflare Pages / Vercel | Edge deployment |
| Database | PostgreSQL (Neon) | Transactional data |
| Message Queue | NATS JetStream | Job distribution |
| Cache/State | Dragonfly | Rate limiting, counters |
| Analytics | ClickHouse | Event logging, metrics |
| Cold Storage | Backblaze B2 | ClickHouse archives |
| Container Runtime | Kubernetes | Orchestration |
| Autoscaling | KEDA | Queue-based scaling |
| Secrets | Sealed Secrets | GitOps-safe secrets |
| CI/CD | GitHub Actions + ArgoCD | Build & deploy |
| Monitoring | Prometheus + Grafana | Metrics & alerts |

---

## Environment Variables

### Next.js Web App
```bash
DATABASE_URL=             # Neon PostgreSQL connection string
NEXTAUTH_SECRET=          # NextAuth encryption key
NEXTAUTH_URL=             # Public URL for auth callbacks
```

### Webhook Receiver
```bash
NATS_URL=                 # NATS server URL
RESEND_WEBHOOK_SECRET=    # Svix signing secret
SES_WEBHOOK_SECRET=       # SNS verification (optional)
TELNYX_PUBLIC_KEY=        # ed25519 public key
```

### Workers
```bash
DATABASE_URL=             # PostgreSQL connection string
NATS_URL=                 # NATS server URL
DRAGONFLY_URL=            # Dragonfly/Redis URL
CLICKHOUSE_URL=           # ClickHouse URL

# Provider APIs
RESEND_API_KEY=           # Resend API key (managed mode)
AWS_ACCESS_KEY_ID=        # SES credentials
AWS_SECRET_ACCESS_KEY=
TELNYX_API_KEY=           # Telnyx API key

# Scaling
MAX_CONCURRENT_EMAILS=100 # Per worker instance
CONCURRENT_BATCHES=2      # Parallel batch processing
```

---

## Security Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│  INTERNET                                                       │
│                                                                 │
│  ┌─────────────────┐         ┌─────────────────┐               │
│  │  Users          │         │  Providers      │               │
│  │  (browsers)     │         │  (webhooks)     │               │
│  └────────┬────────┘         └────────┬────────┘               │
└───────────┼────────────────────────────┼────────────────────────┘
            │                            │
            ▼                            ▼
┌───────────────────────┐    ┌───────────────────────┐
│  Cloudflare WAF       │    │  K8s Ingress          │
│  + Rate Limiting      │    │  + Signature Verify   │
└───────────┬───────────┘    └───────────┬───────────┘
            │                            │
            ▼                            ▼
┌───────────────────────┐    ┌───────────────────────┐
│  Next.js              │    │  Webhook Receiver     │
│  (session auth)       │    │  (signature auth)     │
└───────────┬───────────┘    └───────────┬───────────┘
            │                            │
            └──────────────┬─────────────┘
                           │
            ┌──────────────▼──────────────┐
            │  INTERNAL NETWORK           │
            │  (no external access)       │
            │                             │
            │  - Workers                  │
            │  - NATS                     │
            │  - Dragonfly                │
            │  - ClickHouse               │
            └─────────────────────────────┘
```

---

## Scaling Characteristics

| Component | Min | Max | Trigger |
|-----------|-----|-----|---------|
| Webhook Receiver | 2 | 10 | CPU > 70% |
| Batch Processor | 1 | 2 | Manual |
| Sender Workers | 2 | 50 | NATS queue depth > 1000 |
| Webhook Processor | 1 | 5 | NATS queue depth > 500 |

---

## Failure Modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| Webhook Receiver down | Providers retry (exponential backoff) | K8s restarts pod |
| Sender Workers down | Jobs queue in NATS | KEDA scales up new pods |
| NATS down | All processing stops | StatefulSet recovers, jobs persisted |
| Dragonfly down | Rate limiting disabled, idempotency fails | Fallback to PostgreSQL |
| PostgreSQL down | No new batches, status updates fail | Wait for Neon recovery |
| ClickHouse down | Analytics unavailable | Buffered logger retries |

---

## What's NOT Exposed

The following have **no external access** - internal K8s network only:

- Worker `/api/*` routes (removed or internal-only)
- NATS ports (4222, 6222, 8222)
- Dragonfly port (6379)
- ClickHouse ports (8123, 9000)
- Prometheus metrics (scraped internally)

---

## Development Setup

### Local Development
```
├── Database: PostgreSQL (port 5433)
├── Queue: NATS JetStream (port 4222)
├── Analytics: ClickHouse (port 8123)
├── Cache: DragonflyDB (port 6379)
├── Monitoring: Prometheus (port 9090) + Grafana (port 3003)
├── Worker: Port 6001
└── Web Dashboard: Port 3000 (Next.js)
```

### Quick Start
```bash
# Start infrastructure
docker-compose up -d

# Run worker
cd apps/worker && bun run dev

# Run web app
cd apps/web && bun run dev
```

### Testing
```bash
# Unit tests
bun test

# Integration tests (with Docker)
bun test:integration

# Load tests
bun test:load
```
