# Local vs Production: What's Different & What's Automated

## TL;DR Current State

| Aspect | Local (k3d) | Production (Hetzner) | Automation Level |
|--------|-------------|----------------------|------------------|
| **Startup** | `pnpm dev` | Manual commands | ✅ Local automated, ❌ Prod manual |
| **Cluster** | k3d (auto-created) | Hetzner K8s or Docker | ✅ Local automated, ❌ Prod manual |
| **KEDA** | Auto-installed | NOT configured yet | ✅ Local automated, ❌ Prod missing |
| **Configs** | overlays/local/ | overlays/production/ | ✅ Both use Kustomize |
| **Secrets** | Generated from .env | Manual creation | ✅ Local automated, ❌ Prod manual |
| **Monitoring** | Optional | NOT configured | ❌ Both manual |
| **Scaling** | 1-5 workers (KEDA) | 2-50 workers (HPA, needs KEDA) | ✅ Local works, ⚠️ Prod broken |

---

## 🔴 MAJOR ISSUE: Production Config is Outdated

Your `k8s/overlays/production/kustomization.yaml` still references:
```yaml
target:
  kind: HorizontalPodAutoscaler  # ❌ OLD - conflicts with KEDA
  name: worker-hpa
```

**This is broken!** It should use KEDA ScaledObject, not HPA.

---

## Local vs Production Differences

### 1. **Cluster Setup**

#### Local (k3d):
```bash
# Fully automated by dev-k8s.sh:
k3d cluster create batchsender \
  --servers 1 \
  --agents 3 \
  --port "6001:80@loadbalancer"
```

#### Production (Hetzner):
```bash
# MANUAL STEPS (not automated):
# 1. Go to Hetzner console
# 2. Create server (CX22, Ubuntu 24.04)
# 3. SSH into server
# 4. Install Docker:
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh

# 5. Clone repo:
git clone <repo> /opt/batchsender

# 6. Run Docker Compose:
cd /opt/batchsender/deploy
docker compose up -d
```

**Problem:** DEPLOY.md describes Docker Compose approach, but you have K8s configs ready!

---

### 2. **Configuration Overlays**

#### Local (`k8s/overlays/local/`):
```yaml
# Optimized for local dev:
- 1 NATS node (not 3)
- 1-5 workers (not 2-50)
- local-path storage (not hcloud-volumes)
- 1Gi storage (not 20Gi)
- Lower memory limits
```

#### Production (`k8s/overlays/production/`):
```yaml
# Optimized for production:
- 3 NATS nodes (HA cluster)
- 2-50 workers (autoscale)
- hcloud-volumes storage (Hetzner)
- 20-50Gi storage
- Higher memory limits

# ❌ BUT: Still references worker-hpa (should be KEDA)
```

---

### 3. **What's Automated vs Manual**

| Task | Local | Production | Can Be Automated? |
|------|-------|------------|-------------------|
| **Cluster creation** | ✅ Automated (dev-k8s.sh) | ❌ Manual (Hetzner console) | ⚠️ Semi (terraform) |
| **Install kubectl/helm** | ✅ Pre-installed | ❌ Manual (`apt install`) | ✅ Yes (bootstrap script) |
| **Install KEDA** | ✅ Automated (dev-k8s.sh) | ❌ Not done | ✅ Yes (deploy script) |
| **Apply configs** | ✅ Automated (skaffold) | ❌ Manual (`kubectl apply`) | ✅ Yes (deploy script) |
| **Generate secrets** | ✅ Automated (from .env) | ❌ Manual (`kubectl create secret`) | ⚠️ Semi (Sealed Secrets) |
| **Set up monitoring** | ❌ Manual | ❌ Manual | ✅ Yes (helm charts) |
| **Database migrations** | ✅ Automated (`pnpm db:push`) | ❌ Manual | ✅ Yes (init container) |
| **Backups** | ❌ Not needed | ❌ Manual setup | ✅ Yes (already have CronJob) |

---

## 🚨 Manual Commands That SHOULD Be Automated

### Production Deployment Currently:

```bash
# ❌ ALL MANUAL:

# 1. Server setup (20 commands)
ssh root@server
apt update && apt upgrade -y
apt install -y kubectl helm docker.io
curl -fsSL https://get.docker.com | sh

# 2. Install K8s tools
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl && mv kubectl /usr/local/bin/

# 3. Clone repo
git clone <repo> /opt/batchsender
cd /opt/batchsender

# 4. Create secrets manually
kubectl create namespace batchsender
kubectl create secret generic worker-secrets \
  --from-literal=DATABASE_URL=xxx \
  --from-literal=RESEND_API_KEY=xxx \
  --from-literal=WEBHOOK_SECRET=xxx \
  -n batchsender

# 5. Install KEDA manually
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda --namespace keda --create-namespace

# 6. Apply configs
kubectl apply -k k8s/overlays/production

# 7. Set up monitoring
helm install prometheus prometheus-community/prometheus
helm install grafana grafana/grafana

# 8. Configure ingress/DNS manually
# 9. Set up SSL certificates manually
# 10. Configure backups manually
```

