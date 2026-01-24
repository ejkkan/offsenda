/**
 * k6 Load Test: Verified Load Test with Accurate Metrics
 *
 * This test uses Prometheus metrics (via /api/metrics/summary) to report
 * accurate throughput numbers. Unlike standard k6 tests that calculate
 * throughput from batch completion time (which includes polling overhead),
 * this test queries the same Prometheus metrics that Grafana displays.
 *
 * Key Features:
 * - Uses bsk_test_* API keys which automatically force dryRun mode
 * - Queries real throughput from Prometheus
 * - Compares k6-calculated vs Prometheus-actual throughput
 * - Reports accuracy delta (should be within 10% for healthy tests)
 *
 * Usage:
 *   # Run against production (safe - uses test API key which forces dryRun)
 *   K6_ADMIN_SECRET="$ADMIN_SECRET" K6_API_URL="https://api.valuekeys.io" \
 *     k6 run k6/scenarios/verified-load-test.js
 *
 *   # Run with specific batch size
 *   K6_ADMIN_SECRET="$ADMIN_SECRET" K6_API_URL="https://api.valuekeys.io" \
 *     BATCH_SIZE=50000 k6 run k6/scenarios/verified-load-test.js
 *
 * Required Environment Variables:
 *   K6_ADMIN_SECRET    - Admin secret for test user creation and metrics access
 *   K6_API_URL         - Target API URL (default: http://localhost:6001)
 *
 * Optional Environment Variables:
 *   BATCH_SIZE         - Recipients per batch (default: 10000)
 *   NUM_BATCHES        - Number of batches to run (default: 3)
 *   ACCURACY_THRESHOLD - Max % difference between k6 and Prometheus (default: 50)
 */

import { sleep } from 'k6';
import { TestClient, metrics } from '../lib/client.js';
import { generateTestReport } from '../lib/report-adapter.js';
import { Counter, Trend, Gauge } from 'k6/metrics';

// =============================================================================
// Configuration
// =============================================================================

const API_URL = __ENV.K6_API_URL || __ENV.API_URL || 'http://localhost:6001';
const ADMIN_SECRET = __ENV.K6_ADMIN_SECRET || __ENV.ADMIN_SECRET;
const BATCH_SIZE = parseInt(__ENV.BATCH_SIZE || '10000');
const NUM_BATCHES = parseInt(__ENV.NUM_BATCHES || '3');
const ACCURACY_THRESHOLD = parseFloat(__ENV.ACCURACY_THRESHOLD || '50');

if (!ADMIN_SECRET) {
  throw new Error('K6_ADMIN_SECRET or ADMIN_SECRET environment variable is required');
}

// =============================================================================
// Custom Metrics
// =============================================================================

const prometheusRate = new Trend('prometheus_throughput_rps', true);
const k6Rate = new Trend('k6_calculated_throughput_rps', true);
const accuracyDelta = new Trend('accuracy_delta_percent', true);
const emailsSentDelta = new Counter('emails_sent_delta');
const prometheusAvailable = new Gauge('prometheus_available');

// =============================================================================
// Scenarios
// =============================================================================

export const options = {
  scenarios: {
    verified_load: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: NUM_BATCHES,
      maxDuration: '30m',
    },
  },
  thresholds: {
    batch_fail_rate: ['rate<0.05'],
    batch_completion_duration: ['p(95)<600000'], // 10 min max
    // Prometheus throughput should be at least 50/sec for a healthy system
    prometheus_throughput_rps: ['avg>50'],
    // Accuracy delta should be within threshold (k6 typically reports higher due to polling)
    accuracy_delta_percent: [`avg<${ACCURACY_THRESHOLD}`],
  },
};

// =============================================================================
// Setup
// =============================================================================

