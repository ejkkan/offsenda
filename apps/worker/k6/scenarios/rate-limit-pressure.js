/**
 * k6 Load Test: Rate Limit Pressure Test
 *
 * Tests system behavior when rate limits are exceeded:
 * - Graceful degradation vs hard failure
 * - Backpressure propagation
 * - Recovery after limit is lifted
 * - Per-user vs system-wide limits
 *
 * Rate limit layers tested:
 * 1. System-wide limits (global throughput cap)
 * 2. Provider limits (managed mode: shared Resend/Telnyx pool)
 * 3. Per-config limits (user-defined rate limits)
 * 4. API rate limits (requests per minute)
 *
 * Scenarios:
 * - gradual: Slowly ramp up until limits hit
 * - sudden: Instantly exceed limits
 * - sustained: Stay above limit for extended period
 * - recovery: Exceed, then back off and verify recovery
 *
 * Usage:
 *   k6 run k6/scenarios/rate-limit-pressure.js
 *   k6 run -e SCENARIO=sudden k6/scenarios/rate-limit-pressure.js
 *   k6 run -e TARGET_RPS=500 k6/scenarios/rate-limit-pressure.js
 *
 * Environment Variables:
 *   K6_API_URL          - API base URL
 *   K6_ADMIN_SECRET     - Admin secret
 *   SCENARIO            - Test scenario
 *   TARGET_RPS          - Target requests per second to attempt
 *   CONFIG_RATE_LIMIT   - Per-config rate limit to set (default: 10)
 */

import { sleep } from 'k6';
import http from 'k6/http';
import { check } from 'k6';
import { TestClient, metrics } from '../lib/client.js';
import { generateTestReport } from '../lib/report-adapter.js';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';

// Configuration
const SCENARIO = __ENV.SCENARIO || 'gradual';
const TARGET_RPS = parseInt(__ENV.TARGET_RPS || '100');
const CONFIG_RATE_LIMIT = parseInt(__ENV.CONFIG_RATE_LIMIT || '10'); // Low limit to easily exceed
const BATCH_SIZE = parseInt(__ENV.K6_BATCH_SIZE || '50');
const VUS = parseInt(__ENV.K6_VUS || '10');

// Custom metrics for rate limiting analysis
const rateLimitHits = new Counter('rate_limit_hits');
const rateLimitedRequests = new Rate('rate_limited_request_rate');
const backpressureEvents = new Counter('backpressure_events');
const retryCount = new Counter('retry_count');
const actualThroughput = new Trend('actual_throughput', true);
const attemptedThroughput = new Trend('attempted_throughput', true);
const queueDepth = new Gauge('estimated_queue_depth');
const recoveryTime = new Trend('recovery_time_ms', true);
const limitLatency = new Trend('rate_limit_response_latency', true);

// Track state for recovery testing
let hitLimitTimestamp = 0;
let recoveredTimestamp = 0;

// Scenario configurations
const scenarios = {
  // Slowly ramp up until limits hit
  gradual: {
    executor: 'ramping-arrival-rate',
    startRate: 1,
    timeUnit: '1s',
    preAllocatedVUs: 50,
    maxVUs: 200,
    stages: [
      { duration: '1m', target: 10 },
      { duration: '2m', target: 50 },
      { duration: '2m', target: 100 },
      { duration: '2m', target: 200 },
      { duration: '2m', target: 100 },
      { duration: '1m', target: 10 },
    ],
  },
  // Instantly exceed limits
  sudden: {
    executor: 'constant-arrival-rate',
    rate: TARGET_RPS,
    timeUnit: '1s',
    duration: '5m',
    preAllocatedVUs: 100,
    maxVUs: 300,
  },
  // Stay above limit for extended period
  sustained: {
    executor: 'constant-arrival-rate',
    rate: TARGET_RPS * 2, // 2x the expected limit
    timeUnit: '1s',
    duration: '10m',
    preAllocatedVUs: 150,
    maxVUs: 400,
  },
  // Exceed, back off, verify recovery
  recovery: {
    executor: 'ramping-arrival-rate',
    startRate: 10,
    timeUnit: '1s',
    preAllocatedVUs: 50,
    maxVUs: 200,
    stages: [
      { duration: '1m', target: 10 },    // Baseline
      { duration: '30s', target: 200 },  // Spike (exceed limits)
      { duration: '2m', target: 200 },   // Sustained overload
      { duration: '30s', target: 10 },   // Back off
      { duration: '2m', target: 10 },    // Verify recovery
      { duration: '1m', target: 50 },    // Normal load
    ],
  },
};

