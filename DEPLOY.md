# Production Deployment Guide - BatchSender on Hetzner Kubernetes

**Last Updated:** 2026-01-16
**Status:** ✅ Production cluster running
**Cluster:** 1 master + 2 workers (cpx22, €14/mo)
**Location:** Hetzner Cloud (fsn1 datacenter)

---

## 📊 Current Deployment Status

### ✅ What's Running
- **Cluster**: 1 master + 2 worker nodes (waiting for IP limit increase for 3-master HA)
- **PostgreSQL**: External (Neon Database) - connection working
- **DragonflyDB**: Running (Redis-compatible, distributed rate limiting)
- **NATS JetStream**: Running (message queue, single-node mode)
- **ClickHouse**: Running with production password
- **Worker Pods**: 2 replicas, fully operational
- **KEDA Autoscaling**: Active (scales 2-50 workers based on NATS queue depth)
- **GitOps**: ✅ Push to main → auto-deploy via GitHub Actions

### 🔑 GitHub Secrets Configured
Only 2 secrets needed in GitHub (Settings → Secrets → Actions):
- ✅ `KUBECONFIG` - Base64-encoded kubeconfig file
- ✅ `GH_TOKEN` - Your GitHub personal access token (for pushing Docker images)

**All other secrets** (passwords, API keys) are encrypted in sealed-secrets YAML files in Git!

### 📦 Current Services
```bash
kubectl get pods -n batchsender

NAME                      READY   STATUS    RESTARTS   AGE
clickhouse-0              1/1     Running   0          20m
dragonfly-0               1/1     Running   0          3h
nats-0                    1/1     Running   0          3h
postgres-0                1/1     Running   0          3h
worker-7f59f67cbd-pmdsm   1/1     Running   0          5m
worker-7f59f67cbd-tbnvh   1/1     Running   0          25m
```

### 💰 Current Cost
- **Hetzner**: €14/mo (1 master + 2 workers, cpx22 servers)
- **Neon PostgreSQL**: $0/mo (free tier)
- **Backblaze B2**: ~€0.50/mo (ClickHouse backups, minimal usage)
- **Total**: ~€15/mo

---

## 🚀 Quick Start - Recreate Cluster from Scratch

If you need to recreate the cluster (testing, disaster recovery, or starting fresh), follow these steps:

### Prerequisites
- ✅ `.env.hetzner` file with Hetzner API token
- ✅ `.env.prod` file with production secrets (**CRITICAL - keep this backed up!**)
- ✅ Tools installed: `hetzner-k3s`, `kubectl`, `helm`, `kubeseal`

### Step 1: Create Cluster (3 minutes)
```bash
# Source Hetzner token
source .env.hetzner

# Create cluster
hetzner-k3s create --config cluster-config.yaml

# Verify
export KUBECONFIG=./kubeconfig
kubectl get nodes
```

**Output:**
```
NAME                       STATUS   ROLES                       AGE
batchsender-prod-master1   Ready    control-plane,etcd,master   2m
batchsender-prod-workers-* Ready    <none>                      1m
```

### Step 2: Install Infrastructure (10 minutes)
```bash
./scripts/bootstrap-infrastructure.sh
```

This installs:
- KEDA (worker autoscaling)
- Sealed Secrets (secret encryption)
- Prometheus + Grafana (monitoring)
- Metrics Server (CPU/memory metrics)
- cert-manager (SSL certificates)

### Step 3: Deploy Application (2 minutes)
```bash
export KUBECONFIG=./kubeconfig
kubectl apply -k k8s/overlays/production
```

### Step 4: Update GitHub Secret
```bash
# Encode kubeconfig
base64 -i kubeconfig

# Update GitHub Secret:
# Go to: https://github.com/ejkkan/offsenda/settings/secrets/actions
# Update KUBECONFIG with the new base64 value
```

### Step 5: Verify Deployment
```bash
./scripts/verify-deployment.sh
```

**Total time:** ~15 minutes

---

## 🔄 Tear Down Cluster

To completely destroy the cluster:

```bash
hetzner-k3s delete --config cluster-config.yaml
```

**This will:**
- Delete all Hetzner servers
- Remove all data on those servers
- Clean up Hetzner load balancers
- **Cost drops to €0** (except external services like Neon)

**What's NOT deleted:**
- External PostgreSQL (Neon) - data is safe
- Docker images (ghcr.io) - images are safe
- Your Git repository - everything in Git is safe

