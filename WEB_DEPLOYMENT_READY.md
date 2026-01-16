# 🎉 Web App Deployment Ready!

Your BatchSender web app is now ready to deploy! Here's what's been set up and your options.

---

## 📦 What's Been Built

### 1. Docker Infrastructure ✅
- **Dockerfile** - Multi-stage Next.js build
- **Standalone output** - Optimized for production
- **Multi-architecture** - Builds for amd64 (Hetzner servers)
- **Size optimized** - Small production image

### 2. Kubernetes Manifests ✅
- **Deployment** - 2 replicas for high availability
- **Service** - Internal ClusterIP service
- **Ingress** - Traefik with auto-SSL (Let's Encrypt)
- **ConfigMap** - Public configuration (NEXTAUTH_URL)
- **Sealed Secrets** - Encrypted secrets for Git

### 3. GitHub Actions CI/CD ✅
- **Auto-build** - Triggers on push to main
- **Auto-deploy** - Deploys to Kubernetes automatically
- **Docker Registry** - ghcr.io/ejkkan/batchsender-web
- **Rollout verification** - Ensures deployment succeeds

### 4. Documentation ✅
- **DEPLOYMENT.md** - 3 deployment options with pros/cons
- **Environment scripts** - Easy dev/prod switching
- **Troubleshooting guide** - Common issues solved

---

## 🚀 Deployment Options

### Option 1: Hetzner Kubernetes (Recommended)
**Cost:** €0/mo (uses existing infrastructure!)
**Setup:** 5 minutes
**Best for:** You right now

```bash
# Just 3 commands!
./scripts/seal-secrets.sh
git push origin main
# Add DNS: web.valuekeys.io → 49.12.21.173
```

**Why this is best:**
- ✅ Free (no additional cost)
- ✅ Already set up
- ✅ Auto-deploys on push
- ✅ Same infrastructure as API

---

### Option 2: Vercel (Easiest)
**Cost:** $20-50/mo
**Setup:** 2 minutes
**Best for:** Quick deployment, auto-scaling

```bash
npm install -g vercel
cd apps/web
vercel --prod
```

**Why consider this:**
- ✅ Zero infrastructure management
- ✅ Auto-scaling
- ✅ Global CDN
- ✅ Preview deployments

---

### Option 3: Cloudflare Pages
**Cost:** Free-$20/mo
**Setup:** 30 minutes
**Best for:** Cloudflare users only

⚠️ **Not recommended** - Limited Next.js support

---

## 📋 Quick Deploy Guide (Hetzner)

### Step 1: Encrypt Secrets
```bash
# Generates encrypted secrets from .env.prod
./scripts/seal-secrets.sh
```

**Output:**
```
✓ All secrets encrypted successfully!

Generated files:
  • k8s/base/worker/sealed-secrets.yaml
  • k8s/base/clickhouse/sealed-secrets.yaml
  • k8s/base/clickhouse/sealed-b2-secret.yaml
  • k8s/base/web/sealed-secrets.yaml  ← NEW!
```

---

### Step 2: Push to Deploy
```bash
git add k8s/base/web/sealed-secrets.yaml
git commit -m "Deploy web app"
git push origin main
```

**GitHub Actions will:**
1. Build Docker image (~2 min)
2. Push to ghcr.io
3. Deploy to Kubernetes
4. Verify rollout

**Watch progress:**
- GitHub: https://github.com/ejkkan/offsenda/actions
- Logs: `kubectl logs -f -n batchsender -l app=web`

---

### Step 3: Add DNS Record

Go to your DNS provider (where you manage valuekeys.io):

```
Type:  A
Name:  web
Value: 49.12.21.173
TTL:   300
```

**What this does:** Points `web.valuekeys.io` → Your load balancer → Web app

---

### Step 4: Wait for SSL (1-2 min)

Let's Encrypt will automatically:
1. Verify domain ownership
2. Issue SSL certificate
3. Configure HTTPS

**Check status:**
```bash
export KUBECONFIG=./kubeconfig
kubectl get certificate -n batchsender web-tls
```

**When ready:**
```
NAME       READY   SECRET
web-tls    True    web-tls  ✅
```

---

### Step 5: Access Your App! 🎉

**Public URL:** https://web.valuekeys.io

**Login page:** https://web.valuekeys.io/api/auth/signin

**Create user:**
```bash
tsx scripts/create-user.ts your@email.com "Your Name"
```

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────┐
│  https://web.valuekeys.io                        │
│  https://api.valuekeys.io                        │
└───────────────────┬──────────────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │  Traefik Ingress      │
        │  (Load Balancer)      │
        │  49.12.21.173         │
        │  - SSL termination    │
        │  - Route by hostname  │
        └───────────┬───────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
┌───────────────┐       ┌───────────────┐
│  Web Pods (2) │       │ Worker Pods   │
│               │       │ (2-50, KEDA)  │
│  Next.js      │       │               │
│  - Auth       │       │  - Process    │
│  - UI         │       │  - Send email │
│  - Create     │       │  - Track      │
└───────┬───────┘       └───────┬───────┘
        │                       │
        └───────────┬───────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │  PostgreSQL (Neon)    │
        │  - Users              │
        │  - Batches            │
        │  - Recipients         │
        └───────────────────────┘
```

**All in one cluster:**
- Web app: 2 pods (always-on)
- Worker: 2-50 pods (KEDA autoscaling)
- Services: NATS, ClickHouse, DragonflyDB

**Cost:** €19/mo total (cluster + load balancer)
- Adding web app: €0 extra! 🎉

---

## 🔍 Monitoring

### Check Deployment
```bash
export KUBECONFIG=./kubeconfig

# Watch pods start
kubectl get pods -n batchsender -l app=web -w

# View logs
kubectl logs -f -n batchsender -l app=web

# Check ingress
kubectl get ingress -n batchsender web-ingress

# Check SSL certificate
kubectl get certificate -n batchsender web-tls
```

### GitHub Actions
Each push triggers:
1. **Build** - Docker image (2 min)
2. **Push** - To ghcr.io (30 sec)
3. **Deploy** - K8s rollout (1 min)
4. **Verify** - Health check (10 sec)

**Total time:** ~3-4 minutes from push to live

---

## 🎯 Full Testing Workflow

### Local Development → Production

```bash
# 1. Develop locally with local DB
pnpm dev:web

# 2. Test against production DB
pnpm dev:web:prod

# 3. Commit and push
git add .
git commit -m "New feature"
git push origin main

# 4. GitHub Actions deploys automatically

# 5. Verify in production
curl https://web.valuekeys.io/health
```

**Complete GitOps workflow!** 🚀

---

## 💰 Cost Breakdown

### Current Setup (1-master cluster)
- **Hetzner K8s:** €14/mo
- **Load Balancer:** €5/mo
- **Web app pods:** €0/mo (included)
- **Worker pods:** €0/mo (included)
- **Total:** €19/mo ✅

### What You Get
- ✅ API backend (api.valuekeys.io)
- ✅ Web frontend (web.valuekeys.io)
- ✅ 2-50 worker pods (autoscaling)
- ✅ Full monitoring stack
- ✅ SSL certificates (auto-renew)
- ✅ GitOps CI/CD

**Same cost as worker alone!**

---

## 📚 Documentation

All guides created:

1. **apps/web/DEPLOYMENT.md** - Full deployment guide
2. **apps/web/README.md** - Web app development
3. **ENVIRONMENTS.md** - Testing environments
4. **DEPLOY.md** - Production deployment
5. **This file** - Quick start guide

---

## 🚨 Troubleshooting

### Pods not starting?
```bash
kubectl describe pod -n batchsender -l app=web
# Check for: ImagePullBackOff, CrashLoopBackOff
```

**Common fixes:**
- Image not public: Make ghcr.io package public
- Secret missing: Run `./scripts/seal-secrets.sh`
- Database error: Check DATABASE_URL in .env.prod

### SSL not working?
```bash
kubectl describe certificate -n batchsender web-tls
# Wait 1-2 minutes for Let's Encrypt validation
```

**Requirements:**
- DNS pointing to load balancer (49.12.21.173)
- Ingress configured (✅ done)
- cert-manager running (✅ done)

### Can't access app?
```bash
# 1. Test DNS
dig web.valuekeys.io

# 2. Test internally
kubectl port-forward -n batchsender svc/web 3000:80
curl http://localhost:3000

# 3. Check ingress
kubectl get ingress -n batchsender
```

---

## ✅ What's Done

- [x] Dockerfile created
- [x] K8s manifests configured
- [x] GitHub Actions workflow
- [x] Secret encryption script updated
- [x] Documentation written
- [x] Load balancer ready
- [x] SSL auto-configured
- [x] All committed to Git

## 🎯 What's Next

**Option A: Deploy to Hetzner (Recommended)**
```bash
./scripts/seal-secrets.sh
git push origin main
# Add DNS record
# Wait 3-4 minutes
# Visit https://web.valuekeys.io
```

**Option B: Deploy to Vercel**
```bash
cd apps/web
vercel --prod
```

**Option C: Keep testing locally**
```bash
pnpm dev:web:prod
# Test against production DB
# Deploy when ready
```

---

## 🎉 Summary

You now have:
- ✅ **3 deployment options** (Hetzner, Vercel, Cloudflare)
- ✅ **Production-ready setup** (Docker + K8s)
- ✅ **Auto-deploy pipeline** (GitHub Actions)
- ✅ **Zero additional cost** (Hetzner option)
- ✅ **Complete documentation**
- ✅ **Ready to deploy!**

**Recommended next step:** Deploy to Hetzner K8s (€0 extra cost, 5 min setup)

See **apps/web/DEPLOYMENT.md** for detailed instructions.

---

**Questions? Check the docs or ask!** 🚀
