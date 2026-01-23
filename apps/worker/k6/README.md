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
pnpm k6:smoke

# Run load test (10 users, 5 minutes)
pnpm k6:load

# Run stress test (find breaking point)
pnpm k6:stress
```

## npm Scripts

| Command | Test | Description |
|---------|------|-------------|
| `pnpm k6:smoke` | batch-create.js | Quick smoke test (1 VU, 1 min) |
| `pnpm k6:load` | batch-create.js | Load test with SCENARIO=load |
| `pnpm k6:stress` | stress-test.js | Combined stress test |
| `pnpm k6:flow` | batch-flow.js | Full batch lifecycle test |
| `pnpm k6:webhook` | webhook-throughput.js | Webhook endpoint throughput |
| `pnpm k6:webhook:stress` | webhook-throughput.js | Webhook stress test |

---

## Test Structure

### Core Tests (Root Directory)

| Script | Description | Use Case |
|--------|-------------|----------|
| `batch-create.js` | Test batch creation API | API endpoint performance |
| `batch-flow.js` | Full create→send→complete flow | End-to-end latency |
| `webhook-throughput.js` | Test webhook processing | Hot path performance |
| `webhook-load-test.js` | Extended webhook load testing | Sustained webhook load |
| `stress-test.js` | Combined production load | Find system limits |
| `stress-1m.js` | 1 million recipient stress test | Capacity testing |

### Scenario Tests (`scenarios/`)

Specialized tests for specific behaviors and edge cases.

| Script | Description | Use Case |
|--------|-------------|----------|
| `remote-stress.js` | Configurable remote load testing | Staging/production testing |
| `scheduled-sends.js` | Immediate vs scheduled sends | Scheduler validation |
| `multi-user.js` | Multi-tenant isolation & fairness | Tenant isolation testing |
| `batch-size-matrix.js` | Different batch size patterns | Optimal batch size discovery |
| `sms-throughput.js` | SMS module with Telnyx limits | SMS provider performance |
| `rate-limit-pressure.js` | Rate limit behavior under pressure | Graceful degradation |
| `byok-vs-managed.js` | BYOK vs managed mode comparison | Provider mode performance |

---

## Scenario Tests Documentation

### Scheduled Sends (`scenarios/scheduled-sends.js`)

Tests the scheduler system with immediate and scheduled batch sends.

**Scenarios:**
- `immediate` - Send batches with no delay (baseline)
- `burst` - All batches scheduled for same timestamp
- `staggered` - Batches scheduled at increasing delays
- `cancel_reschedule` - Test cancellation and rescheduling

```bash
# Run immediate vs scheduled comparison
k6 run k6/scenarios/scheduled-sends.js

# Test scheduled burst
k6 run -e SCENARIO=burst k6/scenarios/scheduled-sends.js

# Test cancellation flow
k6 run -e SCENARIO=cancel_reschedule k6/scenarios/scheduled-sends.js
```

**Environment Variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `SCENARIO` | `immediate` | Test scenario |
| `K6_BATCH_SIZE` | `50` | Recipients per batch |
| `K6_BATCH_COUNT` | `20` | Number of batches |
| `K6_SCHEDULE_DELAY` | `30` | Seconds delay for scheduled sends |

---

### Multi-User Load (`scenarios/multi-user.js`)

Tests tenant isolation and fair scheduling with multiple concurrent users.

**Scenarios:**
- `symmetric` - All users have equal batch sizes
- `asymmetric` - One heavy user (10x), many light users
- `burst` - All users submit simultaneously
- `staggered` - Users join over time (ramping VUs)

```bash
# Symmetric load (default)
k6 run k6/scenarios/multi-user.js

# Test asymmetric (one heavy user)
k6 run -e SCENARIO=asymmetric k6/scenarios/multi-user.js

