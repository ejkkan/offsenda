# Production Deployment Guide

This guide covers deploying BatchSender to production on Hetzner Kubernetes using **hetzner-k3s** - a production-ready k3s cluster that deploys in just 2-3 minutes with full GitOps automation.

## Why hetzner-k3s?

- ✅ **No Packer snapshots needed** (unlike kube-hetzner/Terraform)
- ✅ **3-minute cluster creation** (vs 15-20 min with Terraform)
- ✅ **Production-ready HA** across 3 datacenters
- ✅ **Autoscaling included** out-of-the-box
- ✅ **Single YAML config** - no Terraform state management

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start (30 minutes total)](#quick-start-30-minutes-total)
- [Initial Setup (Step-by-Step)](#initial-setup-step-by-step)
- [Daily Operations (GitOps)](#daily-operations-gitops)
- [Accessing Services](#accessing-services)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Local Tools

Install these on your laptop:

```bash
# macOS
brew tap vitobotta/tap
brew install vitobotta/tap/hetzner_k3s kubectl helm kubeseal

# Linux
# Download hetzner-k3s from: https://github.com/vitobotta/hetzner-k3s/releases
# Install kubectl, helm, kubeseal from official sites
```

### Hetzner Account

1. Create account at https://console.hetzner.cloud
2. Create project: `batchsender`
3. Go to **Security → API Tokens**
4. Generate token with **Read & Write** permissions
5. Save the token

### Environment File

Create `.env.prod` in project root:

```bash
# .env.prod (DO NOT commit to Git!)

# PostgreSQL (Neon)
DATABASE_URL=postgresql://user:pass@your-neon-instance.neon.tech/batchsender

# Email Provider
RESEND_API_KEY=re_xxxxxxxxxxxxx

# Worker
WEBHOOK_SECRET=your_random_secret_here
NODE_ENV=production

# ClickHouse
CLICKHOUSE_PASSWORD=create_a_strong_password_here
CLICKHOUSE_USER=default
CLICKHOUSE_DATABASE=batchsender

# Backblaze B2 (for ClickHouse backups)
B2_KEY_ID=your_b2_key_id
B2_APP_KEY=your_b2_app_key
B2_BUCKET=batchsender-clickhouse-backups
```

---

## Quick Start (30 minutes total)

For the impatient - here's the TL;DR:

```bash
# 1. Create cluster (3 min)
hetzner-k3s create --config cluster-config.yaml

# 2. Install infrastructure (10 min)
./scripts/bootstrap-infrastructure.sh

# 3. Deploy app (5 min)
./scripts/seal-secrets.sh
export KUBECONFIG=./kubeconfig
kubectl apply -k k8s/overlays/production
./scripts/verify-deployment.sh

# 4. Set up CI/CD (10 min)
base64 -i kubeconfig  # Add to GitHub Secrets
git push origin main   # Test automated deployment
```

✅ **Done!** Production-ready Kubernetes with GitOps.

---

## Initial Setup (Step-by-Step)

### Step 1: Create Kubernetes Cluster (3 minutes!)

First, update `cluster-config.yaml` with your Hetzner token:

```bash
# Edit cluster-config.yaml and replace ${HCLOUD_TOKEN} with your actual token
# Or source it from .env.hetzner:
source .env.hetzner
sed -i "s/\${HCLOUD_TOKEN}/$HCLOUD_TOKEN/" cluster-config.yaml
```

Then create the cluster:

```bash
hetzner-k3s create --config cluster-config.yaml
```

This creates:
- **3 master nodes** (High Availability) across 3 datacenters (fsn1, nbg1, hel1)
- **1 worker node** with autoscaling (1-10 nodes)
- **Hetzner Cloud Controller Manager** (load balancers)
- **Hetzner CSI Driver** (persistent storage)
- **Cluster Autoscaler** (automatic node scaling)

**Files created:**
- `./kubeconfig` - Cluster access credentials

### Step 2: Install Infrastructure Components (10 minutes)

```bash
./scripts/bootstrap-infrastructure.sh
```

This installs:
- KEDA (worker autoscaling based on NATS queue)
- Sealed Secrets (secret encryption)
- Prometheus + Grafana (monitoring)
- Metrics Server (CPU/memory metrics)
- cert-manager (SSL certificates)

**Files created:**
- `sealed-secrets-cert.pem` - For encrypting secrets

### Step 3: Encrypt & Deploy Application (5 minutes)

```bash
# Encrypt all secrets from .env.prod
./scripts/seal-secrets.sh

# Set kubectl context
export KUBECONFIG=./kubeconfig

# Deploy all services
kubectl apply -k k8s/overlays/production

# Verify deployment
./scripts/verify-deployment.sh
```

**Expected output:**
```
✓ Namespace 'batchsender' exists
✓ PostgreSQL pod is ready
✓ DragonflyDB pod is ready
✓ NATS pods ready (3/3 replicas)
✓ ClickHouse pod is ready
✓ Worker deployment is available
✓ Worker replicas ready (2)
✓ KEDA ScaledObject is ready
✓ Health endpoint responding
✓ Metrics endpoint responding
```

### Step 4: Set Up GitOps CI/CD (10 minutes)

Add kubeconfig to GitHub Secrets:

```bash
# Encode kubeconfig
base64 -i kubeconfig

# Go to GitHub:
# Settings → Secrets and variables → Actions → New repository secret
# Name: KUBECONFIG
# Value: <paste the base64 output>
```

Test deployment:

```bash
# Make a small change and push
git commit --allow-empty -m "Test CI/CD pipeline"
git push origin main

# Watch deployment
# https://github.com/your-org/batchsender/actions
```

---

## Daily Operations (GitOps)

### Deploying Changes

```bash
# Make changes to code or configs
vim apps/worker/src/something.ts

# Commit and push
git add .
git commit -m "Update feature"
git push origin main

# GitHub Actions automatically:
# 1. Builds Docker image
# 2. Pushes to ghcr.io
# 3. Applies K8s manifests
# 4. Waits for rollout
# 5. Verifies deployment

# No manual kubectl needed!
```

### Updating Secrets

```bash
# Edit .env.prod
vim .env.prod

# Re-encrypt
./scripts/seal-secrets.sh

# Commit and push
git add k8s/base/*/sealed-secrets.yaml
git commit -m "Update production secrets"
git push origin main

# Restart worker to pick up new secrets
kubectl rollout restart deployment/worker -n batchsender
```

### Scaling Configuration

KEDA automatically scales workers based on NATS queue depth:

- **Min replicas:** 2
- **Max replicas:** 50
- **Scale up:** When >1000 messages per worker
- **Scale down:** 30s cooldown after queue is empty

To adjust scaling:

```yaml
# k8s/base/worker/keda-scaledobject.yaml
spec:
  minReplicaCount: 2      # Minimum workers
  maxReplicaCount: 50     # Maximum workers
  triggers:
    - type: nats-jetstream
      metadata:
        lagThreshold: "1000"  # Messages per worker before scaling
```

### Rollback

```bash
# Revert to previous version
git revert <commit-sha>
git push origin main

# Or manually rollback
kubectl rollout undo deployment/worker -n batchsender
```

---

## Accessing Services

### Grafana Dashboards

```bash
# Port-forward Grafana
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80

# Get admin password
kubectl get secret -n monitoring monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d

# Open browser: http://localhost:3000
# Username: admin
# Password: <from above command>
```

**Recommended Dashboards:**
- NATS JetStream: ID 13797
- ClickHouse: ID 14999
- Worker metrics: Custom (use /api/metrics)

### Worker Logs

```bash
# Follow worker logs
kubectl logs -f deployment/worker -n batchsender

# Filter for errors
kubectl logs deployment/worker -n batchsender | grep ERROR

# Last 100 lines
kubectl logs --tail=100 deployment/worker -n batchsender
```

### ClickHouse Query

```bash
# Connect to ClickHouse
kubectl exec -it clickhouse-0 -n batchsender -- clickhouse-client

# Example queries
SELECT count() FROM email_events;
SELECT status, count() FROM email_events GROUP BY status;
SELECT toDate(timestamp) as date, count() FROM email_events GROUP BY date ORDER BY date DESC LIMIT 7;
```

### NATS Monitoring

```bash
# Port-forward NATS monitor
kubectl port-forward -n batchsender svc/nats 8222:8222

# Open browser: http://localhost:8222
# Or curl: curl http://localhost:8222/varz
```

---

## Troubleshooting

### Pods Not Starting

```bash
# Check pod status
kubectl get pods -n batchsender

# Describe failed pod
kubectl describe pod <pod-name> -n batchsender

# Check events
kubectl get events -n batchsender --sort-by='.lastTimestamp'
```

### Worker Not Scaling

```bash
# Check KEDA ScaledObject
kubectl get scaledobject -n batchsender
kubectl describe scaledobject worker-scaler -n batchsender

# Check KEDA operator logs
kubectl logs -n keda deploy/keda-operator

# Verify NATS metrics endpoint
kubectl exec nats-0 -n batchsender -- curl localhost:8222/metrics
```

### Deployment Stuck

```bash
# Check rollout status
kubectl rollout status deployment/worker -n batchsender

# Check replica sets
kubectl get rs -n batchsender

# Force restart
kubectl rollout restart deployment/worker -n batchsender
```

### Secrets Not Working

```bash
# Verify sealed secret exists
kubectl get sealedsecret -n batchsender

# Check if secret was created
kubectl get secret worker-secrets -n batchsender

# Describe sealed secret
kubectl describe sealedsecret worker-secrets -n batchsender

# Check sealed-secrets controller logs
kubectl logs -n kube-system -l app.kubernetes.io/name=sealed-secrets
```

---

## Monitoring & Alerts

See [MONITORING.md](./MONITORING.md) for detailed monitoring setup.

## Operational Procedures

See [RUNBOOK.md](./RUNBOOK.md) for common operational tasks and troubleshooting.

---

## Cost Management

### Current Cost Breakdown

**Hetzner Cloud:**
- Control Plane (1x cx21): ~€5/mo
- Worker Nodes (1-3x cx31): €15-30/mo
- Load Balancer: €5/mo
- **Subtotal: €25-40/mo**

**External Services:**
- Neon PostgreSQL: $0-19/mo
- Backblaze B2: ~€5/mo
- **Subtotal: €5-24/mo**

**Total: €30-64/mo**

### Cost Optimization

```bash
# Reduce minimum workers (off-peak hours)
kubectl patch scaledobject worker-scaler -n batchsender \
  --type='json' -p='[{"op": "replace", "path": "/spec/minReplicaCount", "value": 1}]'

# Scale nodes during low usage
# (Configure auto-scaler in Terraform)
```

---

## Next Steps

- Set up DNS and public API endpoint (see [k8s/ingress/worker-ingress.yaml](k8s/ingress/worker-ingress.yaml))
- Configure alerts in Grafana
- Set up backups (ClickHouse CronJob already configured)
- Review security policies (NetworkPolicy, RBAC)

---

## Support

For issues or questions:
- Check [RUNBOOK.md](./RUNBOOK.md) for common problems
- Review logs: `kubectl logs -f deployment/worker -n batchsender`
- Check monitoring: Grafana dashboards
- GitHub Issues: https://github.com/your-org/batchsender/issues
