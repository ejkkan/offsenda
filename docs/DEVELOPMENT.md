# BatchSender Development Guide

## Overview

BatchSender now uses **Kubernetes for local development** to match production exactly. This ensures dev/prod parity and lets you test all production features locally (autoscaling, CronJobs, networking, etc.).

**Key benefit:** What works locally will work in production!

## Quick Start

### Prerequisites

Install these tools once:

```bash
# macOS
brew install kubectl k3d skaffold

# Linux
# kubectl: https://kubernetes.io/docs/tasks/tools/
# k3d: https://k3d.io/
# skaffold: https://skaffold.dev/docs/install/
```

### Start Development

```bash
# 1. Copy environment file (first time only)
cp .env.example .env
# Edit .env with your config

# 2. Start development environment
pnpm dev

# That's it! Skaffold will:
# - Create k3d cluster (if needed)
# - Build and deploy all services
# - Watch for file changes
# - Show live logs
# - Auto-cleanup on Ctrl+C
```

**First run:** Takes ~2 minutes (cluster creation + build)
**Subsequent runs:** ~30 seconds
**Hot-reload:** 2-5 seconds after file save

## What Gets Deployed

When you run `pnpm dev`, these services start in Kubernetes:

| Service | Port | Purpose |
|---------|------|---------|
| Worker API | http://localhost:6001 | Your main application |
| NATS Monitor | http://localhost:8222 | Message queue monitoring |
| ClickHouse | http://localhost:8123 | Analytics database |
| DragonflyDB | (internal) | Rate limiting cache |

All services run in the `batchsender` namespace.

## Development Workflow

### Daily Development

```bash
# Start everything
pnpm dev

# Edit code in apps/worker/src/
# Save file → Skaffold auto-rebuilds + redeploys (2-5 sec)

# Check logs (automatically shown in terminal)
# Or use: pnpm k8s:logs

# Stop everything
# Press Ctrl+C (auto-cleans up resources)
```

### Hot-Reload

Skaffold watches these files and auto-redeploys on changes:
- `apps/worker/src/**/*.ts` - Worker source code
- `apps/worker/package.json` - Dependencies
- `packages/db/src/**/*.ts` - Database package

**Note:** Changes to K8s manifests (`k8s/*.yaml`) require restart:
```bash
Ctrl+C
pnpm dev
```

### Making API Requests

```bash
# Health check
curl http://localhost:6001/health

# Create batch (need API key)
curl -X POST http://localhost:6001/api/batches \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test", ...}'
```

## Useful Commands

### View Logs

```bash
# Worker logs (follow)
pnpm k8s:logs

# All services logs
pnpm k8s:logs:all

# Specific pod
kubectl logs -f -n batchsender worker-xxxxx
```

### Check Status

```bash
# List all pods
pnpm k8s:pods

# Watch autoscaling
pnpm infra:hpa

# View recent events
pnpm k8s:events
```

### Debugging

```bash
# Shell into worker pod
pnpm k8s:shell

# Inside pod you can run:
node --version
ls /app
curl localhost:3000/health
```

### Force Restart

```bash
# Restart worker deployment
pnpm k8s:restart

# Full rebuild (if things are broken)
Ctrl+C  # Stop skaffold
pnpm k8s:cleanup  # Delete cluster
pnpm dev  # Start fresh
```

## Testing Production Features

### Autoscaling

Your local environment includes the HPA (Horizontal Pod Autoscaler):

```bash
# Watch autoscaling in action
pnpm infra:hpa

# Create large batch to trigger scaling
# Watch worker pods increase automatically
pnpm k8s:pods
```

### CronJobs

The backup CronJob runs at 3 AM daily:

```bash
# List CronJobs
kubectl get cronjob -n batchsender

# Trigger manual backup
kubectl create job --from=cronjob/clickhouse-backup test-backup -n batchsender

# Check job status
kubectl get jobs -n batchsender
```

### Resource Limits

Test how your app behaves with production-like resource constraints:

