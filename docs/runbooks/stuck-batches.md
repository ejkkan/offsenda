# Runbook: Stuck Batches

## Symptoms
- Batch shows "processing" status for >15 minutes
- All recipients have final status (sent/bounced/failed)
- User can't see completion or results

## Diagnosis

### Check batch status
```bash
# Via worker logs
kubectl logs deployment/worker -n batchsender | grep "stuck" | tail -10

# Check batch recovery service
kubectl logs deployment/worker -n batchsender | grep "BatchRecovery" | tail -10
```

### Check if automatic recovery is working
The BatchRecoveryService runs automatically every 5 minutes and fixes stuck batches.

```bash
# Verify it's running
kubectl logs deployment/worker -n batchsender | grep "batch recovery" | tail -5
```

## Resolution

### Automatic Recovery (default)
The BatchRecoveryService is enabled by default:
- Scans every 5 minutes (`BATCH_RECOVERY_INTERVAL_MS=300000`)
- Detects batches stuck >15 minutes (`BATCH_RECOVERY_THRESHOLD_MS=900000`)
- Automatically marks as `completed`

**Just wait** - recovery happens automatically within 5 minutes.

### Manual Recovery (if automatic is disabled)
```bash
# Connect to database (via Neon console or psql)
# Mark batch as completed
UPDATE batches
SET status = 'completed', completed_at = now()
WHERE id = '<batch-id>'
  AND status = 'processing';
```

## Prevention

Ensure these environment variables are set:
```yaml
BATCH_RECOVERY_ENABLED: "true"
BATCH_RECOVERY_INTERVAL_MS: "300000"   # 5 minutes
BATCH_RECOVERY_THRESHOLD_MS: "900000"  # 15 minutes
```

## Related
- [Disaster Recovery](../DISASTER_RECOVERY.md)
