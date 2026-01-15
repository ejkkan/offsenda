# Production Readiness Checklist

**Created:** 2026-01-13
**Status:** 📋 Under Review
**Priority:** CRITICAL - Required before production launch

---

## Executive Summary

Current production configuration is **60% ready**. Core infrastructure (K8s, NATS, PostgreSQL) is solid, but critical gaps exist in:
- ❌ **Cold Storage & Backups** - Data loss risk
- ❌ **Encryption & Security** - Compliance violations
- ❌ **Disaster Recovery** - Single point of failure
- ⚠️ **Monitoring & Alerting** - Limited visibility

This document prioritizes fixes by **Impact × Ease**, highlighting quick wins that dramatically improve resilience.

---

## ✅ Completed (2026-01-13)

### 6. Webhook Signature Strict Validation (1 hour) 🔐
**Completed:** 2026-01-13
**Files modified:** `apps/worker/src/webhooks.ts:114-131`

Fixed security vulnerability where webhook validation would be skipped if signature headers were missing. Now explicitly rejects requests with 401 when signature validation fails or headers are missing in production.

---

### 5. Graceful Error Messages (2 hours) 🎭
**Completed:** 2026-01-13
**Files modified:** `apps/worker/src/index.ts:20-46`

Added global error handler that prevents stack trace leakage in production. Logs full error details internally while returning sanitized messages to clients. Development mode still shows full error details for debugging.

---

### 2. Request Validation Middleware (2-3 hours) 🛡️
**Completed:** 2026-01-13
**Files modified:** `apps/worker/src/index.ts:48-109`, `apps/worker/src/config.ts:47-49`

Implemented comprehensive request validation:
- Request size limits (10MB default, configurable via `MAX_REQUEST_SIZE_BYTES`)
- IP-based rate limiting (100 req/min per IP, configurable via `RATE_LIMIT_PER_IP`)
- Content-Type validation for POST/PUT/PATCH requests
- Automatic cleanup of expired rate limit entries

**Progress:** 3/7 Quick Wins completed (43%)

---

## 🎯 Quick Wins (Remaining)

These are **high-impact, low-effort** improvements you can implement TODAY or this week:

### 1. Enable TLS for NATS (2-4 hours) 🔒
**Impact:** HIGH | **Effort:** LOW | **Risk:** Medium

**Why:** Encrypts all message traffic between workers and NATS. Currently unencrypted.

**Implementation:**
```yaml
# k8s/base/nats/statefulset.yaml
- name: nats
  args:
    - "--tls"
    - "--tlscert=/etc/nats-tls/tls.crt"
    - "--tlskey=/etc/nats-tls/tls.key"
```

**Files to modify:**
- `k8s/base/nats/statefulset.yaml`
- `k8s/base/nats/certificate.yaml` (create)
- `apps/worker/src/nats/client.ts` (update connection URL to `tls://`)

**Testing:** Verify workers can connect after deployment

---

### 2. Implement Audit Logging (4-6 hours) 📝
**Impact:** HIGH | **Effort:** LOW | **Risk:** Low

**Why:** Track all sensitive operations for security and debugging

**Implementation:**
```typescript
// New file: apps/worker/src/audit.ts
export async function logAudit(event: {
  action: string;
  userId: string;
  resource: string;
  metadata?: Record<string, any>;
}) {
  // Log to ClickHouse audit_log table
  // Include timestamp, IP, user agent
}
```

**Files to modify:**
- `apps/worker/src/audit.ts` (create)
- `apps/worker/src/api.ts` (add audit calls)
- `k8s/base/clickhouse/init-configmap.yaml` (add audit_log table)

---

### 3. Add ClickHouse Backup Script (3-4 hours) 💾
**Impact:** HIGH | **Effort:** LOW | **Risk:** Low

**Why:** Prevents catastrophic data loss. Currently NO backups exist.

**Implementation:**
```bash
#!/bin/bash
# scripts/backup-clickhouse.sh
kubectl exec clickhouse-0 -- clickhouse-client --query="BACKUP DATABASE default TO S3('s3://bucket/backup', 'key', 'secret')"
```

**Files to create:**
- `scripts/backup-clickhouse.sh`
- `k8s/base/cronjob-backup.yaml` (run daily at 2 AM)
- Update `k8s/base/kustomization.yaml`