export function setup() {
  console.log(`
============================================================
  VERIFIED LOAD TEST - Prometheus-Backed Metrics
============================================================
  Target:           ${API_URL}
  Batch Size:       ${BATCH_SIZE.toLocaleString()} recipients
  Num Batches:      ${NUM_BATCHES}
  Accuracy Threshold: ${ACCURACY_THRESHOLD}%
------------------------------------------------------------
  Note: Uses bsk_test_* API key which forces dryRun mode
  No real emails will be sent - this is safe to run anytime
============================================================
`);

  // Create test client
  const client = new TestClient({
    baseUrl: API_URL,
    testId: `verified-load-${Date.now()}`,
  });

  // Setup test user (this creates a bsk_test_* API key)
  const ctx = client.setupTestUser('verified-load');

  console.log(`Test user created: ${ctx.userId}`);
  console.log(`API key prefix: ${ctx.apiKey?.slice(0, 12)}...`);

  // Verify the API key starts with bsk_test_ (safety check)
  if (!ctx.apiKey?.startsWith('bsk_test_')) {
    console.warn('WARNING: API key does not start with bsk_test_');
    console.warn('This may send real emails! Aborting for safety.');
    throw new Error('API key safety check failed');
  }

  console.log('API key verified: bsk_test_* prefix detected (dryRun enforced)');

  // Check if Prometheus is available
  const metricsCheck = client.getRealMetrics();
  if (metricsCheck) {
    console.log(`Prometheus status: ${metricsCheck.source}`);
    console.log(`Current emails_sent_total: ${metricsCheck.emailsSentTotal.toLocaleString()}`);
  } else {
    console.log('WARNING: Could not reach /api/metrics/summary endpoint');
  }

  console.log('\nStarting verified load test...\n');

  return {
    ...ctx,
    batchSize: BATCH_SIZE,
    numBatches: NUM_BATCHES,
    accuracyThreshold: ACCURACY_THRESHOLD,
    startTime: Date.now(),
    prometheusAvailable: metricsCheck?.source === 'prometheus',
    startEmailsSent: metricsCheck?.emailsSentTotal || 0,
  };
}

// =============================================================================
// Main Test
// =============================================================================

export default function (data) {
  const client = TestClient.fromContext(data);
  const iteration = __ITER;

  console.log(`\n--- Batch ${iteration + 1}/${data.numBatches} ---`);

  try {
    // Create batch
    const batch = client.createBatch({
      name: `verified-load-batch-${iteration}`,
      recipientCount: data.batchSize,
      subject: `Verified Load Test Batch ${iteration + 1}`,
      // Note: dryRun is automatically forced by bsk_test_* API key
    });

    if (!batch || !batch.id) {
      console.error('Failed to create batch');
      metrics.batchesFailed.add(1);
      metrics.batchFailRate.add(true);
      return;
    }

    console.log(`Batch created: ${batch.id}`);
    console.log(`Recipients: ${batch.totalRecipients.toLocaleString()}`);

    // Send batch
    const sendResult = client.sendBatch(batch.id);
    if (!sendResult) {
      console.error('Failed to send batch');
      metrics.batchesFailed.add(1);
      metrics.batchFailRate.add(true);
      return;
    }

    // Wait for completion WITH real metrics tracking
    const result = client.waitForCompletionWithMetrics(batch.id, {
      maxWaitSeconds: 600, // 10 minutes max for large batches
      pollIntervalSeconds: 2,
      silent: false,
    });

    if (!result || !result.batch) {
      console.error('Batch completion tracking failed');
      metrics.batchesFailed.add(1);
      metrics.batchFailRate.add(true);
      return;
    }

    // Record metrics
    if (result.metrics) {
      const m = result.metrics;

      k6Rate.add(m.k6Throughput);
      prometheusRate.add(m.realThroughput);
      emailsSentDelta.add(m.emailsSentDelta);
      prometheusAvailable.add(m.prometheusAvailable ? 1 : 0);

      // Calculate and record accuracy delta
      if (m.realThroughput > 0) {
        const delta = Math.abs(((m.k6Throughput - m.realThroughput) / m.realThroughput) * 100);
        accuracyDelta.add(delta);

        console.log(`\n=== Batch ${iteration + 1} Results ===`);
        console.log(`Status: ${result.batch.status}`);
        console.log(`k6 calculated: ${m.k6Throughput.toFixed(1)}/sec`);
        console.log(`Prometheus actual: ${m.realThroughput.toFixed(1)}/sec`);
        console.log(`Accuracy delta: ${delta.toFixed(1)}%`);
        console.log(`Emails sent: ${m.emailsSentDelta.toLocaleString()}`);

        if (delta > data.accuracyThreshold) {
          console.warn(`WARNING: Accuracy delta ${delta.toFixed(1)}% exceeds threshold ${data.accuracyThreshold}%`);
        }
      }
    }

  } catch (error) {
    console.error(`Error: ${error.message}`);
    metrics.batchesFailed.add(1);
    metrics.batchFailRate.add(true);
  }

  // Brief pause between batches
  sleep(5);
}

// =============================================================================
// Teardown
// =============================================================================

