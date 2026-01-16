# Web App Deployment Options

Multiple ways to deploy the BatchSender web app to production. Choose based on your needs.

---

## 🚀 Option 1: Vercel (Recommended for Quick Start)

**Best for:** Quick deployment, serverless, minimal ops

### Pros
- ✅ **Zero config** - Deploys in 2 minutes
- ✅ **Auto scaling** - Handles traffic spikes automatically
- ✅ **Global CDN** - Fast worldwide
- ✅ **SSL included** - Free HTTPS
- ✅ **Preview deployments** - Test every commit
- ✅ **Built by Next.js team** - Native Next.js support

### Cons
- ⚠️ **Cost scales with usage** - Can get expensive at scale
- ⚠️ **Cold starts** - First request after idle is slower
- ⚠️ **Less control** - Can't customize infrastructure

### Pricing
- **Hobby:** Free (ideal for testing)
- **Pro:** $20/mo + usage
- **Typical cost:** $20-50/mo for small apps

### Deploy Steps

```bash
# 1. Install Vercel CLI
npm install -g vercel

# 2. Login to Vercel
vercel login

# 3. Deploy from apps/web directory
cd apps/web
vercel

# 4. Add environment variables in Vercel dashboard
# Go to: Settings → Environment Variables
# Add:
#   DATABASE_URL = your-neon-postgresql-url
#   NEXTAUTH_SECRET = your-nextauth-secret
#   NEXTAUTH_URL = https://your-vercel-app.vercel.app

# 5. Deploy to production
vercel --prod
```

**Custom domain:**
- Go to Vercel dashboard → Settings → Domains
- Add `web.valuekeys.io`
- Update DNS: CNAME → `cname.vercel-dns.com`

---

## 🐳 Option 2: Hetzner Kubernetes (Full Control)

**Best for:** Cost optimization, full control, existing infrastructure

### Pros
- ✅ **Predictable cost** - €3-6/mo total (fixed pricing)
- ✅ **Full control** - Complete infrastructure access
- ✅ **Same cluster as worker** - One infrastructure
- ✅ **No cold starts** - Always-on pods
- ✅ **GitOps ready** - Auto-deploy on push

### Cons
- ⚠️ **More setup** - Requires Docker + K8s knowledge
- ⚠️ **Manual scaling** - Need to adjust replicas manually
- ⚠️ **More ops work** - Monitor pods, updates, etc.

### Pricing
- **Web pods (2 replicas):** Already covered by existing workers (€0)
- **Load balancer:** Already set up (€0 extra)
- **Total additional cost:** €0 (uses existing infrastructure!)

### Deploy Steps

**Prerequisites:**
- Hetzner cluster already running ✅ (you have this!)
- Docker image built and pushed ✅ (GitHub Actions handles this)
- kubeconfig configured ✅ (you have this!)

```bash
# 1. Update .env.prod with NEXTAUTH_SECRET (already there)
# Verify it exists:
grep NEXTAUTH_SECRET .env.prod

# 2. Encrypt web secrets
./scripts/seal-secrets.sh

# 3. Commit sealed secrets
git add k8s/base/web/sealed-secrets.yaml
git commit -m "Add encrypted web app secrets"
git push origin main

# 4. GitHub Actions will automatically:
#    - Build Docker image
#    - Push to ghcr.io
#    - Deploy to Kubernetes
#    - Wait for rollout to complete

# 5. Add DNS record for web.valuekeys.io
# Type: A
# Name: web
# Value: 49.12.21.173 (your load balancer IP)
# TTL: 300

# 6. Verify deployment
export KUBECONFIG=./kubeconfig
kubectl get pods -n batchsender -l app=web
kubectl get ingress -n batchsender web-ingress

# 7. Check SSL certificate
kubectl get certificate -n batchsender web-tls

# 8. Test the app
curl https://web.valuekeys.io
```

**Access the app:**
- Public URL: https://web.valuekeys.io
- Health check: https://web.valuekeys.io/api/auth/signin

---

## ☁️ Option 3: Cloudflare Pages

**Best for:** Static sites, edge computing, Cloudflare users

### Pros
- ✅ **Free tier** - Generous limits
- ✅ **Global CDN** - 275+ locations
- ✅ **DDoS protection** - Cloudflare security
- ✅ **Fast builds** - Quick deployments

### Cons
- ⚠️ **Limited Next.js support** - Not all features work
- ⚠️ **Edge runtime** - Different from Node.js
- ⚠️ **More complex** - Requires adapter setup
- ⚠️ **NextAuth limitations** - Some auth features may not work

### Pricing
- **Free:** 500 builds/mo, 1 concurrent build
- **Pro:** $20/mo, 5000 builds/mo, 5 concurrent

