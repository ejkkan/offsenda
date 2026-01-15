# BatchSender Production Runbook

This runbook contains operational procedures for managing BatchSender in production.

## Table of Contents

- [Cluster Management](#cluster-management)
- [Application Operations](#application-operations)
- [Monitoring & Alerts](#monitoring--alerts)
- [Common Issues](#common-issues)
- [Emergency Procedures](#emergency-procedures)

---

## Cluster Management

### Accessing the Cluster

```bash
# Set kubeconfig
export KUBECONFIG=./kubeconfig

# Verify connection
kubectl cluster-info
kubectl get nodes
```

### Upgrading the Cluster

```bash
# Upgrade k3s version
hetzner-k3s upgrade --config cluster-config.yaml

# This will:
# - Upgrade masters one by one (zero downtime)
# - Upgrade workers with rolling updates
# - Preserve all data and configurations
```

### Scaling Worker Nodes

Worker nodes auto-scale automatically via Cluster Autoscaler (1-10 nodes), but you can adjust limits:

```bash
# Edit cluster-config.yaml
vim cluster-config.yaml

# Update autoscaling section:
#   autoscaling:
#     enabled: true
#     min_instances: 2  # Change this
#     max_instances: 20  # Change this

# Apply changes (recreates worker pool)
hetzner-k3s delete --config cluster-config.yaml --workers-only
hetzner-k3s create --config cluster-config.yaml --workers-only
```

### Adding a New Worker Pool

```bash
# Edit cluster-config.yaml and add a new pool
worker_node_pools:
  - name: high-memory
    instance_type: cpx41  # 8 vCPU, 16GB RAM
    instance_count: 1
    location: fsn1
    autoscaling:
      enabled: true
      min_instances: 0
      max_instances: 5
    labels:
      - key: "workload"
        value: "memory-intensive"

# Apply changes
hetzner-k3s upgrade --config cluster-config.yaml
```

### Destroying the Cluster

```bash
# DANGER: This deletes everything!
./scripts/destroy-cluster.sh

# Or manually:
hetzner-k3s delete --config cluster-config.yaml
```

---

## Application Operations

### Deploying Changes

**Automated (Recommended):**
```bash
# Just push to main
git add .
git commit -m "Update feature"
git push origin main

# GitHub Actions automatically:
# - Builds Docker image
# - Deploys to production
# - Verifies rollout
```

**Manual (Emergency):**
```bash
export KUBECONFIG=./kubeconfig
kubectl apply -k k8s/overlays/production
kubectl rollout status deployment/worker -n batchsender
```

### Scaling Workers

Workers auto-scale via KEDA based on NATS queue depth (2-50 workers), but you can manually scale:

```bash
# Temporary manual scaling
kubectl scale deployment worker -n batchsender --replicas=10

# View current scaling
kubectl get hpa -n batchsender
kubectl get scaledobject -n batchsender
```

### Updating Secrets

```bash
# 1. Edit .env.prod
vim .env.prod

# 2. Re-encrypt secrets
./scripts/seal-secrets.sh

# 3. Apply changes
kubectl apply -f k8s/base/worker/sealed-secrets.yaml
kubectl apply -f k8s/base/clickhouse/sealed-secrets.yaml

# 4. Restart pods to pick up new secrets
kubectl rollout restart deployment/worker -n batchsender
kubectl rollout restart statefulset/clickhouse -n batchsender
```

### Rolling Back

```bash
# Rollback to previous version
kubectl rollout undo deployment/worker -n batchsender

# Rollback to specific revision
kubectl rollout history deployment/worker -n batchsender
kubectl rollout undo deployment/worker -n batchsender --to-revision=3

# Or via Git:
git revert <commit-sha>
git push origin main
```

### Restarting Services

```bash
# Restart worker
kubectl rollout restart deployment/worker -n batchsender

# Restart specific component
kubectl rollout restart statefulset/nats -n batchsender
kubectl rollout restart statefulset/clickhouse -n batchsender
kubectl delete pod -l app=dragonfly -n batchsender  # For stateless pods
```

---

## Monitoring & Alerts

### Accessing Grafana

```bash
# Port-forward Grafana
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80

# Get admin password
kubectl get secret -n monitoring monitoring-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d

# Open browser: http://localhost:3000
# Username: admin
# Password: <from above command>
```

### Key Metrics to Monitor

**Worker Metrics:**
- Worker pod count (should scale 2-50 based on load)
- CPU/Memory usage
- Email processing rate
- Error rate

**NATS Metrics:**
- Queue depth (drives worker autoscaling)
- Message rate (in/out)
- Consumer lag

**ClickHouse Metrics:**
- Query performance
- Storage usage
- Insert rate

**Infrastructure Metrics:**
- Node CPU/Memory
- Disk usage
- Network traffic

### Viewing Logs

```bash
# Worker logs
kubectl logs -f deployment/worker -n batchsender

# Specific pod
kubectl logs -f <pod-name> -n batchsender

# All worker pods
kubectl logs -l app=worker -n batchsender --tail=100

# Filter for errors
kubectl logs deployment/worker -n batchsender | grep ERROR

# Previous container (if pod crashed)
kubectl logs <pod-name> -n batchsender --previous
```

### Checking Resource Usage

```bash
# Node resource usage
kubectl top nodes

# Pod resource usage
kubectl top pods -n batchsender

# Specific deployment
kubectl top pods -l app=worker -n batchsender
```

---

## Common Issues

### Issue: Pods Stuck in Pending

**Symptoms:**
- Pods stuck in `Pending` state
- `kubectl get pods -n batchsender` shows pending pods

**Diagnosis:**
```bash
kubectl describe pod <pod-name> -n batchsender
kubectl get events -n batchsender --sort-by='.lastTimestamp'
```

**Common causes:**
1. **Insufficient resources:** Cluster Autoscaler should add nodes automatically. Check:
   ```bash
   kubectl logs -n kube-system -l app=cluster-autoscaler
   ```

2. **PVC issues:** Check persistent volume claims:
   ```bash
   kubectl get pvc -n batchsender
   kubectl describe pvc <pvc-name> -n batchsender
   ```

**Resolution:**
- Wait for Cluster Autoscaler to provision new nodes (2-3 minutes)
- If autoscaler failed, manually scale worker pool in `cluster-config.yaml`
- For PVC issues, check Hetzner CSI driver logs:
  ```bash
  kubectl logs -n kube-system -l app=hcloud-csi-controller
  ```

### Issue: Worker Not Scaling

**Symptoms:**
- NATS queue building up
- Worker count not increasing

**Diagnosis:**
```bash
# Check KEDA ScaledObject
kubectl get scaledobject worker-scaler -n batchsender
kubectl describe scaledobject worker-scaler -n batchsender

# Check KEDA operator logs
kubectl logs -n keda deploy/keda-operator

# Check NATS metrics
kubectl port-forward -n batchsender svc/nats 8222:8222
curl http://localhost:8222/varz
```

**Resolution:**
1. Verify KEDA is healthy:
   ```bash
   kubectl get pods -n keda
   ```

2. Check ScaledObject configuration:
   ```bash
   kubectl get scaledobject worker-scaler -n batchsender -o yaml
   ```

3. Restart KEDA if needed:
   ```bash
   kubectl rollout restart deployment -n keda
   ```

### Issue: High Memory Usage

**Symptoms:**
- Worker pods being OOMKilled
- High memory usage in `kubectl top pods`

**Diagnosis:**
```bash
# Check current limits
kubectl get deployment worker -n batchsender -o yaml | grep -A 5 resources

# Check actual usage
kubectl top pods -l app=worker -n batchsender
```

**Resolution:**
1. Increase memory limits in `k8s/base/worker/deployment.yaml`:
   ```yaml
   resources:
     requests:
       memory: "512Mi"
     limits:
       memory: "2Gi"  # Increase this
   ```

2. Apply changes:
   ```bash
   git add . && git commit -m "Increase worker memory limits"
   git push origin main
   ```

### Issue: Database Connection Failures

**Symptoms:**
- Workers can't connect to PostgreSQL
- Logs show connection errors

**Diagnosis:**
```bash
# Check worker logs
kubectl logs -l app=worker -n batchsender | grep -i database

# Test connectivity from worker pod
WORKER_POD=$(kubectl get pods -l app=worker -n batchsender -o jsonpath='{.items[0].metadata.name}')
kubectl exec -it $WORKER_POD -n batchsender -- sh
# Inside pod:
# nc -zv <database-host> 5432
```

**Resolution:**
1. Verify DATABASE_URL secret is correct:
   ```bash
   kubectl get secret worker-secrets -n batchsender -o jsonpath='{.data.DATABASE_URL}' | base64 -d
   ```

2. Check Neon PostgreSQL dashboard for connection limits

3. Update secret if needed:
   ```bash
   vim .env.prod  # Fix DATABASE_URL
   ./scripts/seal-secrets.sh
   kubectl apply -f k8s/base/worker/sealed-secrets.yaml
   kubectl rollout restart deployment/worker -n batchsender
   ```

---

## Emergency Procedures

### Incident Response Checklist

1. **Assess Impact**
   ```bash
   kubectl get pods -n batchsender
   kubectl top nodes
   kubectl get events -n batchsender --sort-by='.lastTimestamp' | tail -20
   ```

2. **Check Recent Changes**
   ```bash
   # Check recent Git commits
   git log --oneline -10

   # Check recent deployments
   kubectl rollout history deployment/worker -n batchsender
   ```

3. **Roll Back if Needed**
   ```bash
   kubectl rollout undo deployment/worker -n batchsender
   ```

4. **Gather Diagnostics**
   ```bash
   # Save logs
   kubectl logs deployment/worker -n batchsender > worker-logs.txt

   # Save events
   kubectl get events -n batchsender --sort-by='.lastTimestamp' > events.txt

   # Save pod status
   kubectl get pods -n batchsender -o wide > pods.txt
   ```

5. **Communicate**
   - Update status page (if you have one)
   - Notify team/stakeholders

### Complete Cluster Recovery

If the cluster is completely broken:

```bash
# 1. Destroy cluster
./scripts/destroy-cluster.sh

# 2. Recreate cluster
hetzner-k3s create --config cluster-config.yaml

# 3. Reinstall infrastructure
./scripts/bootstrap-infrastructure.sh

# 4. Redeploy application
export KUBECONFIG=./kubeconfig
./scripts/seal-secrets.sh
kubectl apply -k k8s/overlays/production

# 5. Verify
./scripts/verify-deployment.sh
```

**Time:** ~20 minutes total

### Emergency Contacts

- **Hetzner Support:** https://console.hetzner.cloud → Support
- **Neon PostgreSQL:** https://console.neon.tech → Support
- **This Repository:** https://github.com/your-org/batchsender/issues

---

## Maintenance Windows

### Planned Maintenance Procedure

1. **Notify users** (if applicable)

2. **Scale up workers** (handle burst during restart):
   ```bash
   kubectl scale deployment worker -n batchsender --replicas=10
   ```

3. **Perform maintenance**

4. **Verify health**:
   ```bash
   ./scripts/verify-deployment.sh
   ```

5. **Return to auto-scaling**:
   ```bash
   kubectl patch scaledobject worker-scaler -n batchsender \
     --type='merge' -p '{"spec":{"minReplicaCount":2}}'
   ```

### Backup Procedures

**ClickHouse Backups:**
- Automatic daily backups to Backblaze B2 (via CronJob)
- Retention: 30 days
- Location: `batchsender-clickhouse-backups` bucket

**PostgreSQL Backups:**
- Managed by Neon (automatic backups)
- Point-in-time recovery available

**Configuration Backups:**
- All configs in Git (GitOps)
- Sealed secrets encrypted in Git
- cluster-config.yaml in `.gitignore` (back up manually)

---

## Performance Optimization

### Worker Performance

```bash
# Check current worker performance
kubectl top pods -l app=worker -n batchsender

# Adjust resource limits based on usage
# Edit k8s/base/worker/deployment.yaml

# Adjust KEDA scaling thresholds
# Edit k8s/base/worker/keda-scaledobject.yaml
```

### Database Performance

```bash
# Check ClickHouse query performance
kubectl exec -it clickhouse-0 -n batchsender -- clickhouse-client

# Inside clickhouse-client:
# SHOW PROCESSLIST;
# SELECT query, elapsed FROM system.processes;
```

---

## Cost Optimization

**Current monthly cost:** ~€40-50/mo

**To reduce costs:**

1. **Reduce minimum workers** (during off-peak):
   ```bash
   kubectl patch scaledobject worker-scaler -n batchsender \
     --type='merge' -p '{"spec":{"minReplicaCount":1}}'
   ```

2. **Reduce master nodes** (NOT RECOMMENDED for production):
   - Requires cluster recreation
   - Loses High Availability

3. **Optimize storage**:
   ```bash
   # Check storage usage
   kubectl get pvc -n batchsender
   ```

**To increase reliability** (higher cost):

1. **Increase minimum workers**:
   ```bash
   kubectl patch scaledobject worker-scaler -n batchsender \
     --type='merge' -p '{"spec":{"minReplicaCount":5}}'
   ```

2. **Add more worker pools** in different regions

---

## Additional Resources

- **Hetzner k3s Docs:** https://vitobotta.github.io/hetzner-k3s/
- **KEDA Docs:** https://keda.sh/docs/
- **Sealed Secrets:** https://sealed-secrets.netlify.app/
- **k3s Docs:** https://docs.k3s.io/
- **Prometheus:** https://prometheus.io/docs/
- **Grafana:** https://grafana.com/docs/
