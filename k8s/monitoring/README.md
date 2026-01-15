# Queue-Depth Based Autoscaling Setup

This directory contains configuration for queue-depth based autoscaling using Prometheus and Prometheus Adapter.

## Overview

The HPA (Horizontal Pod Autoscaler) now scales workers based on **two metrics**:
1. **CPU Utilization** (existing) - scales when CPU > 60%
2. **NATS Queue Depth** (new) - scales when >1000 messages per pod in the batch-processor queue

This ensures workers scale up when there's a backlog in the queue, even if CPU is low (e.g., waiting on network I/O for email sending).

## Architecture

```
Worker Pod (/api/metrics)
    ↓ exposes nats_queue_depth metric
Prometheus (scrapes every 30s)
    ↓ stores time-series data
Prometheus Adapter
    ↓ translates to Kubernetes custom metrics API
HPA (checks every 15s)
    ↓ scales worker deployment
Kubernetes (adds/removes pods)
```

## Prerequisites

1. **Prometheus** must be installed in your cluster
2. **Prometheus Operator** (for ServiceMonitor support)
3. Kubernetes 1.23+ (for HPA v2 API)

## Installation Steps

### Step 1: Install Prometheus Stack (if not already installed)

```bash
# Add Prometheus community Helm repo
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Install kube-prometheus-stack (includes Prometheus, Grafana, AlertManager)
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

The last flag (`serviceMonitorSelectorNilUsesHelmValues=false`) allows Prometheus to discover ServiceMonitors in any namespace.

### Step 2: Deploy ServiceMonitor

This tells Prometheus to scrape the worker metrics endpoint.

```bash
kubectl apply -f k8s/monitoring/prometheus-servicemonitor.yaml
```

**Verify Prometheus is scraping:**

```bash
# Port-forward to Prometheus
kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090

# Open http://localhost:9090 and query: nats_queue_depth
# You should see metrics with consumer labels
```

### Step 3: Install Prometheus Adapter

```bash
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --values k8s/monitoring/prometheus-adapter-values.yaml
```

**Verify the adapter is working:**

```bash
# Check custom metrics are available
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | jq .

# Check specific metric
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/batchsender/pods/*/nats_queue_depth_batch_processor" | jq .

# You should see values returned (might be 0 if no messages in queue)
```

### Step 4: Deploy Updated HPA

The HPA configuration is already updated in `k8s/base/worker/hpa.yaml`. Apply it:

```bash
# Apply the updated HPA
kubectl apply -f k8s/base/worker/hpa.yaml
```

**Verify HPA is using both metrics:**

```bash
kubectl get hpa worker-hpa -n batchsender -w

# Output should show both CPU and custom metrics:
# NAME         REFERENCE           TARGETS                                      MINPODS   MAXPODS   REPLICAS
# worker-hpa   Deployment/worker   0/1000 (nats_queue_depth...), 15%/60% (cpu)  2         50        2
```

## Testing the Autoscaling

### Test 1: Manual Load Test

Generate a large batch to trigger autoscaling:

```bash
# Create a test batch with 10,000 recipients
curl -X POST http://your-api/api/batches \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Load Test Batch",
    "subject": "Test Email",
    "fromEmail": "test@example.com",
    "htmlContent": "<p>Test</p>",
    "recipients": [ /* 10,000 recipient objects */ ]
  }'

# Start sending the batch
curl -X POST http://your-api/api/batches/{batch_id}/send \
  -H "Authorization: Bearer YOUR_API_KEY"

# Watch HPA and pods scale up
kubectl get hpa worker-hpa -n batchsender -w
kubectl get pods -n batchsender -l app=batchsender-worker -w
```

**Expected behavior:**
- Queue fills with messages
- HPA detects >1000 messages per pod
- New worker pods spin up within 30-60 seconds
- Batch processes faster with more workers
- After batch completes, pods scale back down (after 5 min stabilization)

### Test 2: Monitor Metrics During Scale

```bash
# Watch queue depth in real-time
watch -n 2 'kubectl exec -n batchsender deploy/worker -- curl -s localhost:3000/api/metrics | grep nats_queue_depth'

# Watch HPA decisions
kubectl describe hpa worker-hpa -n batchsender

# Check HPA logs for scaling events
kubectl get events -n batchsender --sort-by='.lastTimestamp' | grep HorizontalPodAutoscaler
```

### Test 3: Verify Scale Down

After the queue is empty:

```bash
# Verify queue is empty
kubectl exec -n batchsender deploy/worker -- curl -s localhost:3000/api/metrics | grep nats_queue_depth

# Wait 5 minutes (stabilization window)
# Then check if pods scaled down to minReplicas (2)
kubectl get pods -n batchsender -l app=batchsender-worker
```

## Configuration Tuning

### Adjust Scale Thresholds

Edit `k8s/base/worker/hpa.yaml`:

```yaml
# Scale up if more than X messages per pod
- type: Pods
  pods:
    metric:
      name: nats_queue_depth_batch_processor
    target:
      type: AverageValue
      averageValue: "1000"  # <-- Change this value