```bash
# View resource usage
kubectl top pods -n batchsender

# Edit resources in k8s/overlays/local/kustomization.yaml
# Then restart: Ctrl+C → pnpm dev
```

## Alternative: Simple Docker Compose Mode

If you need super-fast iteration without K8s:

```bash
# Runs apps directly on your machine (old way)
pnpm dev:simple

# Pros: Instant hot-reload
# Cons: Doesn't match production, can't test K8s features
```

**Use this only when:**
- You need instant reload for rapid prototyping
- You're working on features that don't depend on K8s
- You're having issues with K8s setup

## Troubleshooting

### "k3d cluster not found"

```bash
# Cluster was deleted, just restart
pnpm dev
# It will auto-create the cluster
```

### "Port 6001 already in use"

```bash
# Something else using the port
lsof -ti:6001 | xargs kill -9

# Or change port in dev-k8s.sh
```

### "Image pull error"

```bash
# Local registry issue, recreate cluster
pnpm k8s:cleanup
pnpm dev
```

### "Skaffold build failed"

```bash
# Check Docker is running
docker ps

# Clear Docker cache
docker system prune -a

# Rebuild
pnpm dev
```

### Logs not appearing

```bash
# Skaffold shows logs automatically
# But you can also check manually:
pnpm k8s:logs

# Or get pod name and check:
kubectl get pods -n batchsender
kubectl logs -f worker-xxxxx -n batchsender
```

### Pod stuck in CrashLoopBackOff

```bash
# Check what's wrong
kubectl describe pod -n batchsender worker-xxxxx

# View logs
kubectl logs -n batchsender worker-xxxxx

# Common causes:
# - Missing .env variables
# - Database connection issue
# - Port conflict
```

## Understanding the Setup

### K3d Cluster

- **Name:** `batchsender`
- **Nodes:** 1 server + 3 agents (lightweight)
- **Registry:** `registry.localhost:5111` (for local images)
- **Context:** `k3d-batchsender`

### Kustomize Overlays

Your app uses Kustomize to manage configs:

- **Base:** `k8s/base/` - Production configs
- **Local:** `k8s/overlays/local/` - Local overrides
  - Reduced resources (512Mi RAM vs 2Gi)
  - Single-node mode (no clustering)
  - Mock email provider
  - Local storage class

Changes to base configs affect both local and production!

### Skaffold

Configuration file: `skaffold.yaml`

Skaffold:
1. Watches your source files
2. Builds Docker image when files change
3. Pushes to local registry
4. Deploys to K8s with Kustomize
5. Port-forwards services to localhost
6. Streams logs to your terminal

## Comparison: Old vs New

| Feature | Old (Docker Compose) | New (Kubernetes) |
|---------|---------------------|------------------|
| **Startup time** | 30 sec | 2 min (first), 30 sec (after) |
| **Hot-reload** | Instant | 2-5 seconds |
| **Matches production** | ❌ No | ✅ Yes |
| **Test autoscaling** | ❌ No | ✅ Yes |
| **Test CronJobs** | ❌ No | ✅ Yes |
| **Resource usage** | Low | Medium (+ K8s overhead) |
| **Learning curve** | Simple | K8s concepts needed |
| **Recommended for** | Quick prototypes | Daily development |

## Next Steps

1. ✅ Run `pnpm dev` and verify everything works
2. Make a code change and see hot-reload
3. Try the kubectl convenience commands
4. Review the K8s manifests in `k8s/base/`
5. Read about [Skaffold](https://skaffold.dev/) and [k3d](https://k3d.io/)

## Getting Help

- **Skaffold docs:** https://skaffold.dev/docs/
- **k3d docs:** https://k3d.io/
- **kubectl cheatsheet:** https://kubernetes.io/docs/reference/kubectl/cheatsheet/

For project-specific issues, check:
- `k8s/base/` - Production Kubernetes configs
- `k8s/overlays/local/` - Local development overrides
- `skaffold.yaml` - Skaffold configuration
