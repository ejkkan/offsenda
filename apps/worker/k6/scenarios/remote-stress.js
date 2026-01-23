/**
 * k6 Load Test: Remote Stress Test
 *
 * Designed for running against staging/production environments.
 * Configurable intensity levels for different test purposes.
 *
 * IMPORTANT: Always run against staging first!
 *
 * Intensity Levels:
 * - smoke:     Quick validation (1 VU, 1 min)
 * - light:     Light load (10 VUs, 5 min, ~1k recipients)
 * - medium:    Medium load (50 VUs, 10 min, ~50k recipients)
 * - heavy:     Heavy load (100 VUs, 15 min, ~500k recipients)
 * - stress:    Find limits (ramp to 200 VUs, 30 min)
 * - soak:      Long duration (50 VUs, 1 hour, memory leak detection)
 *
 * Usage:
 *   # Quick smoke test against staging
 *   k6 run -e API_URL=https://staging.batchsender.com -e INTENSITY=smoke k6/scenarios/remote-stress.js
 *
 *   # Medium load test
 *   k6 run -e API_URL=https://staging.batchsender.com -e INTENSITY=medium k6/scenarios/remote-stress.js
 *
 *   # Heavy stress test (use with caution!)
 *   k6 run -e API_URL=https://staging.batchsender.com -e INTENSITY=heavy k6/scenarios/remote-stress.js
 *
 * Required Environment Variables:
 *   K6_API_URL or API_URL  - Target API URL
 *   K6_ADMIN_SECRET        - Admin secret for test user creation
 *
 * Optional Environment Variables:
 *   INTENSITY              - Test intensity level (default: smoke)
 *   K6_DRY_RUN             - Use dry run mode (default: true for safety)
 *   BATCH_SIZE             - Recipients per batch (default: varies by intensity)
 *   CONCURRENT_BATCHES     - Max concurrent batches per user (default: 5)
 */

import { sleep } from 'k6';
import { TestClient, metrics } from '../lib/client.js';
import { generateTestReport } from '../lib/report-adapter.js';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';

// =============================================================================
// Configuration
// =============================================================================

const API_URL = __ENV.K6_API_URL || __ENV.API_URL;
const ADMIN_SECRET = __ENV.K6_ADMIN_SECRET || __ENV.ADMIN_SECRET;
const INTENSITY = __ENV.INTENSITY || 'smoke';
const DRY_RUN = __ENV.K6_DRY_RUN !== 'false'; // Default to true for safety

if (!API_URL) {
  throw new Error('K6_API_URL or API_URL environment variable is required');
}

if (!ADMIN_SECRET) {
  throw new Error('K6_ADMIN_SECRET or ADMIN_SECRET environment variable is required');
}

// Intensity configurations
const INTENSITIES = {
  smoke: {
    vus: 1,
    duration: '1m',
    batchSize: 10,
    batchesPerVu: 2,
    description: 'Quick smoke test - validates connectivity',
  },
  light: {
    vus: 10,
    duration: '5m',
    batchSize: 100,
    batchesPerVu: 10,
    description: 'Light load - ~10k recipients total',
  },
  medium: {
    vus: 50,
    duration: '10m',
    batchSize: 100,
    batchesPerVu: 10,
    description: 'Medium load - ~50k recipients total',
  },
  heavy: {
    vus: 100,
    duration: '15m',
    batchSize: 500,
    batchesPerVu: 10,
    description: 'Heavy load - ~500k recipients total',
  },
  stress: {
    vus: 200,
    duration: '30m',
    batchSize: 1000,
    batchesPerVu: 20,
    rampUp: true,
    description: 'Stress test - find system limits',
  },
  soak: {
    vus: 50,
    duration: '60m',
    batchSize: 100,
    batchesPerVu: 100,
    description: 'Soak test - 1 hour for memory leak detection',
  },
};

const config = INTENSITIES[INTENSITY] || INTENSITIES.smoke;
const BATCH_SIZE = parseInt(__ENV.BATCH_SIZE || config.batchSize);
const CONCURRENT_BATCHES = parseInt(__ENV.CONCURRENT_BATCHES || '5');

// =============================================================================
// Custom Metrics
// =============================================================================

const totalRecipients = new Counter('total_recipients_sent');
const activeBatches = new Gauge('active_batches');
const batchQueueTime = new Trend('batch_queue_time_ms', true);
const batchProcessTime = new Trend('batch_process_time_ms', true);
const systemThroughput = new Trend('system_throughput_rps', true);
const errorsByType = {
  creation: new Counter('errors_batch_creation'),
  send: new Counter('errors_batch_send'),
  timeout: new Counter('errors_batch_timeout'),
  other: new Counter('errors_other'),
};