---

## 🔐 Important Findings & Gotchas

### 1. Environment Variable Names
**CRITICAL:** The worker code expects specific environment variable names:

```bash
# ❌ WRONG (what we initially used)
REDIS_URL=...
NATS_URL=...
CLICKHOUSE_HOST=...

# ✅ CORRECT (what the code actually reads)
DRAGONFLY_URL=dragonfly.batchsender.svc:6379
NATS_CLUSTER=nats://nats.batchsender.svc:4222
CLICKHOUSE_URL=http://clickhouse.batchsender.svc:8123
```

See `apps/worker/src/config.ts` for the full list of expected variable names.

### 2. Docker Image Architecture
**CRITICAL:** Must build for `linux/amd64`, not `arm64` (Mac default):

```bash
# ❌ WRONG (builds for Mac M1/M2)
docker build -t image:latest .

# ✅ CORRECT (builds for Hetzner servers)
docker buildx build --platform linux/amd64 -t image:latest . --push
```

GitHub Actions automatically builds for amd64.

### 3. GitHub Container Registry Permissions
**Issue:** `GITHUB_TOKEN` doesn't have permission to push to packages created with personal tokens.

**Solution:** Use `GH_TOKEN` secret instead:
```yaml
# .github/workflows/deploy-production.yml
- name: Log in to GitHub Container Registry
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GH_TOKEN }}  # NOT secrets.GITHUB_TOKEN
```

### 4. Sealed Secrets and Manual Secrets Conflict
**Issue:** If you manually create a secret, sealed-secrets can't overwrite it.

**Error:**
```
failed update: Resource "clickhouse-secrets" already exists and is not managed by SealedSecret
```

**Solution:** Delete the manual secret first:
```bash
kubectl delete secret clickhouse-secrets -n batchsender
kubectl apply -f k8s/base/clickhouse/sealed-secrets.yaml
```

### 5. Hetzner Primary IP Limits
**Issue:** New Hetzner accounts have a 3 Primary IP limit.

**Impact:**
- 3-master HA cluster = uses 3 IPs
- Can't add worker nodes without IP limit increase

**Solution:**
- Request IP limit increase via Hetzner support (takes 2-4 hours)
- Or use 1-master test cluster (2 IPs total: 1 master + workers)

### 6. Server Type Availability by Location
**Finding:** Not all server types are available in all locations.

**Example:**
- `cpx21` → NOT available in nbg1, hel1
- `cpx22` → Available in fsn1, hel1 (€6.99/mo, better than cpx21!)

**Check availability:**
```bash
curl -H "Authorization: Bearer $HCLOUD_TOKEN" \
  https://api.hetzner.cloud/v1/server_types
```

---

## 🎯 Next Steps & Options

### Option 1: Expose Public API (LoadBalancer - Simplest)

**Time:** 5 minutes
**Cost:** +€5/mo

Change the worker service to LoadBalancer:

```bash
kubectl patch service worker -n batchsender -p '{"spec":{"type":"LoadBalancer"}}'

# Get public IP
kubectl get service worker -n batchsender
```

**Result:** Access API at `http://<EXTERNAL-IP>:80`

**Pros:**
- Simple, works immediately
- No domain needed

**Cons:**
- IP address instead of domain name
- No SSL (HTTP only)
- Costs €5/mo for load balancer

---

### Option 2: Expose Public API (Ingress + Domain - Better)

**Time:** 15 minutes
**Cost:** Domain only (~€10/year)

1. **Buy a domain** (e.g., `yourdomain.com`)

2. **Install Traefik Ingress** (already configured in plan):
```bash
helm repo add traefik https://traefik.github.io/charts
helm install traefik traefik/traefik -n kube-system
```

3. **Create Ingress resource:**
```yaml
# k8s/base/worker/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: worker-ingress
  namespace: batchsender
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  rules:
  - host: api.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: worker
            port:
              number: 80
  tls:
  - hosts:
    - api.yourdomain.com
    secretName: worker-tls
```

4. **Point domain DNS** to load balancer IP:
```bash
kubectl get service traefik -n kube-system
# Create A record: api.yourdomain.com → <EXTERNAL-IP>
```

**Result:** Access API at `https://api.yourdomain.com` with automatic SSL!

