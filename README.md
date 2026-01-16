# BatchSender

**High-performance email batch processing system with distributed rate limiting and auto-scaling.**

Send thousands of personalized emails efficiently with NATS JetStream queuing, ClickHouse analytics, and Kubernetes auto-scaling.

---

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone <your-repo>
cd batchsender
pnpm install

# 2. Configure environment
cp .env.example .env.dev
# Edit .env.dev with your database URL and API keys

# 3. Start everything
pnpm dev
```

That's it! The dev server will:
- ✅ Start PostgreSQL, NATS, ClickHouse, Dragonfly
- ✅ Start Web App (http://localhost:5001)
- ✅ Start Worker API (http://localhost:6001)
- ✅ Show service dashboard with all URLs
- ✅ Stream live logs from all services

**First time?** See [COMMANDS.md](./COMMANDS.md) for the complete command reference.

---

## 📦 What's Included

### Web App (Next.js)
- **Dashboard:** Batch management and analytics
- **Auth:** NextAuth.js with database sessions
- **UI:** Tailwind CSS + shadcn/ui components
- **URL:** http://localhost:5001

### Worker API (Node.js + Fastify)
- **Queue Processing:** NATS JetStream consumers
- **Email Providers:** Resend, AWS SES, Mock
- **Rate Limiting:** Distributed with Dragonfly (Redis-compatible)
- **Analytics:** Real-time event tracking in ClickHouse
- **Auto-scaling:** KEDA scales 2-50 pods based on queue depth
- **URL:** http://localhost:6001

### Infrastructure
- **PostgreSQL:** User data, batches, recipients (Neon in production)
- **NATS JetStream:** Message queue with persistence
- **ClickHouse:** Fast analytics and event storage
- **Dragonfly:** Distributed rate limiting (Redis-compatible)
- **Prometheus + Grafana:** Optional monitoring stack

---

## 🎯 Common Commands

### Development

```bash
pnpm dev                   # Start all services
pnpm dev --dry-run         # Mock email provider (no real sends)
pnpm services              # Check service status
pnpm services:stop         # Stop all services
```

### Testing

```bash
pnpm test                  # Unit tests
pnpm test:integration      # Integration tests (auto-managed infra)
pnpm test:e2e              # End-to-end tests
pnpm test:all              # All tests
```

### Monitoring

```bash
pnpm monitoring:start      # Start Prometheus + Grafana
pnpm monitoring:open       # Open Grafana dashboard
pnpm monitoring:stop       # Stop monitoring
```

### Database

```bash
pnpm db:studio             # Open visual database browser
pnpm db:push               # Push schema changes
```

### Deployment

```bash
pnpm deploy:check          # Validate before deploying
pnpm deploy:status         # Check production status
pnpm prod:logs             # View production logs
```

**See [COMMANDS.md](./COMMANDS.md) for the complete reference.**

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│  Web App (Next.js)                          │
│  http://localhost:5001                      │
│  - Create batches                           │
│  - Upload recipients                        │
│  - View analytics                           │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  PostgreSQL (Neon)                          │
│  - Users, batches, recipients               │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Worker API (Node.js + Fastify)             │
│  http://localhost:6001                      │
│  - Queue batches to NATS                    │
│  - Process emails                           │
│  - Track events                             │
└──────────────┬──────────────────────────────┘
               │
     ┌─────────┼─────────┐
     │         │         │
     ▼         ▼         ▼
┌────────┐ ┌─────┐ ┌──────────┐
│ NATS   │ │Redis│ │ClickHouse│
│ Queue  │ │Rate │ │Analytics │
└────────┘ └─────┘ └──────────┘
```

**Production:** Auto-scales 2-50 worker pods based on queue depth via KEDA.

---

## 📊 Features

### Email Sending
- **Batch Processing:** Queue thousands of emails
- **Personalization:** Handlebars templates with custom data
- **Multiple Providers:** Resend, AWS SES, or Mock
- **Rate Limiting:** Distributed rate limiting per provider
- **Retry Logic:** Automatic retries with exponential backoff

### Monitoring & Analytics
- **Real-time Events:** Track sent, delivered, opened, clicked, bounced
- **ClickHouse Analytics:** Fast queries on millions of events
- **Metrics:** Prometheus metrics for all components
- **Dashboards:** Pre-configured Grafana dashboards

### Auto-Scaling
- **KEDA Integration:** Scale based on NATS queue depth
- **0→50 pods:** Automatically scale up/down
- **Cost Efficient:** Scale to zero when idle

### Development
- **One Command:** `pnpm dev` starts everything
- **Auto-restart:** Hot reload for code changes
- **Service Discovery:** Automatic port/URL display
- **Integrated Tests:** All tests auto-manage infrastructure

