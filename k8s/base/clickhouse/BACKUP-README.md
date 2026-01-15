# ClickHouse Automated Backups

## Overview

Automated daily backups of ClickHouse database to Backblaze B2.

## Schedule

**Default: Daily at 3 AM UTC**

The backup runs automatically every day at 3:00 AM UTC. This is configured in `backup-cronjob.yaml`:

```yaml
schedule: "0 3 * * *"
```

## Changing the Backup Frequency

Edit `backup-cronjob.yaml` and modify the `schedule` field:

### Common Schedules

```yaml
# Every 12 hours (at midnight and noon)
schedule: "0 0,12 * * *"

# Every 6 hours
schedule: "0 */6 * * *"

# Twice daily (2 AM and 2 PM)
schedule: "0 2,14 * * *"

# Weekly on Sunday at 2 AM
schedule: "0 2 * * 0"

# Monthly on the 1st at 1 AM
schedule: "0 1 1 * *"
```

### Cron Format

```
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 6) (Sunday=0)
│ │ │ │ │
│ │ │ │ │
* * * * *
```

**Examples:**
- `0 3 * * *` = 3:00 AM every day
- `*/30 * * * *` = Every 30 minutes
- `0 */4 * * *` = Every 4 hours
- `0 2 * * 1-5` = 2 AM Monday through Friday

## Apply Changes

After modifying the schedule:

```bash
kubectl apply -f k8s/base/clickhouse/backup-cronjob.yaml
```

## Manual Backup

Trigger a backup immediately without waiting for the schedule:

```bash
kubectl create job --from=cronjob/clickhouse-backup clickhouse-backup-manual -n batchsender
```

Watch the job progress:

```bash
kubectl logs -f job/clickhouse-backup-manual -n batchsender
```

## View Backup History

### Check CronJob Status

```bash
# View CronJob
kubectl get cronjob clickhouse-backup -n batchsender

# View recent backup jobs
kubectl get jobs -n batchsender | grep clickhouse-backup
```

### Check Backup Logs

```bash
# Get the most recent backup job
JOB=$(kubectl get jobs -n batchsender | grep clickhouse-backup | sort -r | head -1 | awk '{print $1}')

# View logs
kubectl logs job/$JOB -n batchsender
```

### List Backups in ClickHouse

```bash
kubectl exec -n batchsender statefulset/clickhouse -- clickhouse-client --query "
  SELECT
    name,
    status,
    formatDateTime(start_time, '%Y-%m-%d %H:%M:%S') as started,
    formatDateTime(end_time, '%Y-%m-%d %H:%M:%S') as finished,
    formatReadableSize(total_size) as size
  FROM system.backups
  ORDER BY start_time DESC
  LIMIT 10
  FORMAT PrettyCompact
"
```

## Restore from Backup

Use the restore script:

```bash
# List available backups first
./scripts/clickhouse-restore.sh list

# Restore a specific backup
./scripts/clickhouse-restore.sh backup_full_20260113_030000
```

Or manually:

```bash
kubectl exec -n batchsender statefulset/clickhouse -- clickhouse-client --query "
  RESTORE DATABASE default
  FROM S3(
    'https://s3.eu-central-003.backblazeb2.com/batchsender-clickhouse-cold/backups/backup_full_20260113_030000/',
    'YOUR_KEY_ID',
    'YOUR_APP_KEY'
  )
"
```

## Monitoring & Alerts

### Check if Backups are Running

```bash
# Check last backup time
kubectl get cronjob clickhouse-backup -n batchsender -o jsonpath='{.status.lastScheduleTime}'

# Check if last backup succeeded
kubectl get jobs -n batchsender -l app=clickhouse-backup --sort-by=.metadata.creationTimestamp | tail -1
```

### Set Up Alerts (Recommended)

Add to your AlertManager config:

```yaml
- alert: ClickHouseBackupFailed
  expr: kube_job_status_failed{namespace="batchsender", job_name=~"clickhouse-backup.*"} > 0
  for: 5m
  annotations:
    summary: "ClickHouse backup job failed"
    description: "Backup job {{ $labels.job_name }} failed"

- alert: ClickHouseBackupMissing
  expr: time() - kube_cronjob_status_last_schedule_time{namespace="batchsender", cronjob="clickhouse-backup"} > 86400
  for: 1h
  annotations:
    summary: "ClickHouse backup hasn't run in 24 hours"
    description: "Last backup was {{ $value | humanizeDuration }} ago"
```

## Backup Retention

The CronJob keeps:
- **Last 3 successful jobs** in Kubernetes
- **Last 1 failed job** for debugging

Backups in B2 storage are **not automatically deleted**. You should set up a lifecycle policy in Backblaze B2:

1. Go to Backblaze B2 console
2. Select bucket `batchsender-clickhouse-cold`
3. Create lifecycle rule:
   - Prefix: `backups/`
   - Keep only versions from last X days (e.g., 30 days)

## Cost Estimation

**Storage:** ~$6/TB/month

Typical backup sizes:
- Empty database: ~1 MB
- 1M events: ~100 MB
- 10M events: ~1 GB
- 100M events: ~10 GB

**Example monthly cost:**
- 30 daily backups × 1 GB each = 30 GB = $0.18/month
- With compression, actual cost is even lower

## Troubleshooting

### Backup Job Failed

Check logs:
```bash
kubectl logs -n batchsender -l app=clickhouse-backup --tail=100
```

Common issues:
1. **B2 credentials invalid** - Update `clickhouse-b2-credentials` secret
2. **ClickHouse not ready** - Check ClickHouse pod status
3. **Network timeout** - Check internet connectivity from cluster
4. **Disk space** - Ensure enough space in B2 bucket

### Force Retry Failed Backup

Delete the failed job and create a new one:
```bash
kubectl delete job -n batchsender -l app=clickhouse-backup
kubectl create job --from=cronjob/clickhouse-backup clickhouse-backup-retry -n batchsender
```

### Disable Automatic Backups

Suspend the CronJob:
```bash
kubectl patch cronjob clickhouse-backup -n batchsender -p '{"spec":{"suspend":true}}'
```

Re-enable:
```bash
kubectl patch cronjob clickhouse-backup -n batchsender -p '{"spec":{"suspend":false}}'
```

## Next Steps

1. ✅ Deploy the CronJob: `kubectl apply -f k8s/base/clickhouse/backup-cronjob.yaml`
2. ✅ Run manual test: `kubectl create job --from=cronjob/clickhouse-backup test-backup -n batchsender`
3. ✅ Verify backup appears in B2
4. ✅ Set up monitoring alerts
5. ✅ Configure B2 lifecycle policy for retention