**Pros:**
- Clean domain name
- Automatic SSL certificates (Let's Encrypt)
- Professional setup

**Cons:**
- Need to buy domain
- Slightly more complex setup

---

### Option 3: Scale to 3-Master HA Setup

**Prerequisites:** Hetzner IP limit increased to 10

**Steps:**
1. Edit `cluster-config.yaml`:
```yaml
masters_pool:
  instance_type: cpx22
  instance_count: 3  # Change from 1 to 3
  locations:
    - fsn1
    - nbg1  # Add second location
    - hel1  # Add third location
```

2. Upgrade cluster:
```bash
hetzner-k3s upgrade --config cluster-config.yaml
```

**Result:**
- High availability (cluster survives 1 master failure)
- Masters spread across 3 datacenters
- Cost: +€14/mo (2 additional masters)

---

### Option 4: Add Monitoring Dashboard Access

**Time:** 5 minutes

Access Grafana dashboard:

```bash
# Port-forward Grafana
kubectl port-forward -n kube-system svc/kube-prometheus-stack-grafana 3000:80

# Get admin password
kubectl get secret -n kube-system kube-prometheus-stack-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d && echo
```

Open browser: `http://localhost:3000`
- Username: `admin`
- Password: <from command above>

**Or expose publicly:**
```bash
kubectl patch service kube-prometheus-stack-grafana -n kube-system \
  -p '{"spec":{"type":"LoadBalancer"}}'
```

---

## 📝 GitOps Workflow (Current Setup)

Your deployment is fully automated! Here's the workflow:

### Making Code Changes
```bash
# 1. Make changes
vim apps/worker/src/index.ts

# 2. Commit and push
git add .
git commit -m "Update worker logic"
git push origin main
```

**What happens automatically:**
1. ✅ GitHub Actions triggered
2. ✅ Docker image built (amd64)
3. ✅ Image pushed to ghcr.io/ejkkan/batchsender-worker:latest
4. ✅ Kubernetes manifests applied
5. ✅ Worker pods rolling update
6. ✅ Health checks verified
7. ✅ KEDA autoscaling activated

**Watch it:** https://github.com/ejkkan/offsenda/actions

### Updating Secrets
```bash
# 1. Edit .env.prod
vim .env.prod

# 2. Re-encrypt secrets
./scripts/seal-secrets.sh

# 3. Commit and push
git add k8s/base/*/sealed-secrets.yaml
git commit -m "Update production secrets"
git push origin main
```

Sealed secrets are automatically decrypted by the cluster!

### Workflow Triggers
The workflow runs when you push changes to:
- `apps/worker/**` (worker code)
- `k8s/**` (Kubernetes manifests)
- `.github/workflows/deploy-production.yml` (workflow itself)

**Manual trigger:** https://github.com/ejkkan/offsenda/actions/workflows/deploy-production.yml → "Run workflow"

---

## 🔍 Troubleshooting

### Workers Not Starting

**Check logs:**
```bash
kubectl logs -n batchsender -l app=worker --tail=50
```

**Common issues:**
- Missing environment variables (check configmap)
- Wrong variable names (NATS_CLUSTER vs NATS_URL)
- Image pull errors (check ghcr.io package is public)
- Resource limits (cluster out of CPU/memory)

### ClickHouse Authentication Errors

**Error:** `Authentication failed: password is incorrect`

**Cause:** Sealed secret didn't overwrite manual secret

**Fix:**
```bash
kubectl delete secret clickhouse-secrets -n batchsender
kubectl apply -f k8s/base/clickhouse/sealed-secrets.yaml
kubectl delete pod clickhouse-0 -n batchsender
```

### KEDA Not Scaling

**Check ScaledObject:**
```bash
kubectl get scaledobject worker-scaler -n batchsender

# Should show READY=True
```

**Check KEDA logs:**
```bash
kubectl logs -n keda -l app=keda-operator --tail=50
```

**Common issues:**
- Secret not found (worker-secrets missing)
- NATS connection failed (check NATS_CLUSTER variable)

### GitHub Actions Failing

**Error:** `permission_denied: write_package`

**Fix:** Make sure `GH_TOKEN` secret is set (not `GITHUB_TOKEN`)

**Error:** `no match for platform in manifest`

**Fix:** Image built for wrong architecture (arm64 vs amd64)
```bash
docker buildx build --platform linux/amd64 ...
```

### Image Pull Errors

**Error:** `401 Unauthorized` or `403 Forbidden`

**Fix:** Make ghcr.io package public
- Go to: https://github.com/users/ejkkan/packages/container/batchsender-worker/settings
- Change visibility to Public

### Cluster Autoscaler Not Adding Nodes

**Issue:** Hetzner Primary IP limit (3 IPs for new accounts)

**Check:** https://console.hetzner.cloud → Project → Limits

**Fix:** Request IP limit increase via support ticket

---

## 📂 Important Files Reference

### Configuration Files
- `cluster-config.yaml` - Hetzner k3s cluster definition
- `.env.hetzner` - Hetzner API token (**keep safe, not in Git**)
- `.env.prod` - Production secrets (**CRITICAL - backup this file!**)
- `kubeconfig` - Kubernetes access credentials (regenerated with each cluster)

### Kubernetes Manifests
- `k8s/base/` - Base configurations for all environments
- `k8s/overlays/production/` - Production-specific overrides
- `k8s/base/worker/configmap.yaml` - Worker environment variables
- `k8s/base/worker/sealed-secrets.yaml` - Encrypted worker secrets

### Scripts
- `scripts/bootstrap-infrastructure.sh` - Install KEDA, Prometheus, etc.
- `scripts/seal-secrets.sh` - Encrypt secrets from .env.prod
- `scripts/verify-deployment.sh` - Test production deployment

### GitHub Workflows
- `.github/workflows/deploy-production.yml` - Automated CI/CD pipeline

---

## 📞 Support & Resources

### Hetzner Cloud
- Console: https://console.hetzner.cloud
- API Docs: https://docs.hetzner.cloud/
- Community: https://community.hetzner.com/

### hetzner-k3s
- GitHub: https://github.com/vitobotta/hetzner-k3s
- Documentation: https://hetzner-k3s.com/

### Kubernetes
- kubectl cheatsheet: https://kubernetes.io/docs/reference/kubectl/cheatsheet/
- KEDA docs: https://keda.sh/docs/
- Sealed Secrets: https://sealed-secrets.netlify.app/

### Current Cluster Info
```bash
# Cluster endpoint
kubectl cluster-info

# Current context
kubectl config current-context

# Get all resources
kubectl get all -n batchsender
```

---

## 🎓 Key Learnings from Initial Deployment

1. **Server type availability varies by region** - Always check API for current availability
2. **Use cpx22 instead of cpx21** - Better availability, similar price (€6.99 vs €6.39)
3. **Environment variable names matter** - Code expects specific names (NATS_CLUSTER, not NATS_URL)
4. **Build for correct architecture** - Hetzner uses amd64, not arm64
5. **Sealed secrets can't overwrite manual secrets** - Delete manual secrets first
6. **GitHub token permissions** - Use personal token (GH_TOKEN), not GITHUB_TOKEN
7. **Primary IP limits are real** - Request increase early if planning HA setup
8. **GitOps is powerful** - Once set up, deployments are just `git push`

---

## ✅ Deployment Checklist

### Initial Setup
- [ ] Hetzner account created
- [ ] API token generated and saved in `.env.hetzner`
- [ ] `.env.prod` created with production secrets
- [ ] Tools installed (hetzner-k3s, kubectl, helm, kubeseal)
- [ ] GitHub repository created
- [ ] GitHub secrets configured (KUBECONFIG, GH_TOKEN)

### Cluster Creation
- [ ] Cluster created with `hetzner-k3s create`
- [ ] Infrastructure installed with bootstrap script
- [ ] Application deployed with `kubectl apply`
- [ ] Verification script passed
- [ ] GitHub Actions workflow successful

### Production Ready
- [ ] Workers running and healthy
- [ ] KEDA autoscaling active
- [ ] ClickHouse authentication working
- [ ] NATS connection established
- [ ] Monitoring dashboards accessible
- [ ] GitOps workflow tested (push to deploy)

### Optional
- [ ] Public API exposed (LoadBalancer or Ingress)
- [ ] Custom domain configured
- [ ] SSL certificates working
- [ ] Scaled to 3-master HA setup
- [ ] Monitoring alerts configured

---

**🎉 You now have a production-ready Kubernetes cluster with full GitOps automation!**

**Next Agent:** Everything you need to know is documented above. The cluster is running and operational. Choose one of the "Next Steps" options to continue improving the deployment.
