# Production Readiness Checklist - Unified Plan

**Created:** 2026-01-13
**Status:** 📋 Under Review
**Priority:** CRITICAL - Required before production launch
**Last Updated:** 2026-01-13 (Unified version with all additions)

---

## Executive Summary

Current production configuration is **65% ready** (3 Quick Wins completed). Core infrastructure (K8s, NATS, PostgreSQL) is solid, but critical gaps exist in:
- ❌ **Cold Storage & Backups** - Data loss risk
- ❌ **Encryption & Security** - Compliance violations
- ❌ **Disaster Recovery** - Single point of failure
- ⚠️ **Monitoring & Alerting** - Limited visibility
- ❌ **Queue-Based Autoscaling** - CPU metrics blind to queue depth
- ❌ **Webhook Resilience** - No timeout or retry mechanism

This document prioritizes fixes by **Impact × Ease**, highlighting quick wins that dramatically improve resilience.

**Note:** Neon database uses HTTP connections (serverless driver), eliminating traditional connection pool concerns.

---

## ✅ Completed (2026-01-13)

### 1. Webhook Signature Strict Validation (1 hour) 🔐
**Completed:** 2026-01-13
**Files modified:** `apps/worker/src/webhooks.ts:114-131`

Fixed security vulnerability where webhook validation would be skipped if signature headers were missing. Now explicitly rejects requests with 401 when signature validation fails or headers are missing in production.

---

### 2. Graceful Error Messages (2 hours) 🎭
**Completed:** 2026-01-13
**Files modified:** `apps/worker/src/index.ts:20-46`

Added global error handler that prevents stack trace leakage in production. Logs full error details internally while returning sanitized messages to clients. Development mode still shows full error details for debugging.

---

### 3. Request Validation Middleware (2-3 hours) 🛡️
**Completed:** 2026-01-13
**Files modified:** `apps/worker/src/index.ts:48-109`, `apps/worker/src/config.ts:47-49`

Implemented comprehensive request validation:
- Request size limits (10MB default, configurable via `MAX_REQUEST_SIZE_BYTES`)
- IP-based rate limiting (100 req/min per IP, configurable via `RATE_LIMIT_PER_IP`)
- Content-Type validation for POST/PUT/PATCH requests
- Automatic cleanup of expired rate limit entries

**Progress:** 6/23 items completed (26%)

---

## 🎯 Quick Wins (Remaining)

These are **high-impact, low-effort** improvements you can implement TODAY or this week:

### 4. Stuck Batch Detector (45 minutes) 🔍 ✅
**Impact:** HIGH | **Effort:** LOW | **Risk:** None
**Status:** COMPLETED (2026-01-17)

**Why:** Batches get stuck in "processing" status when all emails are sent but completion check fails. Users can't tell if batch finished. No automatic recovery exists.

**Implementation:** Done! Created a dedicated `BatchRecoveryService` with:
- Periodic scanning (configurable interval, default 5 minutes)
- Configurable stuck threshold (default 15 minutes)
- Automatic recovery of batches with all recipients in final state
- Circuit breaker to prevent overload
- Prometheus metrics for monitoring

**Files created:**
- `apps/worker/src/services/batch-recovery.ts` - Full recovery service

**Configuration (via environment):**
- `BATCH_RECOVERY_ENABLED` - Enable/disable the service
- `BATCH_RECOVERY_INTERVAL_MS` - Scan interval (default: 5 minutes)
- `BATCH_RECOVERY_THRESHOLD_MS` - Stuck threshold (default: 15 minutes)
- `BATCH_RECOVERY_MAX_PER_SCAN` - Max batches per scan (default: 100)

---

### 5. Webhook Timeout and Retry Logic (2-3 hours) ⏱️ ✅
**Impact:** MEDIUM | **Effort:** LOW | **Risk:** Low
**Status:** COMPLETED (2026-01-17)

**Why:** Webhooks have no timeout and can hang indefinitely. No retry on transient failures. Single slow webhook can block others.