### Deploy Steps

```bash
# 1. Install Cloudflare adapter
cd apps/web
npm install @cloudflare/next-on-pages

# 2. Update next.config.js
# Add: experimental: { runtime: 'edge' }

# 3. Build for Cloudflare
npx @cloudflare/next-on-pages

# 4. Deploy
npx wrangler pages deploy .vercel/output/static

# Note: This requires significant Next.js config changes
# Consider Vercel or Kubernetes instead for full compatibility
```

**⚠️ Warning:** Next.js on Cloudflare Pages is experimental. Not recommended unless you have specific Cloudflare requirements.

---

## 📊 Comparison Matrix

| Feature | Vercel | Hetzner K8s | Cloudflare |
|---------|--------|-------------|------------|
| **Setup time** | 2 min | 10 min | 30 min |
| **Cost/month** | $20-50 | €0-3 | Free-$20 |
| **Scaling** | Automatic | Manual | Automatic |
| **Cold starts** | Yes | No | Yes |
| **Next.js support** | Full | Full | Partial |
| **Ops work** | None | Medium | Low |
| **Best for** | Quick start | Cost + control | Cloudflare users |

---

## 🎯 Recommendation

### For You Right Now:
**Start with Hetzner Kubernetes** (Option 2)

**Why:**
1. ✅ **€0 additional cost** - Uses existing infrastructure
2. ✅ **Already set up** - Just push to deploy
3. ✅ **Full control** - Can customize everything
4. ✅ **No cold starts** - Always fast
5. ✅ **GitOps ready** - Auto-deploy on push

**Later, when scaling:**
- If traffic grows significantly → Consider Vercel for auto-scaling
- If you need multi-region → Deploy to multiple Hetzner regions
- If you migrate to Cloudflare → Can switch to Pages

---

## 🛠️ Current Setup (Hetzner K8s)

You're all set! Just need to:

```bash
# 1. Run seal-secrets to encrypt web secrets
./scripts/seal-secrets.sh

# 2. Push to trigger deployment
git add k8s/base/web/sealed-secrets.yaml
git commit -m "Add web app deployment"
git push origin main

# 3. Add DNS record
# web.valuekeys.io → 49.12.21.173

# 4. Wait 2-3 minutes for:
#    - Docker build
#    - K8s deployment
#    - SSL certificate

# 5. Visit your app!
open https://web.valuekeys.io
```

---

## 🔍 Monitoring

### Check deployment status
```bash
export KUBECONFIG=./kubeconfig

# Watch pods
kubectl get pods -n batchsender -l app=web -w

# Check logs
kubectl logs -f -n batchsender -l app=web

# Check ingress
kubectl get ingress -n batchsender web-ingress

# Check SSL certificate
kubectl get certificate -n batchsender web-tls
```

### GitHub Actions
- View build progress: https://github.com/ejkkan/offsenda/actions
- Each push to `main` triggers automatic deployment
- Build time: ~2-3 minutes

---

## 🚨 Troubleshooting

### Pods not starting
```bash
# Check pod status
kubectl describe pod -n batchsender -l app=web

# Common issues:
# - Image pull errors: Check ghcr.io permissions
# - Secret errors: Run ./scripts/seal-secrets.sh
# - Database connection: Verify DATABASE_URL in .env.prod
```

### SSL certificate not ready
```bash
# Check certificate status
kubectl describe certificate -n batchsender web-tls

# Wait for Let's Encrypt validation (1-2 minutes)
# Requires DNS to be pointing to load balancer
```

### Can't access app
```bash
# 1. Check DNS
dig web.valuekeys.io
# Should return: 49.12.21.173

# 2. Check ingress
kubectl get ingress -n batchsender web-ingress

# 3. Test internal service
kubectl port-forward -n batchsender svc/web 3000:80
curl http://localhost:3000
```

---

## 📚 Related Docs

- [Worker Deployment](../../DEPLOY.md) - Production deployment guide
- [Environment Testing](../../ENVIRONMENTS.md) - Test against production
- [Main README](../../README.md) - Project overview

---

## 💡 Quick Commands

```bash
# Deploy to Hetzner
./scripts/seal-secrets.sh
git push origin main

# Watch deployment
kubectl get pods -n batchsender -l app=web -w

# Check logs
kubectl logs -f -n batchsender -l app=web

# Restart deployment
kubectl rollout restart deployment/web -n batchsender

# Scale replicas
kubectl scale deployment/web -n batchsender --replicas=3
```

---

**Ready to deploy?** Follow Option 2 (Hetzner Kubernetes) above! 🚀
