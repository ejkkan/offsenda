# Local Monitoring Setup Guide

This guide helps you set up and test the monitoring stack locally before deploying to production.

## Quick Start

```bash
# 1. Start monitoring stack
pnpm monitoring:start

# 2. Start your application
pnpm dev:simple

# 3. Access dashboards
# Prometheus: http://localhost:9090
# Grafana: http://localhost:3003 (admin/admin)
```

## What's Included

### Monitoring Stack
- **Prometheus**: Metrics collection and storage
- **Grafana**: Pre-configured dashboard for BatchSender
- **Node Exporter**: System metrics (CPU, memory, disk)

### Pre-configured Dashboard
The Grafana dashboard shows:
- NATS queue depth by consumer
- Total pending messages
- Queue pending by type (batch/email/priority)
- Real-time updates every 5 seconds

## Testing Metrics Collection

### 1. Verify Worker Metrics
```bash
# Check that your worker is exposing metrics
curl localhost:6001/api/metrics | grep nats_queue

# You should see:
# nats_queue_depth{consumer="batch-processor"} 0
# nats_queue_depth{consumer="priority-processor"} 0
```

### 2. Verify Prometheus Scraping
```bash
# Open Prometheus UI
open http://localhost:9090

# Query for your metrics
# Try: nats_queue_depth
# Try: queue_batch_pending
```

### 3. Generate Test Load
```bash
# Create a test batch to see metrics change
curl -X POST http://localhost:6001/api/batches \
  -H "Authorization: Bearer test-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Batch",
    "from": {"email": "test@example.com", "name": "Test"},
    "subject": "Test",
    "htmlContent": "<p>Test</p>",
    "provider": "mock",
    "recipients": [{"email": "user1@example.com"}, {"email": "user2@example.com"}]
  }'
```

## Understanding the Metrics

### Queue Metrics
- `nats_queue_depth`: Messages waiting per consumer
- `nats_pending_messages`: Total messages in NATS
- `queue_batch_pending`: Batches waiting to process
- `queue_email_pending`: Individual emails queued
- `queue_priority_pending`: Priority emails queued

### System Metrics (via Node Exporter)
- `node_cpu_seconds_total`: CPU usage
- `node_memory_MemAvailable_bytes`: Available memory
- `node_filesystem_avail_bytes`: Disk space

## Testing Autoscaling Locally

To test autoscaling behavior with k3d:

```bash
# 1. Start k3d cluster with monitoring
pnpm dev  # This uses k3d/k8s mode

# 2. Install Prometheus in k3d
kubectl create namespace monitoring
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false

# 3. Apply ServiceMonitor
kubectl apply -f k8s/monitoring/prometheus-servicemonitor.yaml

# 4. Install Prometheus Adapter
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --values k8s/monitoring/prometheus-adapter-values.yaml

# 5. Watch HPA scale based on queue depth
kubectl get hpa -n batchsender -w
```

## Monitoring Commands

```bash
# Start monitoring
pnpm monitoring:start

# Stop monitoring
pnpm monitoring:stop

# View logs
pnpm monitoring:logs

# Access Grafana
open http://localhost:3003

# Access Prometheus
open http://localhost:9090
```

## Troubleshooting

### Metrics not appearing in Prometheus
1. Check worker is running: `docker ps | grep worker`
2. Check metrics endpoint: `curl localhost:6001/api/metrics`
3. Check Prometheus targets: http://localhost:9090/targets

### Grafana dashboard empty
1. Wait 30-60 seconds for data collection
2. Check datasource: Settings → Data Sources → Prometheus
3. Verify time range is set to "Last 30 minutes"

### Port conflicts
- Grafana uses port 3003 (instead of 3000) to avoid conflicts
- Prometheus uses port 9090
- Change ports in `docker-compose.monitoring.yml` if needed

## Next Steps

Once local monitoring is working:
1. Deploy to Hetzner with the same stack
2. Configure production dashboards
3. Set up alerts for queue depth thresholds
4. Add custom business metrics