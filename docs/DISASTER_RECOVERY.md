# Disaster Recovery Plan - BatchSender

**Last Updated:** 2026-01-17
**RTO Target:** 4 hours
**RPO Target:** 15 minutes (PostgreSQL) / 24 hours (ClickHouse)

---

## Overview

This document details how to recover BatchSender from various failure scenarios.

| Failure Type | Recovery Time | Data Loss |
|--------------|---------------|-----------|
| Single pod crash | < 5 min (automatic) | None |
| Database corruption | < 4 hours | Up to 24h |
| Entire cluster failure | < 4 hours | Up to 24h |

---

## Critical Systems & Backup Strategy

### 1. PostgreSQL (Neon Database)

**Purpose:** User accounts, batch metadata, send configurations

| Attribute | Value |
|-----------|-------|
| Provider | Neon (managed) |
| Backups | Automatic hourly |
| Retention | 7 days |
| Recovery | Point-in-time restore |

**Recovery Procedure:**
```bash
# Via Neon console:
# 1. Go to Project → Database → Branches → Recovery
# 2. Select timestamp to restore to
# 3. Click "Restore"
# 4. Update DATABASE_URL in sealed secrets if needed
# 5. Restart worker pods
kubectl rollout restart deployment/worker -n batchsender
```

### 2. ClickHouse (Analytics Database)

**Purpose:** Email events, audit logs, analytics data

| Attribute | Value |
|-----------|-------|
| Backups | Daily at 3 AM UTC |
| Location | Backblaze B2 |
| Retention | 30 days |
| Cold Storage | Data older than 1 day → B2 |

**Recovery Procedure:**
```bash
# 1. List available backups
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  SELECT name, status, start_time
  FROM system.backups
  WHERE status = 'BACKUP_COMPLETE'
  ORDER BY start_time DESC LIMIT 10"

# 2. Restore specific backup
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  RESTORE DATABASE default FROM S3(
    'https://s3.eu-central-003.backblazeb2.com/batchsender-clickhouse-cold/backups/<backup-name>/',
    '<B2_KEY_ID>',
    '<B2_APP_KEY>'
  )"

# 3. Verify
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  SELECT count() FROM email_events"
```

### 3. NATS JetStream (Message Queue)

**Purpose:** Batch job queue, message ordering

| Attribute | Value |
|-----------|-------|
| Type | Transient (rebuilds on restart) |
| Backups | None needed |
| Recovery | Automatic |

**Recovery:** Pod restart automatically recovers. Queued messages may be lost but batches can be retried.

### 4. Dragonfly (Rate Limiting)

**Purpose:** Distributed rate limiting cache

| Attribute | Value |
|-----------|-------|
| Type | Ephemeral |
| Recovery | Automatic (state rebuilds) |

---

## Failure Scenarios

### Scenario 1: Single Worker Pod Crashes

**Symptoms:** One worker in CrashLoopBackOff, other workers still processing

**Recovery:** Automatic (K8s restarts pod within 1-5 minutes)

```bash
# Monitor recovery
kubectl get pods -n batchsender -l app=worker -w

# Check logs if stuck
kubectl logs -f deployment/worker -n batchsender
kubectl describe pod <pod-name> -n batchsender
```

### Scenario 2: ClickHouse Data Corruption

**Symptoms:** Query errors, audit queries failing

**Recovery:**
```bash
# 1. Check backup status
kubectl logs job/clickhouse-backup -n batchsender

# 2. Restore from backup (see ClickHouse section above)

# 3. Verify data
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  SELECT count() FROM email_events;
  SELECT count() FROM audit_log;"
```

### Scenario 3: NATS Connection Loss

**Symptoms:** Workers can't publish, queue not processing

**Recovery:**
```bash
# 1. Check NATS status
kubectl get pod nats-0 -n batchsender
kubectl logs nats-0 -n batchsender

# 2. Restart if needed
kubectl delete pod nats-0 -n batchsender

# 3. Wait for ready
kubectl wait --for=condition=ready pod -l app=nats -n batchsender --timeout=60s
```

### Scenario 4: Entire Cluster Failure

**Symptoms:** All pods unreachable, cluster down

**Recovery:**
```bash
# 1. Recreate cluster
source .env.hetzner
hetzner-k3s create --config cluster-config.yaml

# 2. Bootstrap infrastructure
./scripts/bootstrap-infrastructure.sh

# 3. Deploy application
kubectl apply -k k8s/overlays/production

# 4. Restore databases
# - PostgreSQL: Neon PITR (automatic)
# - ClickHouse: Restore from B2 backup

# 5. Update GitHub secrets with new kubeconfig
base64 -i kubeconfig
# Update KUBECONFIG secret in GitHub
```

**Total RTO:** ~4 hours

---

## Backup Verification

### Monthly DR Test
1. Document current record counts
2. Create test backup
3. Restore to staging cluster
4. Verify data integrity
5. Document results

```bash
# Trigger manual backup
kubectl create job --from=cronjob/clickhouse-backup \
  clickhouse-backup-test -n batchsender

# Wait for completion
kubectl wait --for=condition=complete job/clickhouse-backup-test \
  -n batchsender --timeout=600s
```

---

## Contacts & Escalation

| Service | Support |
|---------|---------|
| Hetzner | console.hetzner.cloud → Support |
| Neon | support@neon.tech |
| Backblaze | support.backblaze.com |

---

## See Also

- [Runbook: Stuck Batches](runbooks/stuck-batches.md)
- [Runbook: NATS Connection Loss](runbooks/nats-connection-loss.md)
- [Runbook: High Error Rate](runbooks/high-error-rate.md)
- [Runbook: Database Slow Queries](runbooks/database-slow-queries.md)
