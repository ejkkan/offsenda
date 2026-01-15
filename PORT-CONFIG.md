# BatchSender Port Configuration

## Updated Port Assignments (No Conflicts)

To avoid conflicts with other containers, we've updated the ports:

### Service Ports:
- **PostgreSQL**: `5455` (changed from 5433)
- **NATS**: `4222` (standard)
- **ClickHouse HTTP**: `8123` (standard)
- **ClickHouse Native**: `9000` (standard)
- **DragonflyDB**: `6379` (Redis-compatible)
- **Prometheus**: `9095` (changed from 9090 to avoid conflicts)
- **Grafana**: `3003` (changed from 3000 to avoid Next.js conflicts)
- **Worker API**: `6001`
- **Web Dashboard**: `3000` (Next.js default)

### What Was Updated:
1. **PostgreSQL**: 5433 → 5455 (avoids conflicts with other Postgres containers)
2. **Grafana**: Already on 3003 (avoids Next.js conflict)

### Files Updated:
- `docker-compose.local.yml` - PostgreSQL port
- `.env.dev` - DATABASE_URL
- `setup-dev.sh` - Database connection string

### Quick Check for Port Conflicts:
```bash
# Check if any ports are already in use
lsof -i :5455  # PostgreSQL
lsof -i :4222  # NATS
lsof -i :8123  # ClickHouse
lsof -i :6379  # DragonflyDB
lsof -i :9090  # Prometheus
lsof -i :3003  # Grafana
lsof -i :6001  # Worker API
lsof -i :3000  # Web Dashboard
```

### If You Still Have Conflicts:
Change the PostgreSQL port in these files:
1. `docker-compose.local.yml` - the ports mapping
2. `.env.dev` - DATABASE_URL
3. `setup-dev.sh` - both DATABASE_URL references

Example for port 5477:
```yaml
# docker-compose.local.yml
ports:
  - "5477:5432"

# .env.dev
DATABASE_URL="postgresql://batchsender:batchsender@localhost:5477/batchsender"
```