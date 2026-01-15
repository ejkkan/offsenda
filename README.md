# BatchSender

Scalable email batch processing system built on Kubernetes with NATS JetStream and ClickHouse.

## Features

- 🚀 **Autoscaling** - Workers scale 2-50 based on queue depth
- 📊 **Real-time Analytics** - ClickHouse for high-performance event logging
- ⚡ **Message Queue** - NATS JetStream for reliable message delivery
- 🔄 **Production Parity** - Dev environment matches production exactly
- 💾 **Automated Backups** - Daily backups to Backblaze B2
- 🎯 **Rate Limiting** - DragonflyDB for distributed rate control

## Quick Start

### Prerequisites

```bash
# macOS
brew install kubectl k3d skaffold node pnpm

# Linux: Install Node.js, pnpm, kubectl, k3d, skaffold
```

### Setup

```bash
# 1. Clone and install dependencies
git clone <your-repo>
cd batchsender
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your config

# 3. Start development
pnpm dev
```

That's it! Visit http://localhost:6001/health

**First run:** ~2 minutes (builds K8s cluster)
**Subsequent runs:** ~30 seconds

## Development

### Start Development Server

```bash
pnpm dev              # K8s mode (matches production)
pnpm dev:simple       # Simple mode (fast, Docker Compose)
```

### Make Changes

Edit code in `apps/worker/src/` → Save → Auto-rebuild (2-5 sec)

### View Logs

```bash
pnpm k8s:logs         # Worker logs
pnpm k8s:logs:all     # All services
```

### Debug

```bash
pnpm k8s:pods         # List pods
pnpm k8s:shell        # Shell into worker
pnpm k8s:events       # Recent events
```

### Test Autoscaling

```bash
# Watch pods scale based on queue depth
pnpm infra:hpa        # Watch autoscaler
pnpm k8s:pods         # Watch pods
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full guide.

## Architecture

```
┌─────────────────────────────────────────┐
│  Worker Pods (2-50, autoscaling)       │
│  ┌──────────────────────────────────┐  │
│  │ FastifyAPI + NATS Consumer        │  │
│  │ - Batch processing                │  │
│  │ - Email sending (Resend/SES)     │  │
│  │ - Event logging to ClickHouse    │  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
           ↓           ↓           ↓
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │   NATS   │ │ClickHouse│ │Dragonfly │
    │JetStream │ │Analytics │ │RateLimit │
    └──────────┘ └──────────┘ └──────────┘
```

## Project Structure

```
batchsender/
├── apps/
│   └── worker/           # Main worker application
│       ├── src/
│       │   ├── api.ts             # REST API
│       │   ├── nats/              # NATS client + workers
│       │   └── providers/         # Email providers
│       └── Dockerfile
├── packages/
│   └── db/              # Database schema (Drizzle ORM)
├── k8s/
│   ├── base/            # Production K8s manifests
│   ├── overlays/local/  # Local dev overrides
│   └── monitoring/      # Prometheus, Grafana configs
├── scripts/             # Backup/restore scripts
├── docs/                # Documentation
├── skaffold.yaml        # Skaffold dev config
└── dev-k8s.sh          # Dev startup script
```

## Deployment

### Local Kubernetes

```bash
pnpm dev              # Already using K8s!
```

### Production (Hetzner)

```bash
# One-time setup
pnpm prod:init

# Deploy
pnpm prod:plan        # Preview changes
pnpm prod:apply       # Apply to production
```

See [k8s/README.md](k8s/README.md) for deployment details.

## Available Commands

### Development
```bash
pnpm dev              # Start K8s dev environment
pnpm dev:simple       # Start simple Docker Compose mode
pnpm dev:worker       # Worker only
pnpm dev:web          # Web app only
```

### Kubernetes
```bash
pnpm k8s:logs         # View worker logs
pnpm k8s:pods         # List pods
pnpm k8s:shell        # Shell into worker
pnpm k8s:restart      # Restart worker
pnpm k8s:cleanup      # Delete cluster
```

### Database
```bash
pnpm db:push          # Push schema changes
pnpm db:migrate       # Run migrations
pnpm db:studio        # Open Drizzle Studio
```

### Testing
```bash
pnpm test             # All tests
pnpm test:unit        # Unit tests
pnpm test:integration # Integration tests
pnpm test:e2e         # End-to-end tests
```

### Production
```bash
pnpm prod:plan        # Preview changes
pnpm prod:apply       # Deploy to production
```

## Configuration

### Environment Variables

Required in `.env`:

```bash
# Database (Neon PostgreSQL)
DATABASE_URL=postgresql://...

# Email Provider
EMAIL_PROVIDER=resend        # or 'ses' or 'mock'
RESEND_API_KEY=re_...        # If using Resend

# NATS (auto-configured in K8s)
NATS_CLUSTER=nats://nats.batchsender.svc:4222

# ClickHouse (auto-configured in K8s)
CLICKHOUSE_URL=http://clickhouse.batchsender.svc:8123
CLICKHOUSE_PASSWORD=...

# Backblaze B2 (for cold storage + backups)
B2_KEY_ID=...
B2_APP_KEY=...
```

### Scaling Configuration

Edit `k8s/base/worker/hpa.yaml`:

```yaml
minReplicas: 2           # Minimum workers
maxReplicas: 50          # Maximum workers
targetValue: "1000"      # Scale at 1000 msgs/pod
```

## Monitoring

### Local Development

```bash
# NATS monitoring
open http://localhost:8222

# ClickHouse interface
open http://localhost:8123/play

# View metrics
curl http://localhost:6001/api/metrics
```

### Production

- Prometheus: Metrics collection
- Grafana: Dashboards
- AlertManager: Alerts

See [k8s/monitoring/README.md](k8s/monitoring/README.md) for setup.

## Documentation

- [Development Guide](docs/DEVELOPMENT.md) - Full dev workflow
- [Quick Reference](docs/QUICK-REFERENCE.md) - Common commands
- [Production Readiness](plans/production-readiness-unified-2026-01-13.md) - Production checklist
- [Monitoring Setup](k8s/monitoring/README.md) - Prometheus + Grafana
- [Backup Guide](k8s/base/clickhouse/BACKUP-README.md) - Backup/restore

## Troubleshooting

### "k3d cluster not found"
```bash
pnpm dev  # Auto-creates cluster
```

### "Port already in use"
```bash
lsof -ti:6001 | xargs kill -9
```

### "Build failed"
```bash
docker system prune -a
pnpm dev
```

### "Pod crashing"
```bash
pnpm k8s:logs
kubectl describe pod -n batchsender worker-xxx
```

Full troubleshooting: [docs/DEVELOPMENT.md#troubleshooting](docs/DEVELOPMENT.md#troubleshooting)

## Tech Stack

- **Runtime:** Node.js 20+, TypeScript
- **Framework:** Fastify (REST API)
- **Message Queue:** NATS JetStream
- **Database:** PostgreSQL (Neon), ClickHouse (analytics)
- **Cache:** DragonflyDB (Redis-compatible)
- **Orchestration:** Kubernetes (k3d local, Hetzner prod)
- **Dev Tools:** Skaffold, Kustomize, Terraform
- **Email:** Resend, AWS SES

## License

MIT

## Support

For issues, check:
1. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
2. [GitHub Issues](https://github.com/your-org/batchsender/issues)
3. Project documentation in `docs/`
