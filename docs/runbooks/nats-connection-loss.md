# Runbook: NATS Connection Loss

## Symptoms
- Worker logs: "Failed to connect to NATS" or "NATS connection closed"
- Batches not processing
- Workers restarting

## Diagnosis

### Check NATS pod
```bash
kubectl get pod nats-0 -n batchsender
kubectl logs nats-0 -n batchsender | tail -50
```

### Check network connectivity
```bash
# Test from worker pod
kubectl exec -it deployment/worker -n batchsender -- sh -c "nc -zv nats 4222"
```

### Check TLS certificate
```bash
kubectl get certificate nats-tls -n batchsender
kubectl describe certificate nats-tls -n batchsender
```

## Resolution

### If NATS pod is not running
```bash
# Check why
kubectl describe pod nats-0 -n batchsender

# Restart
kubectl delete pod nats-0 -n batchsender

# Wait for ready
kubectl wait --for=condition=ready pod -l app=nats -n batchsender --timeout=60s
```

### If TLS certificate expired
```bash
# Check cert expiry
kubectl get secret nats-tls-secret -n batchsender -o jsonpath='{.data.tls\.crt}' | \
  base64 -d | openssl x509 -noout -dates

# Force renewal (delete and let cert-manager recreate)
kubectl delete certificate nats-tls -n batchsender
kubectl apply -k k8s/overlays/production/

# Restart NATS to pick up new cert
kubectl delete pod nats-0 -n batchsender
```

### If workers can't reconnect
```bash
# Restart workers
kubectl rollout restart deployment/worker -n batchsender
```

## Prevention
- Monitor NATS pod health
- Alert on certificate expiry (30 days before)
- Keep NATS resources adequate

## Related
- [Disaster Recovery](../DISASTER_RECOVERY.md)