**Total: ~50+ manual commands** 😱

---

## ✅ What SHOULD Be Automated (Production Deploy Script)

Create `deploy-production.sh` (similar to `dev-k8s.sh`):

```bash
#!/bin/bash
# deploy-production.sh - One-command production deployment

# Prerequisites check
check_tools  # kubectl, helm, etc.

# Load production .env
source .env.prod

# Install KEDA (if not installed)
install_keda

# Create namespace
kubectl create namespace batchsender --dry-run=client -o yaml | kubectl apply -f -

# Generate secrets from .env.prod (or use Sealed Secrets)
generate_secrets

# Apply production configs
kubectl apply -k k8s/overlays/production

# Install monitoring stack (optional)
if [ "$INSTALL_MONITORING" = "true" ]; then
  install_monitoring
fi

# Wait for all pods ready
kubectl wait --for=condition=ready pod --all -n batchsender --timeout=5m

# Display status
kubectl get pods -n batchsender
echo "✅ Production deployment complete!"
echo "Worker: http://<your-domain>:6001/health"
```

---

## Configuration Files That Need Fixing

### 1. ❌ `k8s/overlays/production/kustomization.yaml`

**Current (BROKEN):**
```yaml
patches:
  # ❌ References HPA (conflicts with KEDA)
  - patch: |-
      - op: replace
        path: /spec/maxReplicas
        value: 50
    target:
      kind: HorizontalPodAutoscaler  # ❌ WRONG!
      name: worker-hpa
```

**Should be:**
```yaml
patches:
  # ✅ Configure KEDA ScaledObject
  - patch: |-
      - op: replace
        path: /spec/maxReplicaCount
        value: 50
      - op: replace
        path: /spec/minReplicaCount
        value: 2
    target:
      kind: ScaledObject  # ✅ CORRECT!
      name: worker-scaler
```

---

### 2. ❌ `DEPLOY.md` - Describes Wrong Approach

**Current:** Describes Docker Compose deployment (old)
**Should:** Describe Kubernetes deployment with automated script

---

### 3. ❌ No Production Deploy Script

**Missing:** `deploy-production.sh` to automate all manual steps
**Exists for local:** `dev-k8s.sh` fully automated

---

## Root of the Same?

### YES for Configs:
- ✅ Both use Kustomize (base + overlays)
- ✅ Both use same base K8s manifests
- ✅ Both use KEDA (but production config needs fixing)
- ✅ Both use same Docker images (just different registries)

### NO for Setup Process:
- ✅ Local: Fully automated (`pnpm dev`)
- ❌ Production: ~50 manual commands

---

## What Needs to Be Done

### Immediate (Fix Production Configs):

1. **Fix production overlay to use KEDA:**
   ```bash
   # Edit k8s/overlays/production/kustomization.yaml
   # Change HorizontalPodAutoscaler → ScaledObject
   ```

2. **Create production deploy script:**
   ```bash
   # Create deploy-production.sh (like dev-k8s.sh but for prod)
   ```

3. **Update DEPLOY.md:**
   ```bash
   # Change from Docker Compose to K8s instructions
   ```

4. **Add Sealed Secrets config:**
   ```bash
   # For secure secret management in git
   ```

### Nice to Have (Further Automation):

5. **Terraform for infrastructure:**
   ```bash
   # Auto-create Hetzner server, install tools
   ```

6. **CI/CD pipeline:**
   ```bash
   # GitHub Actions to deploy on push
   ```

7. **Monitoring automation:**
   ```bash
   # Helm values in config, auto-install Prometheus/Grafana
   ```

---

## Recommended: Create Production Deploy Script

Want me to create `deploy-production.sh` that:
- ✅ Checks prerequisites (kubectl, helm, etc.)
- ✅ Loads secrets from `.env.prod`
- ✅ Installs KEDA automatically
- ✅ Applies production configs
- ✅ Optionally installs monitoring
- ✅ Waits for deployment to be ready
- ✅ Shows status and URLs

**Just like `dev-k8s.sh` but for production!**

This would reduce deployment from ~50 commands to:
```bash
./deploy-production.sh
```

---

## Summary

### Current State:
- ✅ **Local:** Fully automated, works great
- ❌ **Production:** Broken config (HPA vs KEDA), many manual steps

### What's the Same:
- ✅ Base K8s configs (k8s/base/)
- ✅ Kustomize approach (overlays)
- ✅ KEDA for scaling (needs production fix)

### What's Different:
- Scale (1-5 vs 2-50 workers)
- Storage (1Gi vs 20Gi)
- Resources (lower vs higher)
- Setup process (automated vs manual)

### Can Be Automated:
- ✅ Production config fixes (5 min)
- ✅ Production deploy script (30 min to write)
- ✅ Monitoring installation (helm charts)
- ⚠️ Infrastructure creation (terraform - longer)

**Want me to fix production configs and create automated deploy script?**
