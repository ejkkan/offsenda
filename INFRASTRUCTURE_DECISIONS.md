# Infrastructure Decisions & Roadmap

## Current Architecture

### Production Setup
- **Regions**: Falkenstein (primary), Ashburn (secondary)
- **Orchestration**: Kubernetes with Kustomize overlays, ArgoCD GitOps
- **Database**: External (Neon) via `DATABASE_URL` - no in-cluster PostgreSQL in production
- **Message Queue**: NATS JetStream (3-node HA cluster with TLS)
- **Cache/Rate Limiting**: Dragonfly (3-node, Redis-compatible)
- **Analytics**: ClickHouse with B2 cold storage (Falkenstein only, Ashburn uses Falkenstein's)
- **Secrets**: Sealed Secrets (Bitnami)
- **Autoscaling**: KEDA for workers (queue-depth based, 2-50 replicas)

### Environment Configuration
- All services configured via environment variables
- `DATABASE_URL` connection string for database access
- Secrets stored in sealed secrets, referenced by deployments
- Full configuration documented in `apps/worker/.env.example`

### Rate Limiting Architecture
Two-tier rate limiting system:

1. **API Rate Limiting** (`api-rate-limiter.ts`)
   - Protects HTTP API from abuse
   - Per-IP, requests per minute
   - Sliding window log algorithm

2. **Message Processing Rate Limiting** (`rate-limiting/` directory)
   - Controls send throughput to providers
   - Managed mode: shared provider limits (SES, Resend, Telnyx)
   - BYOK mode: per-config limits
   - Token bucket algorithm with composable checks

## Completed Improvements

### January 2025
- [x] Removed External Secrets (keeping Sealed Secrets only)
- [x] Removed in-cluster PostgreSQL from production overlays (using external DB)
- [x] Cleaned up misleading migration comments in kustomization
- [x] Pinned test docker-compose versions to match local/production:
  - NATS: 2.10-alpine
  - PostgreSQL: 16-alpine
  - ClickHouse: 24-alpine
  - Dragonfly: v1.14.0
- [x] Added Pod Disruption Budgets for worker, web, nats
- [x] Created staging overlay with reduced resources
- [x] Updated `.env.example` with all configuration options
- [x] Simplified rate limiting:
  - Removed dead code (`provider-rate-limiter.ts`)
  - Renamed `rate-limiter.ts` → `api-rate-limiter.ts` for clarity
  - Documented two-tier architecture
- [x] Documented legacy JobData fields:
  - Marked deprecated fields with JSDoc
  - Added migration path documentation
  - Fields kept for backwards compatibility (database schema dependency)

## Future Improvements

### Medium Priority
- [ ] Set up cron job for DNS failover script
- [ ] Add alerting for region failures

### Future Considerations

#### Legacy JobData Fields Migration
**Status**: Documented, fields marked as deprecated

**Current State**:
- Database `batches` table has both `payload` (JSON) and individual columns (`fromEmail`, `subject`, etc.)
- `JobData` interface supports both for backwards compatibility
- Payload builder handles priority: `payload` > legacy fields > config defaults

**Why Not Remove Now**:
- Fields are in database schema (requires migration)
- Existing batches use the legacy columns
- Breaking change for any external integrations

**Migration Path** (when ready):
1. Ensure all new batches use `payload` field exclusively
2. Create database migration to consolidate legacy columns into `payload`
3. Update API to reject individual field parameters
4. Remove legacy fields from `JobData` interface
5. Remove fallback logic from payload builders

**Files Affected**:
- `packages/db/src/schema.ts` - batches table schema
- `apps/worker/src/nats/queue-service.ts` - JobData interface
- `apps/worker/src/nats/workers.ts` - job creation
- `apps/worker/src/domain/payload-builders/` - payload building
- `apps/worker/src/api.ts` - API endpoints

#### Multi-Region Setup
**Status**: Implemented, needs operational setup

**Architecture**:
```
                    ┌──────────────────┐
                    │   Cloudflare     │
                    │   (DNS + CDN)    │
                    └────────┬─────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                                       ▼
┌─────────────────────┐           ┌─────────────────────┐
│  Falkenstein (EU)   │           │    Ashburn (US)     │
│  ───────────────    │           │  ───────────────    │
│  NATS (3-node)  ◄───┼───────────┼──► NATS (3-node)    │
│  Workers (2-50)     │  Gateway  │  Workers (2-50)     │
│  ClickHouse ◄───────┼───────────┼──                   │
│  Dragonfly          │           │  Dragonfly          │
└─────────────────────┘           └─────────────────────┘
```

**Cross-Region Connections** (DNS names in ConfigMaps):
- `nats-gateway.batchsender.com` - Falkenstein NATS gateway
- `nats-gateway.batchsender-us.com` - Ashburn NATS gateway
- `clickhouse.batchsender.com` - Falkenstein ClickHouse (shared)

**DNS Failover**:
- Script: `scripts/dns-failover.sh`
- Monitors both regions via health endpoints
- Switches `api.batchsender.com` to healthy region
- Automatic failback when primary recovers

**Setup Required**:
1. Set environment variables:
   ```bash
   export CLOUDFLARE_API_TOKEN="..."
   export CLOUDFLARE_ZONE_ID="..."
   export FALKENSTEIN_IP="..."
   export ASHBURN_IP="..."
   ```
2. Run via cron every minute:
   ```bash
   * * * * * /path/to/dns-failover.sh >> /var/log/dns-failover.log 2>&1
   ```
3. Optional: Configure `ALERT_WEBHOOK` for Slack/Discord notifications

#### Move Frontend to Cloudflare Pages
**Status**: Under consideration

**Rationale**:
- Frontend is low-traffic dashboard, doesn't need K8s complexity
- Workers handle all heavy processing (already auto-scaled via KEDA)
- Cloudflare Pages provides free hosting, automatic scaling, edge caching
- Simplifies infrastructure - one less deployment to manage

**Migration path**:
1. Verify Next.js compatibility with Cloudflare Pages
2. Decide on API routes: keep as Cloudflare Functions or move to worker service
3. Update CI/CD pipeline for Cloudflare deployment
4. Remove web deployment from K8s

**Decision**: Defer until after production stabilization

## Architecture Principles

1. **External databases for production** - easier backups, scaling, no PVC management
2. **Queue-based autoscaling** - scale workers based on actual work, not CPU
3. **Sealed Secrets** - GitOps-friendly secret management
4. **Version pinning** - consistent behavior across local/test/production
5. **Keep it simple** - avoid over-engineering, remove unused components
6. **Clear naming** - file names should indicate purpose (e.g., `api-rate-limiter.ts`)

## Kubernetes Overlays

| Overlay | Purpose | Replicas | Resources |
|---------|---------|----------|-----------|
| `production` | Falkenstein (primary) | NATS: 3, Worker: 2-50 | Full |
| `production-ashburn` | Ashburn (secondary) | NATS: 3, Worker: 2-50 | Full |
| `staging` | Cost-effective testing | NATS: 1, Worker: 1-10 | Reduced |
| `local` | Local k3d development | Minimal | Minimal |

## Cost Optimization

For testing/early stage, use staging overlay:
- Worker min replicas: 1 (vs 2 in production)
- Worker max replicas: 10 (vs 50 in production)
- NATS replicas: 1 (vs 3, loses HA)
- Reduced CPU/memory requests

Deploy staging: `kubectl apply -k k8s/overlays/staging`