**Implementation:** Done! Created a comprehensive resilient HTTP client with:
- Configurable retry with exponential backoff and jitter
- Circuit breaker pattern (per-endpoint)
- Request timeout with AbortController
- Error classification (transient vs permanent)
- Metrics and logging integration

**Files created:**
- `apps/worker/src/http/resilient-client.ts` - Full HTTP client with retry/circuit breaker
- Updated `apps/worker/src/modules/webhook-module.ts` - Uses resilient client

**Configuration (via environment):**
- `WEBHOOK_TIMEOUT_MS` - Request timeout (default: 30s)
- `WEBHOOK_MAX_RETRIES` - Max retry attempts (default: 3)
- `WEBHOOK_RETRY_BASE_DELAY_MS` - Initial delay (default: 1s)
- `WEBHOOK_RETRY_MAX_DELAY_MS` - Max delay (default: 10s)
- `WEBHOOK_CIRCUIT_BREAKER_ENABLED` - Enable circuit breaker
- `WEBHOOK_CIRCUIT_FAILURE_THRESHOLD` - Failures before open (default: 5)
- `WEBHOOK_CIRCUIT_RESET_TIMEOUT_MS` - Reset timeout (default: 30s)

---

### 6. Enable TLS for NATS (2-4 hours) 🔒 ✅
**Impact:** HIGH | **Effort:** LOW | **Risk:** Medium
**Status:** COMPLETED (2026-01-17)

**Why:** Encrypts all message traffic between workers and NATS. Currently unencrypted.

**Implementation:** Done! Created full TLS setup with:
- Certificate resource using cert-manager (self-signed for internal use)
- NATS config ConfigMap with TLS settings for client and cluster connections
- Worker deployment with TLS certificate volume mount
- Worker NATS client with TLS connection support
- Production overlay enables TLS automatically

**Files created/modified:**
- `k8s/base/nats/certificate.yaml` - TLS certificate for NATS
- `k8s/base/nats/configmap.yaml` - NATS server config with TLS
- `k8s/base/nats/statefulset.yaml` - Updated to use TLS config
- `apps/worker/src/nats/client.ts` - Added TLS connection options
- `apps/worker/src/config.ts` - Added NATS_TLS_* config options
- `k8s/base/worker/deployment.yaml` - Mounts TLS certificates
- `k8s/overlays/production/kustomization.yaml` - Enables TLS in production

**Configuration:**
- `NATS_TLS_ENABLED` - Enable/disable TLS (default: false in dev, true in prod)
- `NATS_TLS_CA_FILE` - Path to CA certificate

---

### 7. Implement Audit Logging (4-6 hours) 📝 ✅
**Impact:** HIGH | **Effort:** LOW | **Risk:** Low
**Status:** COMPLETED (2026-01-17)

**Why:** Track all sensitive operations for security and debugging. Required for compliance.

