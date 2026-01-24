# Grafana Dashboard Management

## Where dashboards live

**The production Grafana dashboard is embedded in:**
```
k8s/monitoring/grafana-deployment.yaml
```

Look for the `grafana-dashboards` ConfigMap section (~line 100).

**NOT in:** `monitoring/grafana/dashboards/` (this folder is not used by ArgoCD)

## How to update a dashboard

### Option 1: Edit directly in Grafana, then export

1. Edit the dashboard in Grafana UI
2. Click ⚙️ Settings → JSON Model → Copy
3. Run the update script:
   ```bash
   ./scripts/update-grafana-dashboard.sh
   ```
4. Paste the JSON when prompted
5. Commit and push

### Option 2: Edit the YAML file directly

1. Edit `k8s/monitoring/grafana-deployment.yaml`
2. Find the `batchsender.json: |` section
3. Update the JSON (must be indented with 4 spaces)
4. Commit and push

## Important: Datasource UIDs

When adding new Prometheus panels, use this datasource config:
```json
"datasource": { "type": "prometheus", "uid": "PBFA97CFB590B2093" }
```

For ClickHouse:
```json
"datasource": { "type": "grafana-clickhouse-datasource", "uid": "clickhouse" }
```

For PostgreSQL:
```json
"datasource": { "type": "postgres", "uid": "postgres" }
```

## After pushing changes

ArgoCD will auto-sync, but you may need to restart Grafana:
```bash
kubectl rollout restart deployment grafana -n monitoring
```