# 20 users, 10 batches each
k6 run -e USER_COUNT=20 -e BATCHES_PER_USER=10 k6/scenarios/multi-user.js
```

**Environment Variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `SCENARIO` | `symmetric` | Test scenario |
| `USER_COUNT` | `10` | Number of test users |
| `BATCHES_PER_USER` | `5` | Batches per user |
| `K6_BATCH_SIZE` | `100` | Recipients per batch |

**Key Metrics:**
- `isolation_violations` - When one user affects another's performance
- `user_fairness_ratio` - Slowest/fastest user ratio (should be < 2)

---

### Batch Size Matrix (`scenarios/batch-size-matrix.js`)

Systematically tests different batch sizes to find optimal configuration.

**Presets:**
| Preset | Recipients | Batches | Total | Description |
|--------|------------|---------|-------|-------------|
| `tiny` | 10 | 500 | 5,000 | Job creation overhead |
| `small` | 100 | 100 | 10,000 | Baseline |
| `medium` | 1,000 | 50 | 50,000 | Standard batches |
| `large` | 10,000 | 10 | 100,000 | Chunking test |
| `xlarge` | 50,000 | 5 | 250,000 | Memory/sustained test |
| `mixed` | varies | 100 | ~80,000 | Realistic distribution |

```bash
# Run small batch test
k6 run k6/scenarios/batch-size-matrix.js

# Run large batch test
k6 run -e PRESET=large k6/scenarios/batch-size-matrix.js

# Run mixed realistic distribution
k6 run -e PRESET=mixed k6/scenarios/batch-size-matrix.js
```

**Mixed Distribution:**
- 30% tiny (10 recipients)
- 35% small (100 recipients)
- 25% medium (1,000 recipients)
- 8% large (10,000 recipients)
- 2% xlarge (50,000 recipients)

**Key Metrics:**
- `job_creation_latency` - Batch creation overhead
- `chunking_latency` - Large batch chunking time
- `recipients_per_second` - Actual throughput

---

### SMS Throughput (`scenarios/sms-throughput.js`)

Tests SMS-specific functionality with Telnyx rate limits (50/sec).

**Scenarios:**
- `baseline` - Standard SMS throughput test
- `high_volume` - Push SMS limits (ramping)
- `mixed` - SMS + Email concurrent (resource sharing)
- `webhook_flood` - Telnyx delivery webhooks (2000/sec peak)

```bash
# Baseline SMS test
k6 run k6/scenarios/sms-throughput.js

# High volume ramping test
k6 run -e SCENARIO=high_volume k6/scenarios/sms-throughput.js

# Test SMS + Email concurrency
k6 run -e SCENARIO=mixed k6/scenarios/sms-throughput.js

# Webhook flood test
k6 run -e SCENARIO=webhook_flood k6/scenarios/sms-throughput.js
```

**Environment Variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `SCENARIO` | `baseline` | Test scenario |
| `K6_BATCH_SIZE` | `50` | Recipients per batch |
| `K6_BATCH_COUNT` | `20` | Number of batches |
| `K6_WORKER_URL` | `localhost:6001` | Worker URL for webhooks |

**Key Metrics:**
- `sms_throughput_per_sec` - Target: >20/sec (limited by Telnyx)
- `sms_webhook_latency` - p95 < 100ms

---

### Rate Limit Pressure (`scenarios/rate-limit-pressure.js`)

Tests system behavior when rate limits are exceeded.

**Scenarios:**
- `gradual` - Slowly ramp up until limits hit
- `sudden` - Instantly exceed limits
- `sustained` - Stay above limit for extended period
- `recovery` - Exceed, back off, verify recovery

```bash
# Gradual ramp up
k6 run k6/scenarios/rate-limit-pressure.js

# Instant overload
k6 run -e SCENARIO=sudden k6/scenarios/rate-limit-pressure.js

# Test recovery behavior
k6 run -e SCENARIO=recovery k6/scenarios/rate-limit-pressure.js