**Implementation:** Done! Created a comprehensive audit logging system with:
- Type-safe event definitions (categories, actions, outcomes)
- Buffered writes to ClickHouse for high throughput
- Security alerts materialized view for monitoring
- Query and stats APIs for dashboards
- Non-blocking design (failures don't break main flow)

**Files created:**
- `apps/worker/src/services/audit.ts` - Full audit service
- Updated `infra/clickhouse/init/001_schema.sql` - Added audit_log table and security_alerts_mv

**Configuration (via environment):**
- `AUDIT_ENABLED` - Enable/disable audit logging
- `AUDIT_LOG_TO_CONSOLE` - Also log to console (for debugging)
- `AUDIT_BATCH_SIZE` - Events to buffer before flush (default: 100)
- `AUDIT_FLUSH_INTERVAL_MS` - Flush interval (default: 5s)

**Event Categories:**
- `auth` - Login, logout, password changes
- `batch` - Create, start, pause, resume, cancel, delete
- `config` - Send config CRUD
- `api_key` - Create, revoke, usage
- `webhook` - Config changes, signature validation
- `admin` - User management
- `security` - Rate limits, invalid tokens, permission denied

---

### 8. Add ClickHouse Backup Script (3-4 hours) 💾 ✅
**Impact:** HIGH | **Effort:** LOW | **Risk:** Low
**Status:** COMPLETED (2026-01-13)

**Why:** Prevents catastrophic data loss. Currently NO backups exist.

**Implementation:** Done! Backups go to Backblaze B2 (same bucket as cold storage).

**Files created:**
- `scripts/clickhouse-backup.sh` - Full and incremental backups
- `scripts/clickhouse-restore.sh` - Restore from backup

**Usage:**
```bash
./scripts/clickhouse-backup.sh full        # Full backup
./scripts/clickhouse-backup.sh incremental # Incremental backup
./scripts/clickhouse-restore.sh <name>     # Restore
```

**TODO:** Set up K8s CronJob for automated daily backups in production

---

### 9. Document Runbook for Common Issues (3-4 hours) 📖
**Impact:** MEDIUM | **Effort:** LOW | **Risk:** None

**Why:** Reduce MTTR (mean time to recovery) during incidents

**Create:**
- `docs/runbooks/stuck-batches.md`
- `docs/runbooks/nats-connection-loss.md`
- `docs/runbooks/database-slow-queries.md`
- `docs/runbooks/high-error-rate.md`
- `docs/runbooks/scale-during-load.md`
- `docs/runbooks/drain-worker.md`
- `docs/runbooks/provider-outage.md`

**Template:**
```markdown
# Runbook: [Issue Name]

## Symptoms
- What the user sees
- What the metrics show

## Diagnosis
- How to confirm the issue
- Commands to run

## Resolution
- Step-by-step fix
- Expected outcome

## Prevention
- How to avoid in future
```

---

## 🚨 Critical Path (Required Before Launch)

These MUST be completed before production launch:

### 10. Implement Cold Storage Archive (1-2 days) ❄️ ✅
**Impact:** CRITICAL | **Effort:** MEDIUM | **Risk:** Medium
**Status:** COMPLETED (2026-01-13)

**Why:** Current TTL DELETES data. Need archival to S3 for compliance and cost.

**Implementation:** Done! Using Backblaze B2 ($6/TB/month with free egress up to 3x storage).

**Files created/modified:**
- `infra/clickhouse/config/storage.xml` - B2 disk configuration
- `k8s/base/clickhouse/storage-configmap.yaml` - K8s config
- `k8s/base/clickhouse/b2-secret.yaml` - B2 credentials
- `k8s/base/clickhouse/deployment.yaml` - Mount config + env vars
- `infra/clickhouse/init/001_schema.sql` - TTL to cold storage (1 day)
- `k8s/base/clickhouse/init-configmap.yaml` - K8s schema update

**Configuration:**
- Data moves to B2 after 1 day (configurable)
- Tiered storage policy: hot (local SSD) → cold (B2)
- Tested and verified working

**Cost:** ~$6/TB/month storage + free egress (up to 3x storage)

---

### 11. Set Up Sealed Secrets (4-6 hours) 🔐
**Impact:** HIGH | **Effort:** MEDIUM | **Risk:** Medium

**Why:** Kubernetes Secrets are base64-encoded, not encrypted. Can be read by anyone with cluster access.

**Implementation:**
1. Install Sealed Secrets controller: `kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.26.0/controller.yaml`
2. Encrypt existing secrets:
   ```bash
   kubeseal --format=yaml < secret.yaml > sealed-secret.yaml
   ```
3. Replace all `k8s/base/*/secret.yaml` with sealed versions
4. Update deployment docs

**Files to modify:**
- `k8s/base/nats/secret.yaml` → `sealed-secret.yaml`
- `k8s/base/worker/secret.yaml` → `sealed-secret.yaml`
- `DEPLOY.md` (update secret management section)

---

### 12. Queue-Depth Based Autoscaling (4-6 hours) 📊
**Impact:** CRITICAL | **Effort:** MEDIUM | **Risk:** Low

**Why:** Current CPU-based autoscaling is blind to queue depth. Workers won't scale if queue has 100k messages but CPU is low. This is a major production risk.

**Implementation:**
1. Export NATS queue depth as Prometheus metrics
2. Install Prometheus Adapter for custom metrics to Kubernetes
3. Configure HPA to scale on queue depth:

```yaml
# k8s/base/worker/hpa.yaml - add to existing HPA
metrics:
- type: Pods
  pods:
    metric:
      name: cpu_utilization
    target:
      type: AverageValue
      averageValue: "60"
- type: External
  external:
    metric:
      name: nats_queue_depth
      selector:
        matchLabels:
          queue: "sys.batch.process"
    target:
      type: AverageValue
      averageValue: "1000"  # Scale up if >1000 msgs/pod
```

4. Add metrics endpoint to expose queue depth:
```typescript
// apps/worker/src/api.ts - enhance existing /metrics
app.get('/metrics', async (req, res) => {
  const streamInfo = await natsClient.getStreamInfo('email-system');
  const metrics = [
    `# HELP nats_queue_depth Number of pending messages in queue`,
    `# TYPE nats_queue_depth gauge`,
    `nats_queue_depth{queue="sys.batch.process"} ${streamInfo.state.messages}`,
    // ... existing metrics
  ].join('\n');

  res.type('text/plain').send(metrics);
});
```

**Files to modify:**
- `k8s/base/worker/hpa.yaml`
- `k8s/monitoring/prometheus-adapter-values.yaml` (create)
- `apps/worker/src/api.ts` (enhance metrics endpoint)

**Testing:** Use load generator to queue 10k messages, verify pods scale up

---

### 13. Implement Monitoring Stack (2-3 days) 📊
**Impact:** CRITICAL | **Effort:** HIGH | **Risk:** Medium

**Why:** Currently flying blind. Need metrics, alerts, and dashboards.

**Components:**
- **Prometheus** - Metric collection
- **Grafana** - Dashboards
- **AlertManager** - Alert routing
- **Loki** - Log aggregation (optional)

**Implementation:**
1. Deploy kube-prometheus-stack via Helm
2. Add ServiceMonitor for worker metrics
3. Create Grafana dashboards:
   - Batch processing rate
   - Email delivery success rate
   - NATS queue depth
   - Worker CPU/Memory
   - API response times
   - Consumer health metrics
4. Configure alerts:
   - High error rate (>5%)
   - Stuck batches (>15 min processing)
   - NATS queue backup (>10k messages)
   - Worker pod crashes
   - High API latency (p95 >500ms)
   - Stale consumers (>100)
   - Consumer memory usage (>100MB)

**Consumer Health Metrics to Add:**
```typescript
const staleConsumers = new Gauge({
  name: 'nats_stale_consumers_count',
  help: 'Number of consumers with no activity >1hr',
});

