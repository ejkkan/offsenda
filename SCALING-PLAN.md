# BatchSender Scaling Plan

> Created: 2026-01-18
> Updated: 2026-01-23
> Goal: Scale from ~5K msg/sec to 50K+ msg/sec (enterprise-ready)

## Current State Assessment

### Architecture (Updated)
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Web App   │────▶│  PostgreSQL │◀────│   Workers   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                           ▲                   │
                           │ (sync every 2s)   │
┌─────────────┐     ┌──────┴──────┐     ┌──────▼──────┐
│ ClickHouse  │◀────│  Dragonfly  │◀────│    NATS     │
│ (analytics) │     │ (hot state) │     │ (3 nodes)   │
└─────────────┘     └─────────────┘     └─────────────┘
```

### Current Capacity (Post Phase 1+2+3)
| Component | Setup | Status | Capacity |
|-----------|-------|--------|----------|
| PostgreSQL | Single instance | Offloaded via Dragonfly | Writes reduced ~90% |
| NATS | 3-node cluster | ✅ HA enabled | ~100K+ msg/sec |
| Workers | 2-50 pods (KEDA) | Scales well | Not the bottleneck |
| ClickHouse | 4GB RAM, 2 cores | ✅ Scaled | Analytics + events |
| Dragonfly | Hot state cache | ✅ Implemented | Fast path for sends |

### Remaining Bottlenecks

1. **PostgreSQL still source of truth** - Recipients table still in Postgres (mitigated by Dragonfly caching)
2. **Batch stats queries** - May still hit Postgres for some queries
3. **No admin API for rate limits** - Rate limits configured per sendConfig, no admin override

---

## Scaling Phases

### Phase 1: Quick Wins ✅ COMPLETE

#### 1.1 NATS Cluster (3 nodes) ✅
- **Status:** COMPLETE
- **Implementation:** `k8s/base/nats/statefulset.yaml`, `k8s/base/nats/configmap.yaml`

**Completed:**
- [x] Update NATS StatefulSet to 3 replicas
- [x] Update NATS config for clustering (TLS enabled, routes configured)
- [x] Update network policies for inter-node communication (port 6222)
- [x] PodDisruptionBudget configured (minAvailable: 2)
- [ ] Test failover (kill a node, verify recovery) - **NEEDS VERIFICATION**

#### 1.2 Vertical Scale ClickHouse ✅
- **Status:** COMPLETE
- **Implementation:** `k8s/base/clickhouse/statefulset.yaml`

**Completed:**
- [x] Increase RAM to 4GB (limit: 4Gi)
- [x] Increase CPU to 2 cores (limit: 2000m)
- [x] Storage: 20Gi PVC with B2 cold storage archival

---

### Phase 2: Remove Postgres Bottleneck ⚠️ ALTERNATIVE APPROACH

> **Note:** Original plan was to migrate recipients to ClickHouse. Instead, implemented
> a **Dragonfly hot-state caching layer** that achieves similar throughput goals while
> keeping Postgres as source of truth.

#### 2.1 Dragonfly Hot-State Architecture ✅ (Replaced ClickHouse recipients)
- **Status:** COMPLETE
- **Implementation:** `apps/worker/src/hot-state-manager.ts`, `apps/worker/src/services/postgres-sync.ts`

**What was implemented instead:**
- [x] Dragonfly as hot-state cache for in-flight batches
- [x] Atomic counter updates in Dragonfly (no Postgres writes on hot path)
- [x] Background sync service: Dragonfly → Postgres every 2 seconds
- [x] Configurable via `POSTGRES_SYNC_ENABLED`, `POSTGRES_SYNC_INTERVAL_MS`

**Architecture:**
```
Send Request → Dragonfly (immediate) → Background Sync → PostgreSQL
                    ↓
              ClickHouse (buffered events for analytics)
