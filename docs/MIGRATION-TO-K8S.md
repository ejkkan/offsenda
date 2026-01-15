# Migration Guide: Docker Compose → Kubernetes Dev

This guide helps you transition from the old Docker Compose development setup to the new Kubernetes-based workflow.

## What Changed?

### Before (Docker Compose)
```bash
pnpm dev
  ↓
Starts Docker containers (NATS, ClickHouse)
Runs apps as Node.js processes on your machine
```

**Issues:**
- ❌ Doesn't match production (K8s)
- ❌ Can't test autoscaling locally
- ❌ Can't test CronJobs locally
- ❌ Different configs for dev and prod

### After (Kubernetes)
```bash
pnpm dev
  ↓
Starts k3d cluster (local Kubernetes)
Deploys everything using production K8s manifests
Watches files and auto-rebuilds on changes
```

**Benefits:**
- ✅ Dev = Prod (exact match)
- ✅ Test autoscaling locally
- ✅ Test CronJobs locally
- ✅ Same configs for dev and prod
- ✅ Learn Kubernetes naturally

## Migration Steps

### Step 1: Install Prerequisites

```bash
# macOS
brew install kubectl k3d skaffold

# Linux
# kubectl: https://kubernetes.io/docs/tasks/tools/
# k3d: https://k3d.io/#installation
# skaffold: https://skaffold.dev/docs/install/
```

**Verify installation:**
```bash
kubectl version --client
k3d version
skaffold version
```

### Step 2: First Run

```bash
# Old way (still works, renamed to dev:simple)
pnpm dev:simple

# New way (K8s)
pnpm dev
```

**What happens:**
1. Creates k3d cluster (one-time, ~1 min)
2. Builds Docker image
3. Deploys to Kubernetes
4. Port-forwards to localhost
5. Shows logs

**First run:** ~2 minutes
**Next time:** ~30 seconds (cluster already exists)

### Step 3: Verify Everything Works

```bash
# Check health
curl http://localhost:6001/health

# View pods
pnpm k8s:pods

# Check logs
pnpm k8s:logs
```

### Step 4: Update Your Workflow

| Old Command | New Command | Notes |
|------------|-------------|-------|
| `pnpm dev` | `pnpm dev` | Now uses K8s! |
| `docker ps` | `pnpm k8s:pods` | List running services |
| `docker logs -f worker` | `pnpm k8s:logs` | View logs |
| `docker exec -it worker sh` | `pnpm k8s:shell` | Shell into container |
| `docker restart worker` | `pnpm k8s:restart` | Restart service |

## Differences You'll Notice

### Slower Startup (But Worth It!)

**Old:** 30 seconds
**New:** 2 minutes (first time), 30 seconds (subsequent)

**Why?** Building and deploying to K8s takes longer, but you get:
- Production parity
- Autoscaling testing
- CronJob testing
- Better learning experience

### Hot-Reload Delay

**Old:** Instant (< 1 second)
**New:** 2-5 seconds (rebuild + redeploy)

**Why?** Skaffold needs to:
1. Rebuild Docker image
2. Push to local registry
3. Restart pod

**Is it noticeable?** Barely. Most developers find 2-5 seconds acceptable.

### New Concepts to Learn

You'll encounter these Kubernetes concepts:

1. **Pods** - Running containers
   ```bash
   pnpm k8s:pods  # List pods
   ```

2. **Deployments** - How pods are managed
   ```bash
   kubectl get deploy -n batchsender
   ```

3. **Services** - Networking between pods
   ```bash
   kubectl get svc -n batchsender
   ```

4. **HPA** - Autoscaler
   ```bash
   pnpm infra:hpa  # Watch autoscaling
   ```

**Don't worry!** The docs explain everything as you go.

### Resource Usage

**Old:**
- Docker containers: ~500 MB RAM

**New:**
- K8s control plane: ~500 MB RAM
- Your apps: ~500 MB RAM
- **Total:** ~1 GB RAM

Still very reasonable for local development.

## Fallback: Keep Old Workflow

If you need the old fast Docker Compose mode:

```bash
pnpm dev:simple     # Old workflow (Docker Compose)
pnpm dev:compose    # Alternative name
```