export function teardown(data) {
  console.log('\n--- Cleanup ---');

  try {
    const client = TestClient.fromContext(data);

    // Get final metrics
    const finalMetrics = client.getRealMetrics();
    if (finalMetrics) {
      const totalSent = finalMetrics.emailsSentTotal - data.startEmailsSent;
      console.log(`Total emails sent during test: ${totalSent.toLocaleString()}`);
      console.log(`Final Prometheus rate (1m): ${finalMetrics.emailsSentRate1m.toFixed(1)}/sec`);
    }

    client.cleanup();
    console.log('Test resources cleaned up');
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
  const errorRate = data.metrics.batch_fail_rate?.values?.rate || 0;

  // Key metrics for comparison
  const avgK6Throughput = data.metrics.k6_calculated_throughput_rps?.values?.avg || 0;
  const avgPrometheusRate = data.metrics.prometheus_throughput_rps?.values?.avg || 0;
  const avgAccuracyDelta = data.metrics.accuracy_delta_percent?.values?.avg || 0;
  const totalEmailsSent = data.metrics.emails_sent_delta?.values?.count || 0;

  const durationMin = (duration / 1000 / 60).toFixed(1);

  console.log(`
============================================================
  VERIFIED LOAD TEST - RESULTS
============================================================
  Duration:         ${durationMin} minutes
  Batches:          ${completed} completed, ${failed} failed
  Error Rate:       ${(errorRate * 100).toFixed(2)}%
------------------------------------------------------------
  THROUGHPUT COMPARISON
------------------------------------------------------------
  k6 Calculated:    ${avgK6Throughput.toFixed(1)}/sec (includes polling overhead)
  Prometheus Actual: ${avgPrometheusRate.toFixed(1)}/sec (source of truth)
  Accuracy Delta:   ${avgAccuracyDelta.toFixed(1)}%
  Total Emails:     ${totalEmailsSent.toLocaleString()}
------------------------------------------------------------
  VERDICT
------------------------------------------------------------`);

  // Analysis
  let passed = true;

  if (avgAccuracyDelta > ACCURACY_THRESHOLD) {
    console.log(`  FAIL: Accuracy delta ${avgAccuracyDelta.toFixed(1)}% exceeds ${ACCURACY_THRESHOLD}%`);
    passed = false;
  } else {
    console.log(`  PASS: Accuracy delta ${avgAccuracyDelta.toFixed(1)}% within ${ACCURACY_THRESHOLD}%`);
  }

  if (avgPrometheusRate < 50 && completed > 0) {
    console.log(`  WARN: Prometheus rate ${avgPrometheusRate.toFixed(1)}/sec is below 50/sec`);
  } else if (completed > 0) {
    console.log(`  PASS: Prometheus rate ${avgPrometheusRate.toFixed(1)}/sec is healthy`);
  }

  if (errorRate > 0.05) {
    console.log(`  FAIL: Error rate ${(errorRate * 100).toFixed(2)}% exceeds 5%`);
    passed = false;
  } else {
    console.log(`  PASS: Error rate ${(errorRate * 100).toFixed(2)}% acceptable`);
  }

  console.log(`
============================================================
  OVERALL: ${passed ? 'PASSED' : 'FAILED'}
============================================================

NOTE: For accurate throughput comparison with Grafana:
  - Use the "Prometheus Actual" rate
  - k6 calculated rate is inflated due to polling overhead
  - Numbers should match Grafana's emails_sent_total rate
`);

  // Collect Prometheus metrics for report
  const prometheusMetrics = {
    realThroughput: avgPrometheusRate,
    emailsSentDelta: totalEmailsSent,
    k6Throughput: avgK6Throughput,
    prometheusAvailable: data.metrics.prometheus_available?.values?.value === 1,
    emailsSentRate1m: avgPrometheusRate,
  };

  return generateTestReport(data, {
    name: 'Verified Load Test',
    testType: 'verified-load',
    preset: 'verified',
    parameters: {
      apiUrl: API_URL,
      batchSize: BATCH_SIZE,
      numBatches: NUM_BATCHES,
      accuracyThreshold: ACCURACY_THRESHOLD,
      expectedRecipients: BATCH_SIZE * NUM_BATCHES,
    },
    thresholds: {
      'throughput.average': { operator: '>=', value: 50 },
      'latency.p95': { operator: '<=', value: 600000 },
      'errors.rate': { operator: '<=', value: 0.05 },
      'accuracy.accuracyDelta': { operator: '<=', value: ACCURACY_THRESHOLD },
    },
    prometheusMetrics,
  });
}