```

#### 2.2 ClickHouse Event Logging ✅
- **Status:** COMPLETE
- **Implementation:** `apps/worker/src/buffered-logger.ts`, `apps/worker/src/clickhouse.ts`

**Completed:**
- [x] Buffered writes to ClickHouse (10K buffer, 5s flush)
- [x] `email_events` table with ReplacingMergeTree
- [x] `batch_stats_mv` materialized view for aggregations
- [x] Provider message indexing for webhook lookups

#### 2.3 Batch Stats Queries ⚠️ NEEDS VERIFICATION
- **Status:** PARTIALLY COMPLETE
- **Risk:** Some queries may still hit Postgres

**Tasks:**
- [x] ClickHouse has `batch_stats_mv` materialized view
- [ ] Verify `getBatchStats()` reads from ClickHouse - **NEEDS CHECK**
- [ ] Verify recipient list endpoint uses ClickHouse - **NEEDS CHECK**
- [ ] Verify dashboard aggregations use ClickHouse - **NEEDS CHECK**

---

### Phase 3: Tenant Isolation ✅ COMPLETE (Different Implementation)

#### 3.1 Per-Tenant Message Routing ✅
- **Status:** COMPLETE (single stream, per-tenant consumers)
- **Implementation:** `apps/worker/src/nats/client.ts`, `apps/worker/src/nats/queue-service.ts`

> **Note:** Instead of separate streams per tenant, implemented single shared stream
> with subject-based routing and dynamic per-tenant consumers. This is simpler to
> operate and achieves the same isolation goals.

**Architecture:**
```
Single "email-system" stream
├── Subjects: email.user.{userId}.send, email.user.{userId}.chunk
├── Dynamic consumers: user-{userId} (created on-demand)
├── Filter: email.user.{userId}.> per consumer
└── Auto-cleanup: consumers deleted after 1 hour inactivity
```

**Completed:**
- [x] Subject pattern includes userId: `email.user.${userId}.send`
- [x] Dynamic consumer creation per user (`createUserConsumer()`)
- [x] Consumer auto-scaling (created on-demand when batch starts)
- [x] Consumer auto-cleanup (inactive_threshold: 1 hour)
- [x] Tested with multi-tenant load (implicit via production use)

#### 3.2 Per-Tenant Rate Limiting ✅
- **Status:** COMPLETE
- **Implementation:** `apps/worker/src/rate-limiting/`

**Completed:**
- [x] Rate limits stored per sendConfig (`rateLimit` jsonb column)
- [x] Rate limiter uses per-config Redis keys: `rate_limit:config:{sendConfigId}:bucket`
- [x] Hierarchical limits: system → provider → config
- [x] Token bucket algorithm with atomic Lua scripts
- [x] Managed vs BYOK mode support

**Not implemented (lower priority):**
- [ ] Admin API to adjust rate limits dynamically
- [ ] User-level rate limit override (currently only per sendConfig)
- [x] Provider-aware default rate limits (SES=14/s, Resend=100/s, Webhook=50/s, Managed=100/s)

---

### Phase 4: Database Reliability (When Needed)
**Goal:** Postgres HA for enterprise SLAs
**Status:** NOT STARTED (deferred)

#### 4.1 PostgreSQL Read Replica
- **Priority:** LOW (do when needed)
- **Cost:** +$50-100/month

**When to do this:**
- When you have >10 concurrent dashboard users
- When read latency becomes an issue
- When you need 99.99% SLA

**Alternative:** Switch to managed Postgres (Neon, Supabase, RDS)

---

### Phase 5: Multi-Region (Future)
**Goal:** Global presence, geographic redundancy
**Status:** NOT STARTED (deferred)

**When to do this:**
- When you have customers demanding <100ms latency globally
- When you need geographic redundancy for compliance
- When revenue justifies 3x infrastructure cost

---

## Remaining Work Summary

### High Priority
| Task | Phase | Effort | Notes |
|------|-------|--------|-------|
| Verify NATS failover | 1.1 | 1-2 hours | Kill a node, confirm recovery |
| Verify batch stats use ClickHouse | 2.3 | 2-4 hours | Check API queries |
| Verify recipient list uses ClickHouse | 2.3 | 2-4 hours | Check API queries |

### Medium Priority
| Task | Phase | Effort | Notes |
|------|-------|--------|-------|
| Admin API for rate limits | 3.2 | 1-2 days | Allow dynamic adjustment |

### Low Priority (When Needed)
| Task | Phase | Effort | Notes |
|------|-------|--------|-------|
| Postgres read replica | 4.1 | 3-5 days | When >10 concurrent users |
| Multi-region | 5.x | 4-8 weeks | When revenue justifies |

---

## Updated Implementation Timeline

```
COMPLETED:
├── [1.1] NATS Cluster ✅
├── [1.2] ClickHouse vertical scale ✅
├── [2.1] Dragonfly hot-state (alternative to ClickHouse recipients) ✅
├── [2.2] ClickHouse event logging ✅
├── [3.1] Per-tenant consumers ✅
└── [3.2] Per-tenant rate limiting ✅

REMAINING:
├── [1.1] Verify NATS failover (1-2 hours)
├── [2.3] Verify batch stats queries use ClickHouse (2-4 hours)
├── [3.2] Admin API for rate limits (1-2 days, optional)
└── [4.1+] Postgres HA / Multi-region (future)

JUST COMPLETED:
└── [3.2] Provider-aware default rate limits ✅
```

---

## Cost Summary (Actual)

| Phase | Monthly Cost Increase | Status |
|-------|----------------------|--------|
| Current baseline | ~$230/month | - |
| Phase 1 (NATS + ClickHouse) | +$60-100 | ✅ Complete |
| Phase 2 (Dragonfly) | +$20-50 | ✅ Complete |
| Phase 3 (Tenant isolation) | ~$0 | ✅ Complete |
| **Current Total** | **~$350/month** | |

---

## Success Metrics (Updated)

| Metric | Original | Current | Target |
|--------|----------|---------|--------|
| Sustained throughput | ~5K msg/sec | ~20-30K msg/sec (est.) | ~50K msg/sec |
| NATS availability | ~99% (single) | ~99.9% (cluster) | ✅ Achieved |
| Tenant isolation | None | Full (consumers) | ✅ Achieved |
| Postgres write load | 100% | ~10-20% (hot path cached) | ✅ Achieved |
| Rate limiting | Global | Per-config | ✅ Achieved |

---

## Appendix: Key Files Reference

| Component | File |
|-----------|------|
| NATS cluster config | `k8s/base/nats/statefulset.yaml`, `k8s/base/nats/configmap.yaml` |
| ClickHouse resources | `k8s/base/clickhouse/statefulset.yaml` |
| Hot state manager | `apps/worker/src/hot-state-manager.ts` |
| Postgres sync | `apps/worker/src/services/postgres-sync.ts` |
| Buffered logger | `apps/worker/src/buffered-logger.ts` |
| NATS consumers | `apps/worker/src/nats/client.ts`, `apps/worker/src/nats/workers.ts` |
| Rate limiting | `apps/worker/src/rate-limiting/` |

---

## Appendix: Commands for Performance Testing

```bash
# Reset test webhook stats
curl -X DELETE https://api.valuekeys.io/api/test-webhook/reset \
  -H "Authorization: Bearer $API_KEY"

# Check stats during test
curl https://api.valuekeys.io/api/test-webhook/stats \
  -H "Authorization: Bearer $API_KEY"

# Create test batch (adjust size as needed)
curl -X POST https://api.valuekeys.io/api/batches \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Load Test",
    "sendConfigId": "<webhook-config-id>",
    "recipients": [... array of test recipients ...]
  }'
```
