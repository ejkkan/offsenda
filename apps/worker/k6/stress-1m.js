/**
 * k6 Stress Test: 1 Million Recipients
 *
 * Tests system capacity with 1M total recipients across multiple batches.
 * Uses the TestClient for automatic user/resource management.
 *
 * Usage:
 *   # Local
 *   k6 run k6/stress-1m.js
 *
 *   # Against production (with admin secret)
 *   K6_API_URL=https://api.batchsender.com K6_ADMIN_SECRET=xxx k6 run k6/stress-1m.js
 *
 * Environment Variables:
 *   K6_API_URL          - API base URL (default: http://localhost:6001)
 *   K6_ADMIN_SECRET     - Admin secret for test setup API
 *   K6_BATCH_COUNT      - Number of batches (default: 10)
 *   K6_RECIPIENTS_PER   - Recipients per batch (default: 100000)
 *   K6_VUS              - Virtual users (default: 10)
 *   K6_DRY_RUN          - If "true", use dry run mode (no actual sends)
 */

import { sleep } from 'k6';
import { TestClient, metrics } from './lib/client.js';
import { generateTestReport } from './lib/report-adapter.js';

// Configuration
const BATCH_COUNT = parseInt(__ENV.K6_BATCH_COUNT || '10');
const RECIPIENTS_PER_BATCH = parseInt(__ENV.K6_RECIPIENTS_PER || '100000');
const TOTAL_RECIPIENTS = BATCH_COUNT * RECIPIENTS_PER_BATCH;
const VUS = parseInt(__ENV.K6_VUS || '10');
const DRY_RUN = __ENV.K6_DRY_RUN === 'true';

export const options = {
  scenarios: {
    stress: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: Math.ceil(BATCH_COUNT / VUS), // Distribute batches across VUs
      maxDuration: '60m',
    },
  },
  thresholds: {
    batch_completion_duration: ['p(95)<300000'], // 5 minutes per batch
    batch_fail_rate: ['rate<0.05'],              // Less than 5% batch failures
    batch_throughput_per_sec: ['avg>500'],       // At least 500/sec average
  },
};

// Shared state for coordination
let sharedContext = null;
let batchCounter = 0;

/**
 * Setup: Create test users with high rate limits
 */
export function setup() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              1M STRESS TEST CONFIGURATION                    ║
╠══════════════════════════════════════════════════════════════╣
║  Total Recipients: ${TOTAL_RECIPIENTS.toLocaleString().padEnd(40)}║
║  Batches:          ${BATCH_COUNT.toString().padEnd(40)}║
║  Recipients/Batch: ${RECIPIENTS_PER_BATCH.toLocaleString().padEnd(40)}║
║  Virtual Users:    ${VUS.toString().padEnd(40)}║
║  Dry Run:          ${DRY_RUN.toString().padEnd(40)}║
╚══════════════════════════════════════════════════════════════╝
`);

  const client = new TestClient({ testId: `stress-1m-${Date.now()}` });

  // Create test user with high-throughput config
  const ctx = client.setupTestUser('stress-1m');

  console.log(`Test user created: ${ctx.userId}`);

  return ctx;
}

/**
 * Main test function - each VU creates and processes batches
 */
export default function (ctx) {
  const client = TestClient.fromContext(ctx);

  // Each VU takes one batch at a time
  const batchIndex = __VU * options.scenarios.stress.iterations + __ITER;

  if (batchIndex >= BATCH_COUNT) {
    console.log(`VU ${__VU}: No more batches to process`);
    return;
  }

  console.log(`VU ${__VU}: Starting batch ${batchIndex + 1}/${BATCH_COUNT}`);

  try {
    // Create batch with specified recipients
    const batch = client.createBatch({
      name: `stress-1m-batch-${batchIndex + 1}`,
      recipientCount: RECIPIENTS_PER_BATCH,
      subject: `Stress Test Batch ${batchIndex + 1}`,
      dryRun: DRY_RUN,
    });

    // Send the batch
    client.sendBatch(batch.id);

    // Wait for completion (with progress logging)
    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 600, // 10 minutes max per batch
      pollIntervalSeconds: 5,
    });

    if (result && result.status === 'completed') {
      console.log(`VU ${__VU}: Batch ${batchIndex + 1} completed - ${result.sentCount}/${result.totalRecipients} sent`);
    } else {
      console.log(`VU ${__VU}: Batch ${batchIndex + 1} failed or timed out`);
    }

  } catch (error) {
    console.error(`VU ${__VU}: Error processing batch ${batchIndex + 1}: ${error.message}`);
    metrics.batchesFailed.add(1);
    metrics.batchFailRate.add(true);
  }

  // Small delay between batches
  sleep(1);
}

/**
 * Teardown: Clean up test resources and generate report
 */
export function teardown(ctx) {
  const client = TestClient.fromContext(ctx);

  console.log('\n' + '='.repeat(60));
  console.log('CLEANUP: Deleting test resources...');
  console.log('='.repeat(60));

  client.cleanup();

  console.log('Cleanup complete');
}

/**
 * Generate standardized test report
 */
export function handleSummary(data) {
  const completed = data.metrics.batches_completed?.values?.count || 0;
  const failed = data.metrics.batches_failed?.values?.count || 0;
  const avgThroughput = data.metrics.batch_throughput_per_sec?.values?.avg || 0;
  const p95Completion = data.metrics.batch_completion_duration?.values?.['p(95)'] || 0;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    STRESS TEST RESULTS                       ║
╠══════════════════════════════════════════════════════════════╣
║  Batches Completed: ${completed.toString().padEnd(39)}║
║  Batches Failed:    ${failed.toString().padEnd(39)}║
║  Avg Throughput:    ${avgThroughput.toFixed(1).padEnd(36)} msg/s ║
║  P95 Completion:    ${(p95Completion / 1000).toFixed(1).padEnd(38)} s ║
╚══════════════════════════════════════════════════════════════╝
`);

  return generateTestReport(data, {
    name: `Stress Test - ${TOTAL_RECIPIENTS.toLocaleString()} Recipients`,
    testType: 'stress',
    preset: 'stress-1m',
    parameters: {
      totalRecipients: TOTAL_RECIPIENTS,
      batchCount: BATCH_COUNT,
      recipientsPerBatch: RECIPIENTS_PER_BATCH,
      virtualUsers: VUS,
      dryRun: DRY_RUN,
    },
    thresholds: {
      'throughput.average': { operator: '>=', value: 500 },
      'latency.p95': { operator: '<=', value: 300000 },
      'errors.rate': { operator: '<=', value: 0.05 },
    },
  });
}