**Use this when:**
- You need instant hot-reload
- You're doing rapid prototyping
- K8s is having issues

**But remember:** It doesn't match production!

## Testing the Migration

### 1. Basic Functionality

```bash
# Start dev
pnpm dev

# Create batch (need API key)
curl -X POST http://localhost:6001/api/batches \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"name":"test",...}'

# Check it works
curl http://localhost:6001/api/batches \
  -H "Authorization: Bearer YOUR_KEY"
```

### 2. Hot-Reload

```bash
# Edit apps/worker/src/api.ts
# Add a log: console.log('test')

# Watch logs
pnpm k8s:logs

# Save file
# → Should see rebuild in 2-5 seconds
# → New log appears
```

### 3. Autoscaling

```bash
# Terminal 1: Watch autoscaling
pnpm infra:hpa

# Terminal 2: Watch pods
pnpm k8s:pods

# Terminal 3: Create large batch
# → Pods should scale up
# → HPA shows increased replicas
```

## Common Migration Issues

### "k3d not found"

```bash
# Install k3d
brew install k3d

# Or on Linux:
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
```

### "Port 6001 already in use"

Old Docker Compose still running:

```bash
# Stop old setup
docker compose -f docker-compose.local.yml down

# Or kill process
lsof -ti:6001 | xargs kill -9

# Restart
pnpm dev
```

### "Skaffold build failed"

```bash
# Clear Docker cache
docker system prune -a

# Delete cluster
pnpm k8s:cleanup

# Start fresh
pnpm dev
```

### "Too slow, want old workflow"

```bash
# Use simple mode
pnpm dev:simple

# But remember: doesn't match production!
```

## Tips for Success

### 1. Give It a Week

The first few days might feel slower. After a week, the workflow becomes natural.

### 2. Learn Basic kubectl

These 5 commands cover 90% of daily use:

```bash
kubectl get pods -n batchsender           # List pods
kubectl logs -f worker-xxx -n batchsender # Logs
kubectl describe pod worker-xxx -n batchsender  # Debug
kubectl exec -it worker-xxx -n batchsender sh   # Shell
kubectl get all -n batchsender            # Everything
```

### 3. Use Aliases

Add to your shell config:

```bash
alias k='kubectl'
alias kgp='kubectl get pods -n batchsender'
alias klog='kubectl logs -f -n batchsender'
```

### 4. Keep Documentation Handy

- [DEVELOPMENT.md](./DEVELOPMENT.md) - Full guide
- [QUICK-REFERENCE.md](./QUICK-REFERENCE.md) - Common commands

## FAQ

### Q: Why switch to K8s for local dev?

**A:** Dev/prod parity. Testing autoscaling and CronJobs locally catches issues before production.

### Q: Is this more complicated?

**A:** Initially yes. But you'll learn Kubernetes, which is valuable for your career.

### Q: Can I stick with Docker Compose?

**A:** Yes, use `pnpm dev:simple`. But you won't be able to test K8s features.

### Q: What if K8s breaks?

**A:** `pnpm k8s:cleanup` then `pnpm dev` fixes 90% of issues.

### Q: Does this affect production?

**A:** No! Production is unchanged. This only affects local development.

### Q: Will this slow me down?

**A:** First week: maybe. After that: No. 2-5 second rebuilds are fast enough.

## Next Steps

1. ✅ Install prerequisites
2. ✅ Run `pnpm dev` for first time
3. ✅ Make a code change, test hot-reload
4. ✅ Read [DEVELOPMENT.md](./DEVELOPMENT.md)
5. ✅ Try kubectl commands from [QUICK-REFERENCE.md](./QUICK-REFERENCE.md)
6. ✅ Test autoscaling
7. ✅ Feel proud you're using production-grade workflows!

## Getting Help

- Stuck? Check [DEVELOPMENT.md#troubleshooting](./DEVELOPMENT.md#troubleshooting)
- Questions? Read the [Skaffold docs](https://skaffold.dev/docs/)
- Still stuck? Use `pnpm dev:simple` as fallback

Welcome to Kubernetes development! 🚀
