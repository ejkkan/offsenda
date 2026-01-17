# Runbook: Database Slow Queries

## Symptoms
- Batch completion taking longer than usual
- High ClickHouse CPU
- "query took X seconds" in logs

## Diagnosis

### Check slow queries in ClickHouse
```bash
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  SELECT
    query_duration_ms,
    substring(query, 1, 100) as query_preview,
    formatDateTime(event_time, '%H:%i:%s') as time
  FROM system.query_log
  WHERE type = 'QueryFinish'
    AND query_duration_ms > 1000
  ORDER BY event_time DESC
  LIMIT 10
  FORMAT PrettyCompact"
```

### Check table sizes
```bash
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  SELECT
    table,
    formatReadableSize(total_bytes) as size,
    total_rows
  FROM system.tables
  WHERE database = 'default'
  ORDER BY total_bytes DESC
  FORMAT PrettyCompact"
```

### Check running queries
```bash
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  SELECT query_id, elapsed, query
  FROM system.processes
  FORMAT PrettyCompact"
```

## Resolution

### Kill slow query
```bash
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  KILL QUERY WHERE query_id = '<query-id>'"
```

### Optimize table
```bash
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  OPTIMIZE TABLE email_events FINAL"
```

### Check if data needs archiving
Data older than 1 day should move to cold storage automatically. Verify:
```bash
kubectl exec clickhouse-0 -n batchsender -- clickhouse-client -q "
  SELECT
    partition,
    disk_name,
    formatReadableSize(sum(bytes_on_disk)) as size
  FROM system.parts
  WHERE table = 'email_events'
  GROUP BY partition, disk_name
  ORDER BY partition DESC
  FORMAT PrettyCompact"
```

## Prevention
- Monitor query times (p95 < 100ms)
- Set query timeouts
- Review query patterns weekly

## Related
- [Disaster Recovery](../DISASTER_RECOVERY.md)
