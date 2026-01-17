# Runbook: Scale During High Load

## When to Scale
- NATS queue depth > 5000 messages
- Pod CPU consistently > 80%
- Processing latency increasing

## Check Current State

```bash
# Current replicas
kubectl get deployment worker -n batchsender

# Queue depth
kubectl exec nats-0 -n batchsender -- nats stream info email-system

# Pod metrics
kubectl top pod -n batchsender -l app=worker
```

## Scale Up

### Automatic (KEDA)
KEDA scales automatically based on NATS queue depth. Check status:
```bash
kubectl get scaledobject worker-scaler -n batchsender
kubectl describe scaledobject worker-scaler -n batchsender
```

### Manual Override
```bash
# Scale to 10 workers immediately
kubectl scale deployment worker --replicas=10 -n batchsender

# Monitor scale-up
watch kubectl get pods -n batchsender -l app=worker
```

## Scale Down

Let KEDA handle it automatically, or:
```bash
kubectl scale deployment worker --replicas=2 -n batchsender
```

## Debug Scaling Issues

```bash
# Check KEDA operator
kubectl logs -n keda deployment/keda-operator | tail -50

# Check ScaledObject status
kubectl get scaledobject -n batchsender -o yaml
```

## Prevention
- Monitor queue depth trends
- Alert when queue > 10k messages
- Set appropriate KEDA thresholds

## Related
- [Disaster Recovery](../DISASTER_RECOVERY.md)
