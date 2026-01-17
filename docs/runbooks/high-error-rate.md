# Runbook: High Error Rate

## Symptoms
- Error rate > 5% in Grafana
- Users reporting failures
- Logs full of errors

## Diagnosis

### Check error types
```bash
# See recent errors
kubectl logs deployment/worker -n batchsender | grep -i "error" | tail -50

# Check specific error types
kubectl logs deployment/worker -n batchsender | grep -E "status.*[45][0-9]{2}" | tail -20
```

### Identify root cause
```bash
# Provider issues (Resend/SES)?
kubectl logs deployment/worker -n batchsender | grep -i "resend\|ses\|provider" | tail -20

# Rate limiting?
kubectl logs deployment/worker -n batchsender | grep -i "rate_limit\|429" | tail -20

# Database issues?
kubectl logs deployment/worker -n batchsender | grep -i "database\|postgres\|clickhouse" | tail -20
```

## Resolution

### If email provider is down
1. Check status pages:
   - Resend: https://status.resend.com/
   - AWS SES: https://status.aws.amazon.com/

2. Switch to mock provider temporarily:
   ```bash
   kubectl patch configmap worker-config -n batchsender \
     -p '{"data":{"EMAIL_PROVIDER":"mock"}}'
   kubectl rollout restart deployment/worker -n batchsender
   ```

### If rate limited (429s)
```bash
# Increase rate limits
kubectl patch configmap worker-config -n batchsender \
  -p '{"data":{"RATE_LIMIT_PER_IP":"200"}}'
kubectl rollout restart deployment/worker -n batchsender
```

### If webhook circuit breaker open
The circuit breaker auto-recovers after 30 seconds. Check logs:
```bash
kubectl logs deployment/worker -n batchsender | grep "circuit" | tail -10
```

## Prevention
- Monitor error rate (alert at >3%)
- Keep provider quotas high
- Set conservative rate limits

## Related
- [Disaster Recovery](../DISASTER_RECOVERY.md)
