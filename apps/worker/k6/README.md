# k6 Load Tests

Load testing suite for BatchSender using [k6](https://k6.io).

## Installation

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6

# Docker
docker pull grafana/k6
```

## Quick Start

```bash
# Run smoke test (1 user, 1 minute)
npm run k6:smoke

# Run load test (10 users, 5 minutes)
npm run k6:load

# Run stress test (find breaking point)
npm run k6:stress
```

## Test Scripts

| Script | Description | Use Case |
|--------|-------------|----------|
| `batch-create.js` | Test batch creation API | API endpoint performance |
| `batch-flow.js` | Full create→send→complete flow | End-to-end latency |
| `webhook-throughput.js` | Test webhook processing | Hot path performance |
| `stress-test.js` | Combined production load | Find system limits |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `K6_API_URL` | `http://localhost:3000` | Web API base URL |
| `K6_WORKER_URL` | `http://localhost:6001` | Worker API base URL |
| `K6_API_KEY` | - | API key for authentication |
| `K6_BATCH_SIZE` | `100` | Recipients per test batch |
| `K6_SEND_CONFIG_ID` | - | Send configuration to use |
| `SCENARIO` | `smoke` | Test scenario (smoke/load/stress/spike) |

## Running Against Production

```bash
# Set production URL and API key
export K6_API_URL=https://app.batchsender.com
export K6_API_KEY=your-api-key
export K6_SEND_CONFIG_ID=your-config-id

# Run smoke test first
k6 run k6/batch-create.js

# Then load test
k6 run -e SCENARIO=load k6/batch-create.js
```

## Test Scenarios

### Smoke Test
- 1 virtual user
- 1 minute duration
- Verifies system works

### Load Test
- Ramps to 10 users over 2 minutes
- Sustained 10 users for 5 minutes
- Tests normal expected load

### Stress Test
- Ramps from 10 → 50 → 100 → 200 users
- Finds breaking point
- Tests graceful degradation

### Spike Test
- Normal load, sudden spike to 10x
- Tests auto-scaling and recovery
- Verifies no cascading failures

## Metrics & Thresholds

Default thresholds:
- `http_req_duration`: p95 < 2-10s (varies by test)
- `http_req_failed`: < 1-10% (varies by test)
- Custom metrics per test

## Output & Reporting

Results are saved to `k6/results/`:
- `batch-create-summary.json`
- `batch-flow-summary.json`
- `webhook-throughput-summary.json`
- `stress-test-summary.json`

### Grafana Integration

```bash
# Run with InfluxDB output for Grafana dashboards
k6 run --out influxdb=http://localhost:8086/k6 k6/stress-test.js
```

## Examples

```bash
# Test with 1000 recipients per batch
K6_BATCH_SIZE=1000 k6 run k6/batch-flow.js

# Stress test webhooks
k6 run -e SCENARIO=stress k6/webhook-throughput.js

# Full stress test with custom target
k6 run -e TARGET_RPS=5000 k6/stress-test.js

# Run with more VUs
k6 run --vus 50 --duration 10m k6/batch-create.js
```