# Custom target RPS
k6 run -e TARGET_RPS=500 k6/scenarios/rate-limit-pressure.js
```

**Environment Variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `SCENARIO` | `gradual` | Test scenario |
| `TARGET_RPS` | `100` | Target requests per second |
| `CONFIG_RATE_LIMIT` | `10` | Per-config rate limit (low for testing) |

**Rate Limit Layers Tested:**
1. System-wide limits (global throughput cap)
2. Provider limits (shared Resend/Telnyx pool)
3. Per-config limits (user-defined)
4. API rate limits (requests/minute)

**Key Metrics:**
- `rate_limit_hits` - Count of 429 responses
- `recovery_time_ms` - Time to recover after overload
- `backpressure_events` - Queue backpressure signals

---

### BYOK vs Managed (`scenarios/byok-vs-managed.js`)

Compares Bring Your Own Key (BYOK) vs Managed provider modes.

**Modes:**
- `comparison` - Run both modes, compare results
- `byok_only` - Test BYOK mode isolation
- `managed_only` - Test managed shared pool
- `mixed` - Concurrent BYOK + managed (resource sharing)

```bash
# Compare both modes
k6 run k6/scenarios/byok-vs-managed.js

# Test BYOK isolation only
k6 run -e MODE=byok_only k6/scenarios/byok-vs-managed.js

# Test managed pool only
k6 run -e MODE=managed_only k6/scenarios/byok-vs-managed.js
```

**Environment Variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `MODE` | `comparison` | Test mode |
| `K6_BATCH_SIZE` | `100` | Recipients per batch |
| `K6_BATCH_COUNT` | `10` | Batches per mode |
| `K6_VUS` | `5` | Virtual users |

**Key Metrics:**
- `byok_throughput` vs `managed_throughput` - Direct comparison
- `byok_batch_latency` vs `managed_batch_latency` - Latency comparison

---

## Environment Variables (All Tests)

### Common Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `K6_API_URL` | `http://localhost:3000` | Web API base URL |
| `K6_WORKER_URL` | `http://localhost:6001` | Worker API base URL |
| `K6_API_KEY` | - | API key for authentication |
| `K6_ADMIN_SECRET` | - | Admin secret for test setup |
| `K6_BATCH_SIZE` | `100` | Recipients per test batch |
| `K6_SEND_CONFIG_ID` | - | Send configuration to use |
| `K6_DRY_RUN` | `false` | Enable dry run mode |
| `SCENARIO` | varies | Test scenario |

### stress-1m.js Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `K6_BATCH_COUNT` | `10` | Number of batches to create |
| `K6_RECIPIENTS_PER` | `100000` | Recipients per batch |
| `K6_VUS` | `10` | Virtual users |

---

## Test Scenarios

Each test supports multiple scenarios via the `SCENARIO` environment variable:

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

### Soak Test
- 20 users for 30 minutes
- Tests for memory leaks
- Long-running stability

---

## Metrics & Thresholds

### Default Thresholds

| Scenario | p95 Latency | Fail Rate |
|----------|-------------|-----------|
| Smoke | < 2s | < 1% |
| Load | < 3s | < 5% |
| Stress | < 10s | < 10% |
| Spike | < 5s | < 15% |

### Webhook Thresholds
- p95 latency < 100ms
- p99 latency < 500ms
- Fail rate < 1%

### Scenario Test Thresholds

| Test | Key Threshold |
|------|---------------|
| Multi-user | `user_fairness_ratio < 2` |
| Rate limit | `recovery_time_ms < 30000` |
| SMS | `sms_throughput > 20/sec` |
| Batch matrix | `recipients_per_second > 100` |

---

## Structured Reports

All scenario tests generate structured JSON reports via `lib/report-adapter.js`.

### Report Schema