```

**Recommendations:**
- **Lower value (e.g., 500)**: More aggressive scaling, higher costs, faster processing
- **Higher value (e.g., 2000)**: Less aggressive, lower costs, slower response to load spikes
- **Monitor p95 batch completion times** to find the sweet spot

### Adjust Min/Max Replicas

```yaml
minReplicas: 2    # Always keep at least 2 workers running
maxReplicas: 50   # Cap at 50 workers (adjust based on costs/limits)
```

### Adjust Scale Speed

```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 30  # How long to wait before scaling up
    policies:
    - type: Pods
      value: 4                       # Add up to 4 pods at a time
      periodSeconds: 30              # Every 30 seconds
  scaleDown:
    stabilizationWindowSeconds: 300  # Wait 5 min before scaling down (avoid thrashing)
```

## Monitoring & Alerts

### Key Metrics to Track

1. **nats_queue_depth_batch_processor** - Pending messages
2. **worker pod count** - Current replicas
3. **batch completion time** - End-to-end latency
4. **HPA scaling events** - Frequency of scale up/down

### Recommended Grafana Dashboard

Query examples:

```promql
# Average queue depth per pod
avg(nats_queue_depth{consumer="batch-processor"}) / count(kube_pod_info{namespace="batchsender", pod=~"worker-.*"})

# Worker pod count over time
count(kube_pod_info{namespace="batchsender", pod=~"worker-.*"})

# Scaling events (requires kube-state-metrics)
sum(rate(kube_hpa_status_condition{namespace="batchsender", hpa="worker-hpa"}[5m]))
```

### Alerting Rules

Add to AlertManager:

```yaml
groups:
- name: autoscaling
  rules:
  - alert: HighQueueDepthNotScaling
    expr: avg(nats_queue_depth{consumer="batch-processor"}) > 5000 AND count(kube_pod_info{namespace="batchsender", pod=~"worker-.*"}) < 10
    for: 5m
    annotations:
      summary: "Queue depth high but not enough workers"
      description: "Queue has {{ $value }} messages but only {{ $labels.pod_count }} workers running"

  - alert: HPAMaxedOut
    expr: kube_hpa_status_current_replicas{namespace="batchsender", hpa="worker-hpa"} >= kube_hpa_spec_max_replicas{namespace="batchsender", hpa="worker-hpa"}
    for: 10m
    annotations:
      summary: "HPA at maximum replicas"
      description: "Worker HPA has been at max replicas for 10+ minutes"
```

## Troubleshooting

### HPA shows "unknown" for custom metric

**Symptom:**
```bash
kubectl get hpa worker-hpa -n batchsender
# TARGETS: <unknown>/1000
```

**Possible causes:**
1. Prometheus Adapter not installed or not running
2. Prometheus not scraping worker metrics
3. Metric name mismatch in adapter config

**Debug steps:**
```bash
# Check if Prometheus Adapter is running
kubectl get pods -n monitoring | grep prometheus-adapter

# Check adapter logs
kubectl logs -n monitoring -l app.kubernetes.io/name=prometheus-adapter --tail=50

# Verify custom metrics API
kubectl get apiservice v1beta1.custom.metrics.k8s.io
```

### Workers not scaling despite high queue depth

**Check:**
1. HPA is using the metric: `kubectl describe hpa worker-hpa -n batchsender`
2. Metric value is above threshold: `kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/batchsender/pods/*/nats_queue_depth_batch_processor"`
3. Check HPA events: `kubectl get events -n batchsender | grep worker-hpa`
4. Ensure cluster has resources: `kubectl describe nodes`

### Metrics not appearing in Prometheus

**Check:**
1. ServiceMonitor is created: `kubectl get servicemonitor -n batchsender`
2. Worker service has correct labels: `kubectl get svc -n batchsender worker -o yaml`
3. Prometheus targets: Port-forward Prometheus (port 9090) → Status → Targets

## Cost Estimation

**Assumptions:**
- Average worker: 0.5 CPU, 512Mi RAM
- Cloud provider: ~$0.05/hour per worker
- Average load: 2 workers baseline, spikes to 20 workers for 2 hours/day

**Monthly cost:**
- Baseline (2 workers × 24h × 30d): $72
- Spikes (18 workers × 2h × 30d): $54
- **Total: ~$126/month**

Compare to fixed 20 workers 24/7: ~$720/month
**Savings: ~$594/month (82% reduction)**

## Next Steps

1. ✅ Deploy and test in staging environment
2. ✅ Monitor for 48 hours, adjust thresholds
3. ✅ Set up Grafana dashboards
4. ✅ Configure AlertManager alerts
5. ✅ Deploy to production during low-traffic window
6. Document runbook for incidents

## References

- [Kubernetes HPA Documentation](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [Prometheus Adapter](https://github.com/kubernetes-sigs/prometheus-adapter)
- [Custom Metrics API](https://github.com/kubernetes/metrics)