**Testing:** Run manual backup, verify S3 upload

---

### 4. Document Runbook for Common Issues (3-4 hours) 📖
**Impact:** MEDIUM | **Effort:** LOW | **Risk:** None

**Why:** Reduce MTTR (mean time to recovery) during incidents

**Create:**
- `docs/runbooks/stuck-batches.md`
- `docs/runbooks/nats-connection-loss.md`
- `docs/runbooks/database-slow-queries.md`
- `docs/runbooks/high-error-rate.md`

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

### 8. Implement Cold Storage Archive (1-2 days) ❄️
**Impact:** CRITICAL | **Effort:** MEDIUM | **Risk:** Medium

**Why:** Current TTL DELETES data. Need archival to S3 for compliance and cost.

**Implementation:**
1. Create S3 bucket for archives
2. Modify ClickHouse TTL to move to S3 instead of delete:
   ```sql
   TTL event_date + INTERVAL 90 DAY TO DISK 's3'
   ```
3. Configure ClickHouse S3 disk in `k8s/base/clickhouse/config.yaml`
4. Test restoration from archive

**Files to modify:**
- `k8s/base/clickhouse/config-configmap.yaml` (add S3 disk config)
- `k8s/base/clickhouse/init-configmap.yaml` (change TTL policy)
- `k8s/base/clickhouse/statefulset.yaml` (add S3 credentials)

**Cost:** ~$5/month for 100GB archived data

---

### 9. Set Up Sealed Secrets (4-6 hours) 🔐
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

### 10. Implement Monitoring Stack (2-3 days) 📊
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
4. Configure alerts:
   - High error rate (>5%)
   - Stuck batches (>15 min processing)
   - NATS queue backup (>10k messages)
   - Worker pod crashes
   - High API latency (p95 >500ms)

**Files to create:**
- `k8s/monitoring/prometheus-servicemonitor.yaml`
- `k8s/monitoring/grafana-dashboard.json`
- `k8s/monitoring/alertmanager-config.yaml`

**Integration needed:**
- `apps/worker/src/api.ts` - Expose `/metrics` endpoint (already exists ✓)
- Add prom-client library
- Instrument critical paths

---

### 11. Add NetworkPolicy & RBAC (4-6 hours) 🛡️
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

### 12. Document RTO/RPO & DR Plan (1 day) 📋
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

### 13. Multi-Region Deployment (2-4 weeks)
**Impact:** HIGH | **Effort:** HIGH | **Risk:** High

**Why:** Single region = single point of failure

**Strategy:**
- Primary: Hetzner (current)
- Secondary: AWS us-east-1 or eu-west-1
- Database: PostgreSQL read replica in secondary region
- DNS: Route53 with health checks for automatic failover

---

### 14. Encryption at Rest (1 week)
**Impact:** HIGH | **Effort:** MEDIUM | **Risk:** Medium

**Components:**
- NATS: Enable encryption via `store_cipher = "chacha"`
- ClickHouse: Enable encryption via `<encryption_codecs>`
- PostgreSQL: Neon already supports (verify enabled)

---

### 15. API Gateway / Rate Limiting (1-2 weeks)
**Impact:** MEDIUM | **Effort:** MEDIUM | **Risk:** Medium

**Why:** DDoS protection, better rate limiting, API versioning

**Options:**
- Kong Gateway
- Traefik with rate limit middleware
- NGINX Ingress with rate limit annotations

---

### 16. Load Testing & Benchmarking (1 week)
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

### 17. Feature Flags System (1 week)
**Impact:** MEDIUM | **Effort:** MEDIUM | **Risk:** Low

**Why:** Safe rollouts, A/B testing, instant rollback

**Options:**
- LaunchDarkly (SaaS, expensive)
- Unleash (self-hosted, free)
- Simple env var toggles

---

## 📊 Priority Matrix