export const options = {
  scenarios: {
    default: scenarios[SCENARIO] || scenarios.gradual,
  },
  thresholds: {
    // We EXPECT rate limiting, so these are different from normal tests
    rate_limited_request_rate: ['rate<0.80'], // Less than 80% should be rate limited
    actual_throughput: ['avg>5'], // Should still process something
    recovery_time_ms: ['avg<30000'], // Recover within 30 seconds
  },
};

/**
 * Setup: Create user with low rate limit
 */
export function setup() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              RATE LIMIT PRESSURE TEST                        ║
╠══════════════════════════════════════════════════════════════╣
║  Scenario:       ${SCENARIO.padEnd(41)}║
║  Target RPS:     ${TARGET_RPS.toString().padEnd(41)}║
║  Config Limit:   ${CONFIG_RATE_LIMIT.toString().padEnd(38)} /sec ║
║  Virtual Users:  ${VUS.toString().padEnd(41)}║
╠══════════════════════════════════════════════════════════════╣
║  This test intentionally exceeds rate limits!                ║
║  Expect HTTP 429 responses.                                  ║
╚══════════════════════════════════════════════════════════════╝
`);

  const client = new TestClient({ testId: `ratelimit-${SCENARIO}-${Date.now()}` });
  const ctx = client.setupTestUser(`ratelimit-test`);

  // Create a send config with a LOW rate limit (easy to exceed)
  try {
    const limitedConfig = client.createSendConfig({
      name: 'Low Rate Limit Config',
      module: 'email',
      moduleConfig: { mode: 'managed' },
      rateLimit: { perSecond: CONFIG_RATE_LIMIT },
      isDefault: true,
    });
    ctx.limitedSendConfigId = limitedConfig.id;
    console.log(`Created rate-limited config: ${limitedConfig.id} (${CONFIG_RATE_LIMIT}/sec)`);
  } catch (error) {
    console.warn(`Could not create limited config: ${error.message}`);
  }

  return {
    ...ctx,
    scenario: SCENARIO,
    targetRps: TARGET_RPS,
    configRateLimit: CONFIG_RATE_LIMIT,
    batchSize: BATCH_SIZE,
    startTime: Date.now(),
  };
}

/**
 * Main test function
 */
export default function (data) {
  const client = TestClient.fromContext(data);
  const iterationStart = Date.now();

  attemptedThroughput.add(1);

  try {
    // Create a small batch (to maximize request rate)
    const batch = client.createBatch({
      name: `ratelimit-batch-${Date.now()}`,
      recipientCount: data.batchSize,
      subject: 'Rate Limit Test',
      sendConfigId: data.limitedSendConfigId,
      dryRun: true,
    });

    // Try to send immediately
    const sendStart = Date.now();
    const sendResponse = client._request('POST', `/api/batches/${batch.id}/send`, null, {
      throwOnError: false,
    });
    const sendLatency = Date.now() - sendStart;

    // Analyze response
    if (sendResponse.status === 429) {
      // Rate limited!
      rateLimitHits.add(1);
      rateLimitedRequests.add(true);
      limitLatency.add(sendLatency);

      // Record when we first hit the limit
      if (hitLimitTimestamp === 0) {
        hitLimitTimestamp = Date.now();
        console.log(`First rate limit hit at ${(Date.now() - data.startTime) / 1000}s`);
      }

      // Check for backpressure info in response
      try {
        const body = JSON.parse(sendResponse.body);
        if (body.retryAfter) {
          backpressureEvents.add(1);
          console.log(`Backpressure: retry after ${body.retryAfter}ms`);
        }
      } catch {}

    } else if (sendResponse.status === 200) {
      // Success!
      rateLimitedRequests.add(false);
      actualThroughput.add(1);

      // Track recovery
      if (hitLimitTimestamp > 0 && recoveredTimestamp === 0) {
        recoveredTimestamp = Date.now();
        const recovery = recoveredTimestamp - hitLimitTimestamp;
        recoveryTime.add(recovery);
        console.log(`Recovered after ${recovery}ms`);
      }

      // Wait for batch completion (quick poll)
      client.waitForCompletion(batch.id, {
        maxWaitSeconds: 30,
        pollIntervalSeconds: 1,
        silent: true,
      });

    } else {
      // Other error
      console.log(`Unexpected status: ${sendResponse.status}`);
      rateLimitedRequests.add(false);
    }

  } catch (error) {
    console.error(`Error: ${error.message}`);
  }

  // Estimate queue depth based on time since limit hit
  if (hitLimitTimestamp > 0 && recoveredTimestamp === 0) {
    const timeOverLimit = Date.now() - hitLimitTimestamp;
    const estimatedQueue = (data.targetRps - data.configRateLimit) * (timeOverLimit / 1000);
    queueDepth.add(Math.max(0, estimatedQueue));
  }

  // Minimal delay for high request rate
  sleep(0.01);
}

/**
 * Teardown
 */
export function teardown(data) {
  const client = TestClient.fromContext(data);
  client.cleanup();
}

/**
 * Generate report
 */
export function handleSummary(data) {
  const totalAttempts = data.metrics.attempted_throughput?.values?.count || 0;
  const actualSuccess = data.metrics.actual_throughput?.values?.count || 0;
  const rateLimited = data.metrics.rate_limit_hits?.values?.count || 0;
  const limitRate = data.metrics.rate_limited_request_rate?.values?.rate || 0;
  const avgRecovery = data.metrics.recovery_time_ms?.values?.avg || 0;
  const backpressure = data.metrics.backpressure_events?.values?.count || 0;
  const duration = data.state?.testRunDurationMs || 1;

  const attemptedRps = totalAttempts / (duration / 1000);
  const actualRps = actualSuccess / (duration / 1000);
  const limitEfficiency = actualSuccess / Math.max(1, totalAttempts) * 100;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              RATE LIMIT PRESSURE RESULTS                     ║
╠══════════════════════════════════════════════════════════════╣
║  Scenario:       ${SCENARIO.padEnd(41)}║
║  Duration:       ${(duration / 1000).toFixed(1).padEnd(38)} sec ║
╠══════════════════════════════════════════════════════════════╣
║  Attempted:      ${totalAttempts.toString().padEnd(38)} req ║
║  Attempted RPS:  ${attemptedRps.toFixed(1).padEnd(41)}║
║  Actual RPS:     ${actualRps.toFixed(1).padEnd(41)}║
║  Efficiency:     ${limitEfficiency.toFixed(1).padEnd(39)} % ║
╠══════════════════════════════════════════════════════════════╣
║  Rate Limited:   ${rateLimited.toString().padEnd(38)} req ║
║  Limit Rate:     ${(limitRate * 100).toFixed(1).padEnd(39)} % ║
║  Backpressure:   ${backpressure.toString().padEnd(38)} evt ║
║  Avg Recovery:   ${avgRecovery.toFixed(0).padEnd(38)} ms ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Analysis
  console.log('\n=== Analysis ===');
  if (limitRate > 0.5) {
    console.log('⚠️  More than 50% of requests were rate limited');
    console.log('   This indicates the target RPS significantly exceeded the configured limit');
  }
  if (actualRps < CONFIG_RATE_LIMIT * 0.8) {
    console.log('⚠️  Actual throughput below 80% of configured limit');
    console.log('   System may be over-throttling or experiencing other bottlenecks');
  }
  if (avgRecovery > 10000) {
    console.log('⚠️  Recovery time > 10 seconds');
    console.log('   Consider tuning backpressure/queue drain settings');
  }
  if (limitRate < 0.1 && TARGET_RPS > CONFIG_RATE_LIMIT) {
    console.log('✓  Rate limiting working but rarely triggered');
    console.log('   The system handled the load without hitting limits often');
  }

  return generateTestReport(data, {
    name: `Rate Limit Pressure Test - ${SCENARIO}`,
    testType: 'rate-limit',
    preset: SCENARIO,
    parameters: {
      scenario: SCENARIO,
      targetRps: TARGET_RPS,
      configRateLimit: CONFIG_RATE_LIMIT,
      batchSize: BATCH_SIZE,
      virtualUsers: VUS,
    },
    thresholds: {
      'throughput.average': { operator: '>=', value: 5 },
      'errors.rate': { operator: '<=', value: 0.80 }, // We expect rate limiting
    },
  });
}
