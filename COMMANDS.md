# BatchSender Command Reference

Complete guide to all available commands in the BatchSender project.

---

## 🚀 Development

### Start Development Server

```bash
pnpm dev                    # Start all services (auto-detects mode)
pnpm dev --mode=docker      # Force Docker Compose mode
pnpm dev --mode=k8s         # Force Kubernetes mode
pnpm dev --dry-run          # Mock email provider
pnpm dev --verbose          # Show detailed logs
```

**What it does:**
1. Validates environment (.env.dev)
2. Checks port availability
3. Auto-detects best mode (K8s or Docker)
4. Starts infrastructure (PostgreSQL, NATS, ClickHouse, Dragonfly)
5. Starts monitoring (Prometheus + Grafana) if configured
6. Starts Web App (localhost:5001)
7. Starts Worker API (localhost:6001)
8. Shows service dashboard with all URLs
9. Streams live logs

**Startup time:** ~30-45 seconds

---

### Service Management

```bash
pnpm services              # Show service status dashboard
pnpm services:stop         # Stop all services (Docker + Node processes)
```

**Service Status Dashboard:**
- Real-time health checks
- Port and URL information
- Running/stopped status
- Quick action suggestions

---

### Individual Components

```bash
pnpm dev:web               # Start web app only (local DB)
pnpm dev:web:prod          # Start web app with production DB
pnpm dev:worker            # Start worker only
```

**Use when:** You only need specific services running.

---

## 📊 Monitoring

```bash
pnpm monitoring:start      # Start Prometheus + Grafana
pnpm monitoring:stop       # Stop monitoring stack
pnpm monitoring:open       # Open Grafana dashboard in browser
pnpm monitoring:logs       # View monitoring logs
```

**Monitoring Stack:**
- **Prometheus:** http://localhost:9095
- **Grafana:** http://localhost:3003 (admin/admin)
- **Dashboard:** Pre-configured BatchSender metrics

**Memory:** ~500MB when running

---

## 🧪 Testing

### Unit Tests

```bash
pnpm test                  # Run unit tests
pnpm test:unit             # Run unit tests (explicit)
```

**No infrastructure needed** - Tests run in-memory.

### Integration Tests

```bash
pnpm test:integration      # Run integration tests (auto-managed infra)
```

**Auto-managed infrastructure:**
- Automatically starts PostgreSQL + ClickHouse in Docker
- Runs tests
- Automatically tears down infrastructure

**Before:** Manual `docker compose up/down` required
**Now:** Just run the command!

### E2E Tests

```bash
pnpm test:e2e              # Run end-to-end tests
pnpm test:e2e:watch        # Run E2E tests in watch mode
```

**Fully automated:**
- Starts full Docker infrastructure
- Starts worker process
- Runs comprehensive flow tests
- Cleans up automatically

### All Tests

```bash
pnpm test:all              # Run unit + integration + E2E tests
```

**Total time:** ~5-10 minutes for full suite

### Load Tests

```bash
pnpm test:load             # Run load test (default: 5 batches × 5k recipients)
pnpm test:load:small       # Small load test (2 batches × 1k recipients)
pnpm test:load:large       # Large load test (10 batches × 10k recipients)
pnpm test:load:stress      # Stress test (20 batches × 20k recipients)
```

**What it does:**
- Creates multiple test batches with synthetic recipients
- Queues all batches for sending
- Monitors KEDA autoscaling behavior in real-time
- Shows HPA status, worker pod count, and queue depth every 10 seconds

**Requirements:**
- `API_KEY` environment variable set
- kubectl access to cluster
- Running BatchSender deployment

**Example:**
```bash
API_KEY=your-key pnpm test:load:large
```

**Custom load test:**
```bash
API_KEY=your-key pnpm test:load --batches=15 --recipients=8000
```

---

## 🏗️ Building

```bash
pnpm build                 # Build all packages
pnpm build:web             # Build web app only
pnpm build:worker          # Build worker only
```

---

## 🗄️ Database

```bash
pnpm db:push               # Push schema changes to database
pnpm db:push:local         # Push to local database
pnpm db:push:remote        # Push to remote database
pnpm db:migrate            # Run migrations
pnpm db:studio             # Open Drizzle Studio
pnpm db:studio:local       # Open studio for local DB
pnpm db:backup             # Backup ClickHouse to B2
pnpm db:backup:full        # Full backup
pnpm db:backup:incremental # Incremental backup
pnpm db:restore            # Restore from backup
```

**Drizzle Studio:** Visual database browser at http://localhost:4983

---

## 🚢 Deployment

### Pre-Deployment Validation

```bash
pnpm deploy:check          # Validate deployment readiness
```

**Checks:**
- ✓ kubectl installed
- ✓ kubeseal installed
- ✓ kubeconfig exists
- ✓ Sealed secrets cert exists
- ✓ .env.prod configured
- ✓ K8s manifests valid
- ✓ Docker images buildable

**Use before:** Pushing to main or creating PRs

### Secret Management

```bash
pnpm secrets:seal          # Encrypt production secrets
```

**What it does:**
- Reads `.env.prod`
- Validates all required variables
- Encrypts secrets with kubeseal
- Generates sealed-secrets YAML files (safe to commit)

### Deployment Status

```bash
pnpm deploy:status         # Check production deployment status
pnpm deploy:verify         # Run comprehensive health checks
```