| Task | Impact | Effort | Priority Score | Status | Time |
|------|--------|--------|----------------|--------|------|
| **Quick Wins** |
| ~~6. Webhook Strict Validation~~ | Medium | Low | ⭐⭐⭐⭐⭐ | ✅ DONE | 1h |
| ~~5. Graceful Error Messages~~ | Medium | Low | ⭐⭐⭐⭐⭐ | ✅ DONE | 2h |
| ~~2. Request Validation~~ | Medium | Low | ⭐⭐⭐⭐ | ✅ DONE | 2-3h |
| 4. Runbook Documentation | Medium | Low | ⭐⭐⭐⭐ | 🔲 TODO | 3-4h |
| 1. Enable TLS for NATS | High | Low | ⭐⭐⭐⭐⭐ | 🔲 TODO | 2-4h |
| 2. Audit Logging | High | Low | ⭐⭐⭐⭐⭐ | 🔲 TODO | 4-6h |
| 3. ClickHouse Backup | High | Low | ⭐⭐⭐⭐⭐ | 🔲 TODO | 3-4h |
| **Critical Path** |
| 8. Cold Storage Archive | Critical | Medium | ⭐⭐⭐⭐⭐ | 1-2d |
| 9. Sealed Secrets | High | Medium | ⭐⭐⭐⭐ | 4-6h |
| 11. NetworkPolicy & RBAC | High | Medium | ⭐⭐⭐⭐ | 4-6h |
| 12. DR Plan Documentation | High | Medium | ⭐⭐⭐⭐ | 1d |
| 10. Monitoring Stack | Critical | High | ⭐⭐⭐⭐⭐ | 2-3d |
| **Medium Priority** |
| 14. Encryption at Rest | High | Medium | ⭐⭐⭐ | 1w |
| 16. Load Testing | Medium | Medium | ⭐⭐⭐ | 1w |
| 17. Feature Flags | Medium | Medium | ⭐⭐ | 1w |
| 15. API Gateway | Medium | Medium | ⭐⭐ | 1-2w |
| 13. Multi-Region | High | High | ⭐⭐⭐ | 2-4w |

---

## 🎯 Recommended Implementation Order

### Week 1: Quick Wins Blitz
**Goal:** Fix glaring security issues, establish baseline protections

**Day 1-2 (COMPLETED ✅):**
1. ✅ Webhook Strict Validation (1h) - DONE 2026-01-13
2. ✅ Graceful Error Messages (2h) - DONE 2026-01-13
3. ✅ Request Validation Middleware (3h) - DONE 2026-01-13
4. ⬜ ClickHouse Backup Script (4h) - TODO

**Day 3-5:**
5. ⬜ Enable TLS for NATS (4h) - TODO
6. ⬜ Audit Logging (6h) - TODO
7. ⬜ Runbook Documentation (4h) - TODO

**Progress:** 3/7 completed (43%), ~6 hours invested
**Outcome:** 7 improvements total planned, ~24 hours effort, will dramatically improve security posture

---

### Week 2-3: Critical Infrastructure
**Goal:** Monitoring, backups, disaster recovery

**Week 2:**
1. ✅ Cold Storage Archive to S3 (2 days)
2. ✅ Sealed Secrets Implementation (6h)
3. ✅ NetworkPolicy & RBAC (6h)

**Week 3:**
4. ✅ Monitoring Stack (Prometheus + Grafana + Alerts) (3 days)
5. ✅ DR Plan Documentation (1 day)

**Outcome:** Production-grade observability, backups, and security

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

---

## 📚 References

- **NATS Security:** https://docs.nats.io/running-a-nats-service/configuration/securing_nats/tls
- **Sealed Secrets:** https://github.com/bitnami-labs/sealed-secrets
- **kube-prometheus-stack:** https://github.com/prometheus-operator/kube-prometheus
- **ClickHouse Backup:** https://clickhouse.com/docs/en/operations/backup
- **Kubernetes NetworkPolicy:** https://kubernetes.io/docs/concepts/services-networking/network-policies/

---

## Status Tracking

- [x] **Quick Wins: 3/7 completed (43%)** ✅
  - [x] Webhook Signature Strict Validation
  - [x] Graceful Error Messages
  - [x] Request Validation Middleware
  - [ ] Runbook Documentation
  - [ ] Enable TLS for NATS
  - [ ] Audit Logging
  - [ ] ClickHouse Backup
- [ ] Week 2-3 Critical Infrastructure (0/5 completed)
- [ ] Month 2 Hardening (0/4 completed)
- [ ] Month 3 Resilience (0/4 completed)

**Last Updated:** 2026-01-13 (3 items completed today)
**Next Review:** 2026-01-20
