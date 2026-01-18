# BatchSender Scaling Plan

> Created: 2026-01-18
> Goal: Scale from ~5K msg/sec to 50K+ msg/sec (enterprise-ready)

## Current State Assessment

### Architecture
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Web App   │────▶│  PostgreSQL │◀────│   Workers   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
┌─────────────┐     ┌─────────────┐     ┌──────▼──────┐
│ ClickHouse  │◀────│   Workers   │◀────│    NATS     │
│ (analytics) │     └─────────────┘     │ (1 node)    │
└─────────────┘                         └─────────────┘
```

### Current Capacity Limits
| Component | Setup | Bottleneck | Limit |
|-----------|-------|------------|-------|
| PostgreSQL | Single instance | Write throughput | ~5-10K writes/sec |
| NATS | Single node | No HA, limited throughput | ~50K msg/sec |
| Workers | 2-50 pods (KEDA) | Scales well | Not the bottleneck |
| ClickHouse | Single node, 1-2GB | Analytics only | Fine for now |
| Dragonfly | Single instance | Rate limiting | Fine for now |

### Identified Bottlenecks (Priority Order)

1. **PostgreSQL writes** - Every recipient insert/update hits Postgres
2. **NATS single point of failure** - No HA, lose messages if it dies
3. **No tenant isolation** - Noisy neighbor problem
4. **ClickHouse capacity** - Will need more if recipients move there

---

## Scaling Phases

### Phase 1: Quick Wins (This Week)
**Goal:** Improve reliability, remove single points of failure

#### 1.1 NATS Cluster (3 nodes)
- **Priority:** HIGH
- **Effort:** 1-2 days
- **Cost:** +$30-50/month
- **Risk:** Low

**Why first:**
- Currently single point of failure
- If NATS dies, all in-flight messages are lost
- Clustering is well-documented, low risk
- No code changes required

**Tasks:**
- [ ] Update NATS StatefulSet to 3 replicas
- [ ] Update NATS config for clustering
- [ ] Update network policies for inter-node communication
- [ ] Test failover (kill a node, verify recovery)

#### 1.2 Vertical Scale ClickHouse
- **Priority:** MEDIUM
- **Effort:** 1 hour
- **Cost:** +$30-50/month
- **Risk:** Low

**Why:**
- Prepares for recipient data migration
- Currently undersized for growth
- Simple resource bump

**Tasks:**
- [ ] Increase RAM to 4GB
- [ ] Increase CPU to 1-2 cores
- [ ] Monitor performance after change

---

### Phase 2: Remove Postgres Bottleneck (2-3 weeks)
**Goal:** 10x write capacity by moving recipients to ClickHouse

#### 2.1 Design Recipient Storage in ClickHouse
- **Priority:** HIGH
- **Effort:** 2-3 days design
- **Cost:** $0
- **Risk:** Medium (need to get schema right)

**Schema considerations:**
```sql
CREATE TABLE recipients (
    batch_id UUID,
    recipient_id UUID,
    email String,
    status Enum('pending', 'queued', 'sent', 'failed', 'bounced'),
    created_at DateTime64(3),
    updated_at DateTime64(3),
    sent_at Nullable(DateTime64(3)),
    error Nullable(String),
    provider_message_id Nullable(String),
    latency_ms Nullable(UInt32)
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (batch_id, recipient_id);
```

**Key decisions:**
- Use ReplacingMergeTree for status updates
- Partition by month for efficient cleanup
- Keep batch metadata in Postgres (small, relational)
- Move only recipient data to ClickHouse (high volume)

#### 2.2 Implement Dual-Write Migration
- **Priority:** HIGH
- **Effort:** 1 week
- **Cost:** $0
- **Risk:** Medium

**Strategy:**
1. Write to both Postgres AND ClickHouse (dual-write)
2. Read from Postgres (source of truth)
3. Verify ClickHouse data matches
4. Switch reads to ClickHouse
5. Stop Postgres recipient writes
6. Archive/drop Postgres recipients table

**Tasks:**
- [ ] Add ClickHouse recipient schema
- [ ] Update worker to dual-write recipient status
- [ ] Add verification job to compare data
- [ ] Update API to read from ClickHouse
- [ ] Add feature flag for cutover
- [ ] Run migration on staging
- [ ] Production cutover

#### 2.3 Update Batch Stats Queries
- **Priority:** HIGH
- **Effort:** 3-5 days
- **Cost:** $0
- **Risk:** Low

**Tasks:**
- [ ] Update `getBatchStats()` to query ClickHouse
- [ ] Update recipient list endpoint
- [ ] Update dashboard aggregations
- [ ] Ensure API response format unchanged

---

### Phase 3: Tenant Isolation (1 week)
**Goal:** Prevent noisy neighbor problems

#### 3.1 Per-Tenant NATS Streams
- **Priority:** MEDIUM
- **Effort:** 3-5 days
- **Cost:** ~$0 (NATS handles many streams)
- **Risk:** Low

**Current:**
```
All users → single "email-jobs" stream → workers compete
```

**After:**
```
User A → "jobs.user-a" stream → dedicated consumer
User B → "jobs.user-b" stream → dedicated consumer
Large customer → "jobs.enterprise-x" stream → multiple consumers
```

**Tasks:**
- [ ] Create stream-per-user pattern
- [ ] Update enqueueBatch to route to user stream
- [ ] Update workers to consume from user streams
- [ ] Add consumer auto-scaling per stream
- [ ] Test with simulated multi-tenant load

#### 3.2 Per-Tenant Rate Limiting
- **Priority:** MEDIUM
- **Effort:** 1-2 days
- **Cost:** $0
- **Risk:** Low

**Current:** Global rate limits
**After:** Per-tenant configurable limits

**Tasks:**
- [ ] Add rate_limit column to users table
- [ ] Update rate limiter to check user limits
- [ ] Add admin API to adjust limits
- [ ] Default limits for free/paid tiers

---

### Phase 4: Database Reliability (When Needed)
**Goal:** Postgres HA for enterprise SLAs

#### 4.1 PostgreSQL Read Replica
- **Priority:** LOW (do when needed)
- **Effort:** 3-5 days
- **Cost:** +$50-100/month
- **Risk:** Medium

**When to do this:**
- When you have >10 concurrent dashboard users
- When read latency becomes an issue
- When you need 99.99% SLA

**Alternative:** Switch to managed Postgres (Neon, Supabase, RDS)
- Easier for SOC2 compliance
- Built-in HA and backups
- Higher cost but lower ops burden

---

### Phase 5: Multi-Region (Future)
**Goal:** Global presence, geographic redundancy

**When to do this:**
- When you have customers demanding <100ms latency globally
- When you need geographic redundancy for compliance
- When revenue justifies 3x infrastructure cost

**Scope:**
- Deploy to US, EU, Asia
- Global load balancer
- Data replication strategy
- Region-aware routing

**Effort:** 4-8 weeks
**Cost:** 2-3x current infrastructure

**Skip until absolutely necessary.**

---

## Implementation Order

```
Week 1:
├── [1.1] NATS Cluster (1-2 days)
├── [1.2] ClickHouse vertical scale (1 hour)
└── Performance testing baseline

Week 2-3:
├── [2.1] Design ClickHouse recipient schema
├── [2.2] Implement dual-write
└── [2.3] Migrate batch stats queries

Week 4:
├── [3.1] Per-tenant NATS streams
├── [3.2] Per-tenant rate limiting
└── Load testing at scale

Future (when needed):
├── [4.1] Postgres read replica or managed
└── [5.x] Multi-region
```

---

## Cost Summary

| Phase | Monthly Cost Increase | Cumulative |
|-------|----------------------|------------|
| Current | - | ~$230/month |
| Phase 1 | +$60-100 | ~$300/month |
| Phase 2 | +$20-50 | ~$350/month |
| Phase 3 | ~$0 | ~$350/month |
| Phase 4 | +$50-100 | ~$450/month |
| **Total** | **+$150-250** | **~$400-500/month** |

**Result:** 10x capacity for ~2x cost

---

## Success Metrics

| Metric | Current | After Phase 3 |
|--------|---------|---------------|
| Sustained throughput | ~5K msg/sec | ~50K msg/sec |
| Messages/day capacity | ~400M | ~4B |
| Largest single batch | ~1M | ~10M+ |
| NATS availability | ~99% (single node) | ~99.9% (cluster) |
| Tenant isolation | None | Full |
| Postgres write load | 100% | ~10% (metadata only) |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| ClickHouse migration data loss | High | Dual-write period, verification jobs |
| NATS cluster split-brain | Medium | Proper quorum config (3 nodes) |
| Tenant isolation adds latency | Low | Benchmark before/after |
| Breaking API changes | High | Feature flags, backwards compat |

---

## Next Steps

1. **Immediate:** Run performance tests with current system (baseline)
2. **This week:** Implement Phase 1 (NATS cluster + ClickHouse scale)
3. **Next sprint:** Phase 2 (recipient migration to ClickHouse)
4. **Following sprint:** Phase 3 (tenant isolation)

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
