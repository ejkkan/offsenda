# BatchSender Architecture & Development Setup

## Core Architecture Principles

### 1. **Authentication Strategy**
- **Public endpoints** (no auth required):
  - `/health` - Health checks
  - `/api/metrics` - Prometheus metrics
  - `/webhooks/*` - Provider webhooks

- **Protected endpoints** (require API key):
  - `/api/batches/*` - Batch operations
  - `/api/analytics/*` - Analytics data
  - `/api/queue/*` - Queue management

### 2. **Environment Structure**
```
Local Development:
├── Database: PostgreSQL (port 5433)
├── Queue: NATS JetStream (port 4222)
├── Analytics: ClickHouse (port 8123)
├── Cache: DragonflyDB (port 6379)
├── Monitoring: Prometheus (port 9090) + Grafana (port 3003)
├── Worker API: Port 6001
└── Web Dashboard: Port 3000 (Next.js)

Production (Hetzner):
├── Kubernetes cluster with same services
├── Persistent volumes for data
├── SSL/TLS termination
└── Horizontal autoscaling
```

### 3. **Data Flow**
```
User → Web/API → PostgreSQL → NATS Queue → Workers → Email Provider
                     ↓           ↓             ↓
                ClickHouse   Prometheus    Webhooks
                     ↓           ↓             ↓
                 Analytics   Grafana    Update Status
```

## Development Setup

### Quick Start (One Command)
```bash
# This should work every time without manual fixes:
./setup-dev.sh
```

This script will:
1. Check prerequisites
2. Set up databases with proper schemas
3. Create test users and API keys
4. Start all services
5. Open monitoring dashboards
6. Show test commands

### Service Dependencies
```yaml
startup_order:
  1_infrastructure:
    - PostgreSQL
    - NATS
    - ClickHouse
    - DragonflyDB
  2_monitoring:
    - Prometheus
    - Grafana
  3_application:
    - Worker API
    - Web Dashboard
```

## Key Design Decisions

### 1. **Metrics Without Auth**
The `/api/metrics` endpoint MUST be public for Prometheus. Security through:
- Network isolation (internal only in production)
- No sensitive data in metrics
- Standard Prometheus format

### 2. **Database Initialization**
- Schema auto-migration on startup
- Seed data for development
- Idempotent operations

### 3. **Monitoring First**
- Start monitoring before services
- All services expose metrics
- Dashboards pre-configured
- Alerts for critical paths

### 4. **Environment Variables**
- `.env.dev` - Local development (committed)
- `.env.prod` - Production (git-ignored)
- `.env.test` - Testing
- Environment validation on startup

## Testing Strategy

### Local Testing Flow
1. Unit tests - No infrastructure needed
2. Integration tests - Dockerized dependencies
3. E2E tests - Full stack with monitoring
4. Load tests - Verify autoscaling

### Monitoring Verification
```bash
# Should see metrics immediately:
curl http://localhost:6001/api/metrics | grep nats_queue_depth

# Should see in Prometheus:
http://localhost:9090/graph?g0.expr=nats_queue_depth

# Should see in Grafana:
http://localhost:3003/d/batchsender/batchsender-monitoring
```

## Production Deployment

### Hetzner Kubernetes Setup
```bash
# One command deployment:
./deploy-hetzner.sh
```

Features:
- Terraform infrastructure as code
- Helm charts for services
- Automatic SSL certificates
- Persistent volume management
- Backup strategies

### Scaling Strategy
- Workers: 2-50 pods based on queue depth
- Triggers: CPU > 60% OR Queue > 1000 msgs/pod
- Database: Vertical scaling as needed
- Monitoring: Single instance (sufficient)