**Status shows:**
- Pod status and health
- Deployment readiness
- Service endpoints
- Ingress configuration
- Recent events

**Verify checks:**
- Namespace exists
- PostgreSQL, DragonflyDB, NATS, ClickHouse ready
- Worker deployment available
- KEDA autoscaling configured
- Health and metrics endpoints responding

---

## 🌍 Production

### View Logs

```bash
pnpm prod:logs             # Stream production worker logs
```

**Live streaming** from all worker pods in production.

### Access Shell

```bash
pnpm prod:shell            # Open shell in production worker pod
```

**Use for:** Debugging, inspecting files, running one-off commands

**⚠️ Warning:** Production environment - be careful!

---

## ☸️ Kubernetes (Local Development)

```bash
pnpm k8s:logs              # View worker logs
pnpm k8s:logs:all          # View all container logs
pnpm k8s:shell             # Access worker shell
pnpm k8s:pods              # Watch pod status
pnpm k8s:events            # View recent events
pnpm k8s:restart           # Restart worker deployment
pnpm k8s:cleanup           # Delete local k3d cluster
```

---

## ☁️ Cluster Management

### Bootstrap Infrastructure

```bash
pnpm cluster:bootstrap     # Install infrastructure components
```

**What it does:**
1. Checks prerequisites (kubeconfig, kubectl, helm, kubeseal)
2. Installs Metrics Server (CPU/memory metrics)
3. Installs KEDA (worker autoscaling)
4. Installs Sealed Secrets (secret encryption)
5. Fetches and saves sealed-secrets certificate
6. Installs Prometheus + Grafana (monitoring)
7. Installs cert-manager (SSL certificates)

**When to use:**
- Once during initial cluster setup
- After creating a new production cluster

**Prerequisites:**
- `./kubeconfig` file exists
- kubectl, helm, kubeseal installed

**Time:** 10-15 minutes

### Destroy Cluster

```bash
pnpm cluster:destroy       # Destroy Hetzner k3s cluster
```

**⚠️ DANGER:** This permanently deletes:
- All nodes (masters + workers)
- All load balancers
- All volumes
- All data (databases, ClickHouse, etc.)

**Safety:**
- Requires typing "destroy" to confirm
- Shows cluster info before destruction
- Optionally cleans up local files (kubeconfig, sealed-secrets-cert.pem)

**Prerequisites:**
- `cluster-config.yaml` exists
- hetzner-k3s CLI installed

---

## 🔧 Code Quality

```bash
pnpm lint                  # Run linters
pnpm typecheck             # TypeScript type checking
```

---

## 🎯 Quick Reference

### First Time Setup

```bash
# 1. Clone and install
git clone <repo>
cd batchsender
pnpm install

# 2. Configure environment
cp .env.example .env.dev
# Edit .env.dev with your values

# 3. Start development
pnpm dev
```

### Daily Development Workflow

```bash
# Start your day
pnpm dev                   # Start everything

# Check what's running
pnpm services              # View service status

# Run tests before committing
pnpm test:all              # Full test suite

# Stop for the day
pnpm services:stop         # Clean shutdown
```

### Before Deploying

```bash
# 1. Validate
pnpm deploy:check          # Pre-flight checks

# 2. Seal secrets
pnpm secrets:seal          # Encrypt production secrets

# 3. Commit and push
git add .
git commit -m "feat: description"
git push origin main       # Auto-deploys via GitHub Actions

# 4. Monitor deployment
pnpm deploy:status         # Check deployment status
pnpm deploy:verify         # Run comprehensive health checks
pnpm prod:logs             # Watch logs
```

---

## 📝 Environment Files

- `.env.dev` - Local development (you create this)
- `.env.prod` - Production secrets (you create this, never commit)
- `.env.test` - Test environment (committed)
- `.env.example` - Template (committed)

---

## 🆘 Troubleshooting

### Port Conflicts

```bash
pnpm services:stop         # Stop all services
pnpm dev                   # Restart (auto-checks ports)
```

### Services Not Starting

```bash
# Check Docker is running
docker info

# View detailed logs
pnpm dev --verbose

# Check specific service
pnpm services
```

### Tests Failing

```bash
# Clean test infrastructure
docker compose -f apps/worker/docker-compose.test.yml down -v

# Run tests again
pnpm test:integration
```

### Production Issues

```bash
# Check status
pnpm deploy:status

# View logs
pnpm prod:logs

# Access shell for debugging
pnpm prod:shell
```

---

## 👤 User Management

```bash
pnpm user:create           # Create a new user
pnpm user:api-key          # Generate API key for a user
```

**Use for:** Creating users and managing API access to the system

---

## 🎓 Learn More

- **Development Guide:** See README.md
- **Testing Guide:** See apps/worker/README.md
- **Deployment Guide:** See apps/web/DEPLOYMENT.md
- **Web App:** See apps/web/README.md

---

## 💡 Tips

**Speed up startup:**
```bash
pnpm dev --no-monitoring   # Skip monitoring stack
```

**Debug mode:**
```bash
DEBUG_WORKER=true pnpm dev  # Show worker debug logs
```

**Clean slate:**
```bash
pnpm services:stop
pnpm dev --clean            # Rebuild everything
```

**Check everything is healthy:**
```bash
pnpm services
pnpm monitoring:open
```

---

**Questions?** Check the issue tracker or documentation files.