// =============================================================================
// Scenarios
// =============================================================================

const scenarios = config.rampUp
  ? {
      // Ramping scenario for stress tests
      stress: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '2m', target: Math.floor(config.vus * 0.25) },
          { duration: '3m', target: Math.floor(config.vus * 0.5) },
          { duration: '5m', target: config.vus },
          { duration: '15m', target: config.vus },
          { duration: '3m', target: Math.floor(config.vus * 0.5) },
          { duration: '2m', target: 0 },
        ],
      },
    }
  : {
      // Constant load for other intensities
      constant: {
        executor: 'per-vu-iterations',
        vus: config.vus,
        iterations: config.batchesPerVu,
        maxDuration: config.duration,
      },
    };

export const options = {
  scenarios,
  thresholds: {
    batch_fail_rate: ['rate<0.05'],
    batch_completion_duration: ['p(95)<300000'], // 5 min
    system_throughput_rps: ['avg>10'],
    http_req_failed: ['rate<0.01'],
  },
  // For cloud runs
  ext: {
    loadimpact: {
      projectID: parseInt(__ENV.K6_CLOUD_PROJECT_ID || '0'),
      name: `Remote Stress Test - ${INTENSITY}`,
    },
  },
};

// =============================================================================
// Setup
// =============================================================================