const consumerMemory = new Gauge({
  name: 'nats_consumer_memory_bytes',
  help: 'Memory usage per consumer',
  labelNames: ['consumer'],
});
```

**Files to create:**
- `k8s/monitoring/prometheus-servicemonitor.yaml`
- `k8s/monitoring/grafana-dashboard.json`
- `k8s/monitoring/alertmanager-config.yaml`

**Integration needed:**
- `apps/worker/src/api.ts` - Expose `/metrics` endpoint (already exists ✓)
- Add prom-client library
- Instrument critical paths

---

### 14. Add NetworkPolicy & RBAC (4-6 hours) 🛡️
**Impact:** HIGH | **Effort:** MEDIUM | **Risk:** Medium

**Why:** Currently any pod can talk to any other pod. Limits lateral movement after breach.

**Implementation:**
```yaml
# k8s/base/worker/networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: worker-policy
spec:
  podSelector:
    matchLabels:
      app: batchsender-worker
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: ingress-nginx
    ports:
    - protocol: TCP
      port: 3000
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: nats
    ports:
    - protocol: TCP
      port: 4222
  - to:  # PostgreSQL
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 5432
  - to:  # ClickHouse
    - podSelector:
        matchLabels:
          app: clickhouse
    ports:
    - protocol: TCP
      port: 9000
  - to:  # External (SES, Resend)
    - namespaceSelector: {}
