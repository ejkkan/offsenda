# Quick Start: Queue-Depth Autoscaling

This is the TL;DR version. For full documentation, see [README.md](./README.md).

## What This Does

Your workers will now **automatically scale** based on how many messages are waiting in the NATS queue:
- More messages → more workers (scale up fast)
- Empty queue → fewer workers (scale down slowly to save $)

**Before:** Fixed number of workers, slow during load spikes
**After:** Automatic scaling, 2-50 workers based on demand

## Prerequisites

- Kubernetes cluster with Prometheus installed
- kubectl access to the cluster

## 5-Minute Setup

### 1. Install Prometheus Adapter (1 min)

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --create-namespace \
  --values k8s/monitoring/prometheus-adapter-values.yaml
```

### 2. Deploy ServiceMonitor (30 sec)

```bash
kubectl apply -f k8s/monitoring/prometheus-servicemonitor.yaml
```

### 3. Apply Updated HPA (30 sec)

```bash
kubectl apply -f k8s/base/worker/hpa.yaml
```

### 4. Verify It's Working (1 min)

```bash
# Check HPA status (should show both CPU and queue depth)
kubectl get hpa worker-hpa -n batchsender

# Expected output:
# NAME         REFERENCE           TARGETS                    MINPODS   MAXPODS   REPLICAS
# worker-hpa   Deployment/worker   0/1000, 15%/60%            2         50        2
#                                  ↑ queue  ↑ CPU
```

**If you see `<unknown>` for the queue metric**, wait 2-3 minutes for Prometheus to start scraping, then check again.

## Test It

### Quick Load Test

```bash
# 1. Check current worker count
kubectl get pods -n batchsender -l app=batchsender-worker

# 2. Create a large batch via API (use your API key)
# This will queue thousands of messages

# 3. Watch workers scale up
kubectl get pods -n batchsender -l app=batchsender-worker -w

# You should see new worker-xxx pods appear within 30-60 seconds
```

### Monitor Scaling

```bash
# Watch HPA make scaling decisions
kubectl describe hpa worker-hpa -n batchsender

# Check queue depth metric
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/batchsender/pods/*/nats_queue_depth_batch_processor" | jq '.items[0].value'
```

## Configuration

### Scale More Aggressively

Edit `k8s/base/worker/hpa.yaml`, change:

```yaml
averageValue: "500"  # Scale up at 500 msgs/pod instead of 1000
```

### Allow More Workers

```yaml
maxReplicas: 100  # Allow up to 100 workers (default: 50)
```

Apply changes:
```bash
kubectl apply -f k8s/base/worker/hpa.yaml
```

## Troubleshooting

### ❌ HPA shows `<unknown>` for queue metric

**Fix:**
```bash
# Check Prometheus Adapter is running
kubectl get pods -n monitoring | grep prometheus-adapter

# Check logs
kubectl logs -n monitoring -l app.kubernetes.io/name=prometheus-adapter

# Verify custom metrics API is available
kubectl get apiservice v1beta1.custom.metrics.k8s.io
```

### ❌ Workers not scaling despite queue backup

**Check:**
```bash
# 1. Is the metric being scraped?
kubectl exec -n batchsender deploy/worker -- curl -s localhost:3000/api/metrics | grep nats_queue_depth

# 2. Is Prometheus collecting it?
# Port-forward: kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090
# Open http://localhost:9090, query: nats_queue_depth{consumer="batch-processor"}

# 3. Can HPA read it?
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/batchsender/pods/*/nats_queue_depth_batch_processor"
```

### ❌ Prometheus not installed

If you don't have Prometheus yet:

```bash
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

## Expected Behavior

| Queue Depth | Workers | What Happens |
|------------|---------|--------------|
| 0-2,000 msgs | 2 (min) | Baseline, handles normal traffic |
| 5,000 msgs | ~5 workers | Small spike, scales up moderately |
| 20,000 msgs | ~20 workers | Large spike, scales up aggressively |
| 50,000+ msgs | 50 (max) | At capacity, may need to increase maxReplicas |

**Scale up:** 30 seconds (fast response to spikes)
**Scale down:** 5 minutes (avoids thrashing)

## Cost Impact

**Before autoscaling:**
- 20 workers × 24/7 = ~$720/month

**After autoscaling:**
- 2 workers baseline + spikes = ~$126/month
- **Saves ~$600/month** 💰

## What Changed?

### Code Changes
1. ✅ `apps/worker/src/nats/monitoring.ts` - Now collects queue depth per consumer
2. ✅ `apps/worker/src/api.ts` - Exposes `nats_queue_depth` metric in Prometheus format

### Kubernetes Changes
1. ✅ `k8s/base/worker/hpa.yaml` - HPA now scales on queue depth + CPU
2. ✅ `k8s/monitoring/prometheus-adapter-values.yaml` - Translates Prometheus → K8s metrics
3. ✅ `k8s/monitoring/prometheus-servicemonitor.yaml` - Tells Prometheus to scrape workers

### Behavior Changes
- **minReplicas: 1 → 2** (always keep 2 workers for availability)
- **maxReplicas: 20 → 50** (can scale higher during large spikes)

## Next Steps

1. ✅ Deploy to staging, test with real load
2. Monitor for 24-48 hours, adjust thresholds if needed
3. Set up Grafana dashboard (optional but recommended)
4. Deploy to production

## Full Documentation

See [README.md](./README.md) for:
- Architecture details
- Advanced tuning
- Monitoring & alerting setup
- Complete troubleshooting guide