export function setup() {
  const totalExpectedRecipients = config.vus * config.batchesPerVu * BATCH_SIZE;

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                      REMOTE STRESS TEST                                      ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Target:           ${API_URL.padEnd(56)}║
║  Intensity:        ${INTENSITY.toUpperCase().padEnd(56)}║
║  Description:      ${config.description.padEnd(56)}║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Virtual Users:    ${config.vus.toString().padEnd(56)}║
║  Duration:         ${config.duration.padEnd(56)}║
║  Batch Size:       ${BATCH_SIZE.toString().padEnd(53)} rec ║
║  Batches per VU:   ${config.batchesPerVu.toString().padEnd(56)}║
║  Expected Total:   ~${totalExpectedRecipients.toLocaleString().padEnd(52)} rec ║
║  Dry Run:          ${DRY_RUN.toString().padEnd(56)}║
╠══════════════════════════════════════════════════════════════════════════════╣
║  ${DRY_RUN ? '✓ DRY RUN MODE - No actual emails will be sent' : '⚠ LIVE MODE - Real emails will be sent!'}${' '.repeat(DRY_RUN ? 32 : 30)}║
╚══════════════════════════════════════════════════════════════════════════════╝
`);

  // Create test client
  const client = new TestClient({
    baseUrl: API_URL,
    testId: `remote-stress-${INTENSITY}-${Date.now()}`,
  });

  // Setup test user
  const ctx = client.setupTestUser(`stress-${INTENSITY}`);

  console.log(`✓ Test user created: ${ctx.userId}`);
  console.log(`✓ API key configured`);
  console.log(`\nStarting load test...\n`);

  return {
    ...ctx,
    intensity: INTENSITY,
    config: config,
    batchSize: BATCH_SIZE,
    dryRun: DRY_RUN,
    startTime: Date.now(),
  };
}

// =============================================================================
// Main Test
// =============================================================================

export default function (data) {
  const client = TestClient.fromContext(data);
  const vuId = __VU;
  const iteration = __ITER;

  const batchName = `stress-${data.intensity}-vu${vuId}-iter${iteration}`;

  try {
    // Track active batches
    activeBatches.add(1);

    // Create batch
    const createStart = Date.now();
    const batch = client.createBatch({
      name: batchName,
      recipientCount: data.batchSize,
      subject: `Load Test - ${data.intensity} - VU${vuId}`,
      dryRun: data.dryRun,
    });
    const createTime = Date.now() - createStart;

    if (!batch || !batch.id) {
      errorsByType.creation.add(1);
      metrics.batchesFailed.add(1);
      metrics.batchFailRate.add(true);
      activeBatches.add(-1);
      return;
    }

    // Send batch
    const sendStart = Date.now();
    const sendResult = client.sendBatch(batch.id);
    const queueTime = Date.now() - sendStart;
    batchQueueTime.add(queueTime);

    if (!sendResult) {
      errorsByType.send.add(1);
      metrics.batchesFailed.add(1);
      metrics.batchFailRate.add(true);
      activeBatches.add(-1);
      return;
    }

    // Wait for completion
    const processStart = Date.now();
    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 300, // 5 minutes max
      pollIntervalSeconds: 2,
      silent: true,
    });
    const processTime = Date.now() - processStart;
    batchProcessTime.add(processTime);

    // Record results
    activeBatches.add(-1);

    if (result && result.status === 'completed') {
      metrics.batchesCompleted.add(1);
      metrics.batchFailRate.add(false);
      totalRecipients.add(data.batchSize);

      const totalTime = Date.now() - createStart;
      const throughput = data.batchSize / (totalTime / 1000);
      systemThroughput.add(throughput);
      metrics.batchThroughput.add(throughput);
      metrics.batchCompletionDuration.add(totalTime);

      // Log progress periodically
      if (iteration % 5 === 0) {
        console.log(`VU${vuId}: Batch ${iteration + 1} completed - ${throughput.toFixed(1)} rec/sec`);
      }
    } else {
      errorsByType.timeout.add(1);
      metrics.batchesFailed.add(1);
      metrics.batchFailRate.add(true);
      console.log(`VU${vuId}: Batch ${iteration + 1} failed or timed out`);
    }

  } catch (error) {
    activeBatches.add(-1);
    errorsByType.other.add(1);
    metrics.batchesFailed.add(1);
    metrics.batchFailRate.add(true);
    console.error(`VU${vuId}: Error - ${error.message}`);
  }

  // Small delay between batches
  sleep(Math.random() * 2 + 1);
}

// =============================================================================
// Teardown
// =============================================================================

export function teardown(data) {
  console.log('\nCleaning up...');

  try {
    const client = TestClient.fromContext(data);
    client.cleanup();
    console.log('✓ Test resources cleaned up');
  } catch (error) {
    console.error(`Cleanup error: ${error.message}`);
  }
}

// =============================================================================
// Summary
// =============================================================================

export function handleSummary(data) {
  const duration = data.state?.testRunDurationMs || 0;
  const completed = data.metrics.batches_completed?.values?.count || 0;
  const failed = data.metrics.batches_failed?.values?.count || 0;
  const totalRec = data.metrics.total_recipients_sent?.values?.count || 0;
  const avgThroughput = data.metrics.system_throughput_rps?.values?.avg || 0;
  const p95Latency = data.metrics.batch_completion_duration?.values?.['p(95)'] || 0;
  const errorRate = data.metrics.batch_fail_rate?.values?.rate || 0;

  const overallThroughput = totalRec / (duration / 1000);

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                      REMOTE STRESS TEST RESULTS                              ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Target:           ${API_URL.padEnd(56)}║
║  Intensity:        ${INTENSITY.toUpperCase().padEnd(56)}║
║  Duration:         ${(duration / 1000 / 60).toFixed(1).padEnd(53)} min ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Batches Completed: ${completed.toString().padEnd(55)}║
║  Batches Failed:    ${failed.toString().padEnd(55)}║
║  Error Rate:        ${(errorRate * 100).toFixed(2).padEnd(54)} % ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Recipients Sent:   ${totalRec.toLocaleString().padEnd(55)}║
║  Avg Throughput:    ${avgThroughput.toFixed(1).padEnd(52)} /sec ║
║  Overall Throughput: ${overallThroughput.toFixed(1).padEnd(51)} /sec ║
║  P95 Latency:       ${(p95Latency / 1000).toFixed(1).padEnd(54)} s ║
╚══════════════════════════════════════════════════════════════════════════════╝
`);

  // Analysis
  console.log('\n=== Analysis ===');

  if (errorRate > 0.05) {
    console.log(`⚠️  Error rate ${(errorRate * 100).toFixed(2)}% exceeds 5% threshold`);
  } else {
    console.log(`✓  Error rate ${(errorRate * 100).toFixed(2)}% is acceptable`);
  }

  if (avgThroughput < 50) {
    console.log(`⚠️  Throughput ${avgThroughput.toFixed(1)}/sec is below expected`);
  } else {
    console.log(`✓  Throughput ${avgThroughput.toFixed(1)}/sec is healthy`);
  }

  if (p95Latency > 60000) {
    console.log(`⚠️  P95 latency ${(p95Latency / 1000).toFixed(1)}s is high`);
  } else {
    console.log(`✓  P95 latency ${(p95Latency / 1000).toFixed(1)}s is acceptable`);
  }

  return generateTestReport(data, {
    name: `Remote Stress Test - ${INTENSITY}`,
    testType: 'remote-stress',
    preset: INTENSITY,
    parameters: {
      apiUrl: API_URL,
      intensity: INTENSITY,
      virtualUsers: config.vus,
      batchSize: BATCH_SIZE,
      batchesPerVu: config.batchesPerVu,
      dryRun: DRY_RUN,
      expectedRecipients: config.vus * config.batchesPerVu * BATCH_SIZE,
    },
    thresholds: {
      'throughput.average': { operator: '>=', value: 10 },
      'latency.p95': { operator: '<=', value: 300000 },
      'errors.rate': { operator: '<=', value: 0.05 },
    },
  });
}