```json
{
  "summary": {
    "name": "Test Name",
    "timestamp": "2024-01-15T10:30:00Z",
    "duration_ms": 300000,
    "testType": "matrix",
    "preset": "large"
  },
  "parameters": {
    "batchSize": 10000,
    "batchCount": 10,
    "virtualUsers": 5
  },
  "metrics": {
    "throughput": {
      "average": 150.5,
      "min": 80.2,
      "max": 220.1
    },
    "latency": {
      "p50": 5000,
      "p95": 15000,
      "p99": 25000
    },
    "errors": {
      "rate": 0.02,
      "total": 5
    }
  },
  "thresholds": {
    "throughput.average": { "passed": true, "value": 150.5, "threshold": ">= 100" },
    "latency.p95": { "passed": true, "value": 15000, "threshold": "<= 60000" }
  },
  "status": "passed"
}
```

### Report Output

Reports are written to `k6/results/`:
- `{test-name}-{timestamp}.json` - Individual run
- `{test-name}-summary.json` - Latest summary

---

## Remote Load Testing

### Quick Start (Remote)

```bash
# Set required environment variables
export K6_API_URL="https://staging.batchsender.com"
export K6_ADMIN_SECRET="your-admin-secret"

# Run smoke test first (always!)
pnpm k6:remote:smoke

# Then gradually increase intensity
pnpm k6:remote:light    # 10 VUs, ~10k recipients
pnpm k6:remote:medium   # 50 VUs, ~50k recipients
pnpm k6:remote:heavy    # 100 VUs, ~500k recipients
pnpm k6:remote:stress   # 200 VUs, find limits
pnpm k6:remote:soak     # 50 VUs, 1 hour
```

### Remote Stress Test (`scenarios/remote-stress.js`)

Designed specifically for remote/staging/production testing with configurable intensity levels.

**Intensity Levels:**

| Level | VUs | Duration | Batch Size | Total Recipients | Use Case |
|-------|-----|----------|------------|------------------|----------|
| `smoke` | 1 | 1 min | 10 | ~20 | Connectivity check |
| `light` | 10 | 5 min | 100 | ~10k | Light validation |
| `medium` | 50 | 10 min | 100 | ~50k | Normal load |
| `heavy` | 100 | 15 min | 500 | ~500k | Heavy load |
| `stress` | 200 | 30 min | 1000 | ~4M | Find system limits |
| `soak` | 50 | 60 min | 100 | ~500k | Memory leak detection |

**Safety Features:**
- Dry run mode enabled by default (`K6_DRY_RUN=true`)
- Clear warnings when running in live mode
- Automatic test user cleanup

```bash
# Run with live emails (use carefully!)
K6_API_URL="https://staging.batchsender.com" \
K6_ADMIN_SECRET="secret" \
K6_DRY_RUN=false \
pnpm k6:remote:medium
```

### Running from k6 Cloud (Distributed)

For truly large-scale tests from multiple regions:

```bash
# Login to k6 Cloud
k6 login cloud

# Run distributed from cloud
K6_API_URL="https://staging.batchsender.com" \
K6_ADMIN_SECRET="secret" \
k6 cloud k6/scenarios/remote-stress.js
```

### Running from CI/CD (GitHub Actions)

```yaml
# .github/workflows/load-test.yml
name: Load Test
on:
  workflow_dispatch:
    inputs:
      intensity:
        description: 'Test intensity'
        required: true
        default: 'smoke'
        type: choice
        options: [smoke, light, medium, heavy]
      environment:
        description: 'Target environment'
        required: true
        default: 'staging'
        type: choice
        options: [staging, production]

jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install k6
        run: |
          curl https://github.com/grafana/k6/releases/download/v0.47.0/k6-v0.47.0-linux-amd64.tar.gz -L | tar xvz
          sudo mv k6-v0.47.0-linux-amd64/k6 /usr/local/bin/

      - name: Run Load Test
        env:
          K6_API_URL: ${{ inputs.environment == 'staging' && secrets.STAGING_API_URL || secrets.PROD_API_URL }}
          K6_ADMIN_SECRET: ${{ secrets.ADMIN_SECRET }}
        run: |
          k6 run -e INTENSITY=${{ inputs.intensity }} k6/scenarios/remote-stress.js

      - name: Upload Results
        uses: actions/upload-artifact@v4
        with:
          name: load-test-results
          path: test-reports/
```