---

## 🔧 Configuration

### Environment Variables

**Required in `.env.dev`:**
```bash
# Database (Neon PostgreSQL)
DATABASE_URL="postgresql://..."

# Email Provider (choose one)
RESEND_API_KEY="re_..."              # For Resend
# OR
EMAIL_PROVIDER="mock"                # For testing

# Infrastructure (auto-configured for local dev)
NATS_CLUSTER="localhost:4222"
CLICKHOUSE_URL="http://localhost:8123"
```

**See `.env.example` for complete configuration.**

---

## 🧪 Testing

All tests automatically manage their infrastructure:

```bash
# Unit tests - No infrastructure needed
pnpm test

# Integration tests - Auto-starts PostgreSQL + ClickHouse
pnpm test:integration

# E2E tests - Auto-starts full stack + worker
pnpm test:e2e
```

**No manual Docker commands needed!** Tests handle everything.

---

## 🚢 Deployment

### Production (Hetzner Kubernetes)

```bash
# 1. Check readiness
pnpm deploy:check

# 2. Encrypt secrets
./scripts/seal-secrets.sh

# 3. Commit and push
git add .
git commit -m "Deploy: description"
git push origin main
```

**GitHub Actions automatically:**
1. Builds Docker images
2. Pushes to ghcr.io
3. Deploys to Kubernetes
4. Verifies health

**Monitor deployment:**
```bash
pnpm deploy:status         # Check status
pnpm prod:logs             # View logs
```

**See [DEPLOY.md](./DEPLOY.md) and [apps/web/DEPLOYMENT.md](./apps/web/DEPLOYMENT.md) for details.**

---

## 📁 Project Structure

```
batchsender/
├── apps/
│   ├── web/              # Next.js dashboard
│   └── worker/           # Email processing worker
├── packages/
│   └── db/               # Shared database schema (Drizzle ORM)
├── scripts/              # Development & deployment scripts
│   ├── dev-unified.ts    # Main dev server
│   ├── services-*.ts     # Service management
│   ├── monitoring-*.ts   # Monitoring commands
│   └── deploy-*.ts       # Deployment tools
├── k8s/                  # Kubernetes manifests
│   ├── base/             # Base configurations
│   └── overlays/         # Environment overlays
└── infra/                # Infrastructure configs
```

---

## 🛠️ Development Tools

### Service Management
```bash
pnpm services              # Service status dashboard
pnpm services:stop         # Stop everything
```

### Database Tools
```bash
pnpm db:studio             # Visual database browser
pnpm db:push               # Apply schema changes
```

### Monitoring
```bash
pnpm monitoring:start      # Start Prometheus + Grafana
pnpm monitoring:open       # Open dashboards
```

---

## 🤝 Contributing

1. Create a feature branch
2. Make changes
3. Run tests: `pnpm test:all`
4. Commit with conventional commits
5. Push and create PR

**Code Quality:**
```bash
pnpm lint                  # Run linters
pnpm typecheck             # TypeScript checks
```

---

## 📚 Documentation

- **[COMMANDS.md](./COMMANDS.md)** - Complete command reference
- **[DEPLOY.md](./DEPLOY.md)** - Production deployment guide
- **[ENVIRONMENTS.md](./ENVIRONMENTS.md)** - Environment configuration
- **[apps/web/DEPLOYMENT.md](./apps/web/DEPLOYMENT.md)** - Web app deployment
- **[WEB_DEPLOYMENT_READY.md](./WEB_DEPLOYMENT_READY.md)** - Web deployment checklist

---

## 🐛 Troubleshooting

### Port conflicts
```bash
pnpm services:stop         # Stop all services
pnpm dev                   # Restart (auto-checks ports)
```

### Services not starting
```bash
# Check Docker is running
docker info

# View detailed logs
pnpm dev --verbose
```

### Tests failing
```bash
# Clean test infrastructure
docker compose -f apps/worker/docker-compose.test.yml down -v
pnpm test:integration
```

**See [COMMANDS.md](./COMMANDS.md#-troubleshooting) for more troubleshooting tips.**

---

## 📈 Performance

- **Throughput:** 100-500 emails/second (configurable)
- **Latency:** <100ms queue to send
- **Scale:** 2-50 worker pods (auto-scaling)
- **Storage:** 90-day event retention in ClickHouse

---

## 📄 License

MIT

---

## 🎯 Quick Links

- **Web Dashboard:** http://localhost:5001
- **Worker API:** http://localhost:6001
- **Grafana:** http://localhost:3003 (after `pnpm monitoring:start`)
- **Database Studio:** http://localhost:4983 (after `pnpm db:studio`)

---

**Ready to start?** Run `pnpm dev` and visit http://localhost:5001
