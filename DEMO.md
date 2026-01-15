# BatchSender Demo Guide

## 🚀 One Command to Rule Them All

```bash
pnpm demo
```

This single command will:
1. ✅ Start monitoring (Prometheus + Grafana)
2. ✅ Start all services (PostgreSQL, NATS, ClickHouse, etc.)
3. ✅ Start the worker API
4. ✅ Start the web dashboard
5. ✅ Open Grafana in your browser
6. ✅ Create test batches automatically
7. ✅ Show live metrics

## 📊 What You'll See

### Grafana Dashboard (http://localhost:3003)
- **Login**: admin/admin
- **Real-time metrics**:
  - NATS queue depth
  - Pending messages
  - Processing rates
- Updates every 5 seconds

### Web Dashboard (http://localhost:5001)
- Create batches via UI
- View batch status
- Manage recipients
- User authentication

### API Endpoints (http://localhost:6001)
- REST API for batch operations
- Metrics endpoint
- Health checks

## 🧪 Generate More Load

Run this anytime to create more test batches:
```bash
pnpm demo:test
```

This creates random-sized batches (5-500 recipients) to simulate real traffic.

## 🛑 Stop Everything

```bash
pnpm demo:stop
```

## 📈 Watch Metrics Change

1. Run `pnpm demo`
2. Open Grafana: http://localhost:3003
3. Watch the "BatchSender Monitoring" dashboard
4. Run `pnpm demo:test` multiple times
5. See queues fill up and process

## 🔍 Debugging

### Check logs:
```bash
# Worker logs
tail -f worker.log

# Web app logs
tail -f web.log

# All Docker logs
pnpm monitoring:logs
```

### Check metrics directly:
```bash
# Raw metrics
curl http://localhost:6001/api/metrics

# Queue status
curl http://localhost:6001/api/queue/status -H "Authorization: Bearer test-key" | jq
```

## 🎯 What to Look For

### In Grafana:
- Queue depth spikes when batches are created
- Gradual decrease as emails are processed
- Different queues for batch vs email vs priority

### In the Web Dashboard:
- Batch status changes: draft → queued → processing → completed
- Progress percentage updates
- Individual recipient statuses

## 🚦 Health Checks

- Worker API: http://localhost:6001/health
- NATS: http://localhost:8222/healthz
- Prometheus: http://localhost:9090/-/healthy
- Grafana: http://localhost:3003/api/health

## 💡 Tips

1. **First time?** Login to Grafana with admin/admin
2. **No data?** Wait 30 seconds for first metrics scrape
3. **Create bigger batches** for more dramatic metric changes
4. **Multiple terminals** to see logs while running tests