### Running from a Cloud VM

For best results, run k6 from a VM in the same region as your infrastructure:

```bash
# On a cloud VM (e.g., EC2, GCE)
# 1. Install k6
curl https://github.com/grafana/k6/releases/download/v0.47.0/k6-v0.47.0-linux-amd64.tar.gz -L | tar xvz
sudo mv k6-v0.47.0-linux-amd64/k6 /usr/local/bin/

# 2. Clone repo and run
git clone https://github.com/your-org/batchsender.git
cd batchsender/apps/worker

# 3. Run heavy test
K6_API_URL="https://internal-api.batchsender.com" \
K6_ADMIN_SECRET="secret" \
k6 run -e INTENSITY=heavy k6/scenarios/remote-stress.js
```

---

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

# 1M recipient stress test (dry run)
K6_DRY_RUN=true K6_BATCH_COUNT=10 K6_RECIPIENTS_PER=100000 k6 run k6/stress-1m.js

# Multi-user isolation test
k6 run -e USER_COUNT=20 k6/scenarios/multi-user.js

# Batch size matrix (large batches)
k6 run -e PRESET=xlarge k6/scenarios/batch-size-matrix.js

# Rate limit recovery test
k6 run -e SCENARIO=recovery k6/scenarios/rate-limit-pressure.js
```

---

## Output & Reporting

Results are saved to `k6/results/`:
- `batch-create-summary.json`
- `batch-flow-summary.json`
- `webhook-throughput-summary.json`
- `stress-test-summary.json`
- `{scenario-name}-{preset}-{timestamp}.json`

### Grafana Integration

```bash
# Run with InfluxDB output for Grafana dashboards
k6 run --out influxdb=http://localhost:8086/k6 k6/stress-test.js
```

### CI/CD Integration

```bash
# Run with JSON output for CI pipelines
k6 run --out json=results.json k6/batch-create.js

# Exit code is non-zero if thresholds fail
echo "Exit code: $?"
```

---

## Test Coverage Matrix

| Feature | Core Test | Scenario Test |
|---------|-----------|---------------|
| Batch creation | `batch-create.js` | `batch-size-matrix.js` |
| Batch lifecycle | `batch-flow.js` | `scheduled-sends.js` |
| Webhooks | `webhook-throughput.js` | `sms-throughput.js` (webhook_flood) |
| High load | `stress-test.js` | `multi-user.js` |
| Capacity | `stress-1m.js` | `batch-size-matrix.js` (xlarge) |
| Rate limits | - | `rate-limit-pressure.js` |
| SMS module | - | `sms-throughput.js` |
| Scheduling | - | `scheduled-sends.js` |
| Multi-tenant | - | `multi-user.js` |
| BYOK vs Managed | - | `byok-vs-managed.js` |
| Remote/Staging | - | `remote-stress.js` |

---

## File Structure

```
k6/
├── README.md                  # This file
├── config.js                  # Shared configuration & scenarios
├── batch-create.js            # Batch creation API test
├── batch-flow.js              # Full batch lifecycle test
├── stress-test.js             # Combined stress test
├── stress-1m.js               # 1M recipient capacity test
├── webhook-throughput.js      # Webhook endpoint test
├── webhook-load-test.js       # Extended webhook load test
├── lib/
│   ├── client.js              # Test client helper
│   └── report-adapter.js      # Report generation utilities
├── scenarios/                 # Specialized scenario tests
│   ├── remote-stress.js       # Remote/staging load testing
│   ├── scheduled-sends.js     # Immediate vs scheduled
│   ├── multi-user.js          # Multi-tenant isolation
│   ├── batch-size-matrix.js   # Batch size optimization
│   ├── sms-throughput.js      # SMS module testing
│   ├── rate-limit-pressure.js # Rate limit behavior
│   └── byok-vs-managed.js     # Provider mode comparison
└── results/                   # Test output (gitignored)
```
