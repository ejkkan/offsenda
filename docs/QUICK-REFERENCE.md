# Quick Reference: K8s Development

## One-Time Setup

```bash
# Install tools
brew install kubectl k3d skaffold

# Create .env file
cp .env.example .env
# Edit with your config
```

## Daily Commands

```bash
# Start development
pnpm dev

# Stop (Ctrl+C auto-cleans up)

# Start simple mode (no K8s)
pnpm dev:simple
```

## Viewing Logs

```bash
pnpm k8s:logs          # Worker logs
pnpm k8s:logs:all      # All services
```

## Debugging

```bash
pnpm k8s:pods          # List pods
pnpm k8s:events        # Recent events
pnpm k8s:shell         # Shell into worker
pnpm k8s:restart       # Restart worker
```

## Testing Features

```bash
pnpm infra:hpa         # Watch autoscaling
pnpm k8s:pods          # Watch pods scale
```

## Cleanup

```bash
# Delete cluster (fixes most issues)
pnpm k8s:cleanup

# Then restart
pnpm dev
```

## Ports

- Worker: http://localhost:6001
- NATS: http://localhost:8222
- ClickHouse: http://localhost:8123

## Common Issues

### Port in use
```bash
lsof -ti:6001 | xargs kill -9
```

### Build failed
```bash
docker system prune -a
pnpm dev
```

### Cluster broken
```bash
pnpm k8s:cleanup
pnpm dev
```

## File Structure

```
k8s/
├── base/               # Production configs
├── overlays/local/     # Local overrides
└── terraform/          # Terraform (alternative setup)

skaffold.yaml           # Skaffold config (watches files)
dev-k8s.sh             # Dev startup script
dev.sh                 # Simple mode (Docker Compose)
```

## Hot Reload

Edit these files → auto-rebuild (2-5 sec):
- `apps/worker/src/**/*.ts`
- `packages/db/src/**/*.ts`

Edit K8s configs → manual restart:
- Ctrl+C → `pnpm dev`

## Production vs Local

| Config | Local | Production |
|--------|-------|------------|
| Workers | 2-20 | 2-50 |
| NATS | Single node | 3-node cluster |
| ClickHouse | Single node | 3-node cluster |
| Email provider | Mock | Real (Resend/SES) |
| Resources | 512Mi RAM | 2Gi RAM |
| Storage | local-path | Cloud volumes |

## kubectl Quick Commands

```bash
# Pods
kubectl get pods -n batchsender
kubectl describe pod worker-xxx -n batchsender
kubectl logs -f worker-xxx -n batchsender

# Deployments
kubectl get deploy -n batchsender
kubectl scale deploy/worker --replicas=5 -n batchsender

# Services
kubectl get svc -n batchsender

# Everything
kubectl get all -n batchsender
```
