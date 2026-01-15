# Prometheus Storage & Backup Strategy

## How Prometheus Stores Data

### Local Time-Series Database (TSDB)
Prometheus stores metrics in a **local time-series database** on disk:
- Data location: `/prometheus` directory (in container)
- Format: Custom TSDB format optimized for time-series data
- Compression: Highly compressed (typically 1-3 bytes per sample)

### Default Storage Behavior

```yaml
# Local Docker setup (already configured)
volumes:
  prometheus_data:  # Named volume - survives container restarts

# Data retention settings:
--storage.tsdb.retention.time=30d   # Keep last 30 days
--storage.tsdb.retention.size=10GB  # Max 10GB disk usage
```

## Storage Persistence Levels

### 1. **Local Development** (Current Setup)
- ✅ Data persists between container restarts
- ❌ Data lost if you run `docker volume prune`
- Good for: Testing, development
- Backup: Not critical

### 2. **Production on Hetzner**
- ✅ Persistent volumes (PVC) in Kubernetes
- ✅ Data survives pod restarts/moves
- ❌ Data lost if PVC deleted or node fails
- Good for: Production with backup strategy

### 3. **Long-term Storage** (Optional)
- Remote storage solutions for historical data
- Options: Thanos, Cortex, VictoriaMetrics
- Good for: Multi-year retention, compliance

## Production Storage Configuration

### Kubernetes PVC (Recommended for Hetzner)

```yaml
# k8s/monitoring/prometheus-storage.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: prometheus-storage
  namespace: monitoring
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: hcloud-volumes  # Hetzner storage class
  resources:
    requests:
      storage: 50Gi  # Adjust based on needs

---
# In your Prometheus deployment:
volumeMounts:
  - name: storage
    mountPath: /prometheus
volumes:
  - name: storage
    persistentVolumeClaim:
      claimName: prometheus-storage
```

## Backup Strategies

### 1. **Snapshot Backups** (Recommended)
```bash
# Create snapshot via Prometheus API
curl -X POST http://prometheus:9090/api/v1/admin/tsdb/snapshot

# Backup location: /prometheus/snapshots/
# Copy to S3/backup storage
```

### 2. **Volume Snapshots** (Hetzner)
```bash
# Use Hetzner's volume snapshot feature
# Can be automated via their API
```

### 3. **Continuous Remote Write** (Advanced)
```yaml
# prometheus.yml
remote_write:
  - url: "https://your-long-term-storage/api/v1/write"
```

## Data You'll Want to Keep

### Critical Metrics (Worth Backing Up)
- **Autoscaling History**: When/why pods scaled
- **Performance Baselines**: Normal queue depths, processing rates
- **Incident Data**: Spikes, failures, recovery times
- **Cost Metrics**: Resource usage over time

### Less Critical (OK to Lose)
- Short-term CPU/memory metrics
- Debugging metrics
- Test environment data

## Recommended Setup for Your Project

### Local Development (Already Done)
```yaml
# docker-compose.monitoring.yml
prometheus:
  volumes:
    - prometheus_data:/prometheus  # ✅ Persists locally
  command:
    - '--storage.tsdb.retention.time=7d'   # 7 days is enough
    - '--storage.tsdb.retention.size=5GB'
```

### Production on Hetzner
```yaml
# Use Helm for easier management
helm install prometheus prometheus-community/kube-prometheus-stack \
  --set prometheus.prometheusSpec.retention=30d \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=50Gi \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName=hcloud-volumes
```

## Storage Sizing Guide

### Calculate Your Needs
```
Storage = (metrics × ingestion_rate × retention_days × 2 bytes)

Example for BatchSender:
- 100 metrics (queues, pods, resources)
- Scraped every 30s = 2880 samples/day
- 30 days retention
- = 100 × 2880 × 30 × 2 = ~17MB (very small!)

With 1000 workers at peak:
- ~17GB for 30 days (still manageable)
```

### Recommended Sizes
- **Development**: 5-10GB
- **Small Production**: 20-50GB
- **Large Production**: 100-500GB

## What Happens When Storage Fills Up?

1. **Retention Policy Kicks In**
   - Old data deleted automatically
   - Follows time OR size limit (whichever hits first)

2. **No Data Loss for Recent Metrics**
   - Always keeps most recent data
   - Deletes oldest blocks first

## Quick Backup Script

```bash
#!/bin/bash
# backup-prometheus.sh

# For Docker
docker exec prometheus-container \
  curl -X POST http://localhost:9090/api/v1/admin/tsdb/snapshot

# Copy snapshot to backup location
docker cp prometheus-container:/prometheus/snapshots ./backups/

# For Kubernetes
kubectl exec -n monitoring prometheus-0 -- \
  curl -X POST http://localhost:9090/api/v1/admin/tsdb/snapshot

# Copy via kubectl
kubectl cp monitoring/prometheus-0:/prometheus/snapshots ./backups/
```

## Do You Need Backups?

### Yes, if you need:
- Historical data for compliance
- Performance baselines from months ago
- Post-incident analysis after 30+ days
- Cost tracking over quarters/years

### No, if you only need:
- Recent operational data (last 30 days)
- Real-time monitoring
- Debugging current issues

## TL;DR for BatchSender

1. **Local Dev**: Current setup is perfect ✅
2. **Production**: Use PVC with 30-day retention ✅
3. **Backups**: Optional - only if you need >30 day history
4. **Storage Size**: Start with 50GB, monitor usage
5. **Critical Data**: Your metrics are small (~17MB/month)

Your current setup already handles persistence correctly for local development!