```

**Files to create:**
- `k8s/base/worker/networkpolicy.yaml`
- `k8s/base/nats/networkpolicy.yaml`
- `k8s/base/clickhouse/networkpolicy.yaml`
- `k8s/base/rbac.yaml` (ServiceAccount + Role + RoleBinding)

---

### 15. Document RTO/RPO & DR Plan (1 day) 📋
**Impact:** HIGH | **Effort:** MEDIUM | **Risk:** None

**Why:** Required for compliance, customer trust, and incident response

**Create document:** `docs/DISASTER_RECOVERY.md`

**Contents:**
- **RTO (Recovery Time Objective):** How long to restore service? (Target: 4 hours)
- **RPO (Recovery Point Objective):** How much data loss acceptable? (Target: 15 minutes)
- **Backup Strategy:**
  - PostgreSQL: Neon automatic backups (hourly)
  - ClickHouse: S3 backups (daily)
  - NATS: Replicated (no backup needed for transient data)
- **Recovery Procedures:**
  - Step-by-step restoration from backup
  - Failover to standby region (if multi-region)
  - Database restore and validation
- **Testing Schedule:** Quarterly DR drills

---

## 🏗️ Medium Priority (1-3 Months)

### 16. Multi-Region Deployment (2-4 weeks)
**Impact:** HIGH | **Effort:** HIGH | **Risk:** High

**Why:** Single region = single point of failure

**Strategy:**
- Primary: Hetzner (current)
- Secondary: AWS us-east-1 or eu-west-1
- Database: PostgreSQL read replica in secondary region
- DNS: Route53 with health checks for automatic failover

---

### 17. Encryption at Rest (1 week)
**Impact:** HIGH | **Effort:** MEDIUM | **Risk:** Medium

**Components:**
- NATS: Enable encryption via `store_cipher = "chacha"`
- ClickHouse: Enable encryption via `<encryption_codecs>`
- PostgreSQL: Neon already supports (verify enabled)

---

### 18. API Gateway / Rate Limiting (1-2 weeks)
**Impact:** MEDIUM | **Effort:** MEDIUM | **Risk:** Medium

**Why:** DDoS protection, better rate limiting, API versioning

**Options:**
- Kong Gateway
- Traefik with rate limit middleware
- NGINX Ingress with rate limit annotations

---

### 19. Load Testing & Benchmarking (1 week)
**Impact:** MEDIUM | **Effort:** MEDIUM | **Risk:** Low

**Tools:** k6, Grafana Cloud k6

**Scenarios:**
- 1000 batches/hour sustained
- Spike to 10,000 batches in 10 minutes
- Webhook flood (1000 req/s)

**Measure:**
- Response times (p50, p95, p99)
- Error rates
- Resource utilization
- Database connection pool exhaustion

---

### 20. Feature Flags System (1 week)
**Impact:** MEDIUM | **Effort:** MEDIUM | **Risk:** Low

**Why:** Safe rollouts, A/B testing, instant rollback

**Options:**
- LaunchDarkly (SaaS, expensive)
- Unleash (self-hosted, free)
- Simple env var toggles

---

## 📊 Priority Matrix

| Task | Impact | Effort | Priority Score | Time | Status |
|------|--------|--------|----------------|------|--------|
| **Quick Wins** |
| 1. Webhook Strict Validation | Medium | Low | ⭐⭐⭐⭐⭐ | 1h | ✅ |
| 2. Graceful Error Messages | Medium | Low | ⭐⭐⭐⭐⭐ | 2h | ✅ |
| 3. Request Validation | Medium | Low | ⭐⭐⭐⭐ | 2-3h | ✅ |
| 4. Stuck Batch Detector | High | Low | ⭐⭐⭐⭐⭐ | 45m | ✅ |
| 5. Webhook Timeout/Retry | Medium | Low | ⭐⭐⭐⭐ | 2-3h | ✅ |
| 6. Enable TLS for NATS | High | Low | ⭐⭐⭐⭐⭐ | 2-4h | ✅ |
| 7. Audit Logging | High | Low | ⭐⭐⭐⭐⭐ | 4-6h | ✅ |
| 8. ClickHouse Backup | High | Low | ⭐⭐⭐⭐⭐ | 3-4h | ✅ |
| 9. Runbook Documentation | Medium | Low | ⭐⭐⭐⭐ | 3-4h | ⬜ |
| **Critical Path** |
| 10. Cold Storage Archive | Critical | Medium | ⭐⭐⭐⭐⭐ | 1-2d | ✅ |
| 11. Sealed Secrets | High | Medium | ⭐⭐⭐⭐ | 4-6h | ✅ |
| 12. Queue-Based Autoscaling | Critical | Medium | ⭐⭐⭐⭐⭐ | 4-6h | ✅ |
| 13. Monitoring Stack | Critical | High | ⭐⭐⭐⭐⭐ | 2-3d | ⬜ |
| 14. NetworkPolicy & RBAC | High | Medium | ⭐⭐⭐⭐ | 4-6h | ⬜ |
| 15. DR Plan Documentation | High | Medium | ⭐⭐⭐⭐ | 1d | ⬜ |
| **Medium Priority** |
| 16. Multi-Region | High | High | ⭐⭐⭐ | 2-4w | ⬜ |
| 17. Encryption at Rest | High | Medium | ⭐⭐⭐ | 1w | ⬜ |
| 18. API Gateway | Medium | Medium | ⭐⭐ | 1-2w | ⬜ |
| 19. Load Testing | Medium | Medium | ⭐⭐⭐ | 1w | ⬜ |
| 20. Feature Flags | Medium | Medium | ⭐⭐ | 1w | ⬜ |

---

## 🎯 Recommended Implementation Order

### Week 1: Quick Wins Blitz
**Goal:** Fix glaring security issues, establish baseline protections

**Day 1-2:**
1. ✅ Webhook Strict Validation (1h) - COMPLETED
2. ✅ Graceful Error Messages (2h) - COMPLETED
3. ✅ Request Validation Middleware (3h) - COMPLETED
4. ✅ Stuck Batch Detector (45m) - COMPLETED (2026-01-17)
5. ✅ ClickHouse Backup Script (4h) - COMPLETED

**Day 3-5:**
6. ✅ Webhook Timeout/Retry (3h) - COMPLETED (2026-01-17)
7. ✅ Enable TLS for NATS (4h) - COMPLETED (2026-01-17)
8. ✅ Audit Logging (6h) - COMPLETED (2026-01-17)
9. ⬜ Runbook Documentation (4h)

**Outcome:** 9 improvements, ~27 hours effort, dramatically improved security posture

---

### Week 2-3: Critical Infrastructure
**Goal:** Monitoring, backups, disaster recovery, autoscaling

**Week 2:**
1. ⬜ Cold Storage Archive to S3 (2 days)
2. ⬜ Queue-Based Autoscaling (6h)
3. ⬜ Sealed Secrets Implementation (6h)

**Week 3:**
4. ⬜ Monitoring Stack (Prometheus + Grafana + Alerts) (3 days)
5. ⬜ NetworkPolicy & RBAC (6h)
6. ⬜ DR Plan Documentation (1 day)

**Outcome:** Production-grade observability, backups, security, and proper autoscaling

---

### Month 2: Hardening
1. Encryption at Rest (all data stores)
2. Load Testing & Performance Benchmarking
3. API Gateway with DDoS protection
4. Feature Flags for safe rollouts

---

### Month 3: Resilience
1. Multi-region deployment
2. Database replication
3. Automated failover testing
4. Compliance audit (SOC2/GDPR prep)

---

## 📈 Success Metrics

Track these KPIs to measure production readiness:

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Backup Coverage | 30% | 100% | 🔴 |
| Encryption (transit) | 50% | 100% | 🟡 |
| Encryption (rest) | 33% | 100% | 🔴 |
| Monitoring Coverage | 20% | 90% | 🔴 |
| Alert Coverage | 10% | 100% | 🔴 |
| DR Test Frequency | Never | Quarterly | 🔴 |
| Security Audit | Never | Passed | 🔴 |
| Uptime SLA | N/A | 99.9% | 🔴 |
| MTTR (incidents) | Unknown | <4h | 🔴 |
| RPO (data loss) | Unknown | <15min | 🔴 |
| **Performance Baselines** |
| Email Send Rate | Unknown | >100/sec | 🔴 |
| Batch Completion (10k) | Unknown | <5 min | 🔴 |
| Webhook Processing p95 | Unknown | <100ms | 🔴 |
| Queue Depth Alert | Never | <10k msgs | 🔴 |
| Consumer Health | Unknown | <100 stale | 🔴 |

---

## 💰 Cost Estimates

| Item | Monthly Cost | One-Time Cost |
|------|--------------|---------------|
| S3 Cold Storage (100GB) | $5 | - |
| Sealed Secrets | $0 | $0 |
| Monitoring Stack (self-hosted) | $0 | - |
| Multi-region (2nd region) | +$50-100 | - |
| API Gateway (Kong/Traefik) | $0 | - |
| Load Testing (k6 Cloud) | $0-50 | - |
| **Total** | **~$55-155** | **$0** |

Most improvements are **free** (open source tools). Main costs are infrastructure for redundancy.

---

## 🚧 Implementation Notes

### Testing Strategy
For each item:
1. ✅ Implement in local dev environment first
2. ✅ Deploy to staging with synthetic load
3. ✅ Run for 24 hours, monitor for issues
4. ✅ Document rollback procedure
5. ✅ Deploy to production during low-traffic window

### Rollback Plans
- Keep previous K8s manifests in git
- Use `kubectl rollout undo` for quick reverts
- Database migrations: Always reversible
- Feature flags: Instant disable without redeployment

### Communication
- Notify users 48h before major changes
- Status page for incidents
- Changelog for all production updates

### Technical Debt (Post-Launch)
Track these for future cleanup:
- Event logging consolidation (scattered across files)
- Batch completion deduplication
- Webhook handler extraction to reduce duplication
- These can be addressed during stabilization phase

---

## 📚 References

- **NATS Security:** https://docs.nats.io/running-a-nats-service/configuration/securing_nats/tls
- **Sealed Secrets:** https://github.com/bitnami-labs/sealed-secrets
- **kube-prometheus-stack:** https://github.com/prometheus-operator/kube-prometheus
- **ClickHouse Backup:** https://clickhouse.com/docs/en/operations/backup
- **Kubernetes NetworkPolicy:** https://kubernetes.io/docs/concepts/services-networking/network-policies/
- **Prometheus Adapter:** https://github.com/kubernetes-sigs/prometheus-adapter

---

## Status Tracking

- [x] Week 1 Quick Wins (8/9 completed - 89%)
- [x] Week 2-3 Critical Infrastructure (3/6 completed - 50%)
- [ ] Month 2 Hardening (0/4 completed)
- [ ] Month 3 Resilience (0/4 completed)

**Total Items:** 23
**Completed:** 11
**Progress:** 48%

**Last Updated:** 2026-01-17
**Next Review:** 2026-01-20

---

## 📋 Production TODO (Added 2026-01-13)

### Automated Backup CronJob
Set up K8s CronJob to run daily backups automatically:
```yaml
# k8s/base/clickhouse/backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: clickhouse-backup
spec:
  schedule: "0 3 * * *"  # Daily at 3 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: clickhouse/clickhouse-server:24-alpine
            command: ["/bin/sh", "-c"]
            args:
              - clickhouse-client --host clickhouse --query "BACKUP DATABASE default TO S3('...', '...', '...')"
          restartPolicy: OnFailure
```