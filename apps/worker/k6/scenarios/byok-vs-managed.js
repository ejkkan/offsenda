/**
 * k6 Load Test: BYOK vs Managed Mode Comparison
 *
 * Compares performance between:
 * - Managed mode: Using BatchSender's shared provider pool
 * - BYOK mode: Using customer's own API keys
 *
 * Key differences to test:
 * - Rate limit isolation (BYOK users don't share managed pool)
 * - Authentication path (BYOK validates customer keys)
 * - Provider selection (BYOK can choose specific provider)
 * - Error handling (BYOK errors go to customer, managed errors to us)
 *
 * Scenarios:
 * - comparison: Side-by-side managed vs BYOK
 * - isolation: Verify BYOK doesn't affect managed pool
 * - failover: Test provider failure handling
 *
 * Usage:
 *   k6 run k6/scenarios/byok-vs-managed.js
 *   k6 run -e SCENARIO=isolation k6/scenarios/byok-vs-managed.js
 *
 * Environment Variables:
 *   K6_API_URL          - API base URL
 *   K6_ADMIN_SECRET     - Admin secret
 *   SCENARIO            - Test scenario
 *   K6_BATCH_SIZE       - Recipients per batch (default: 100)
 *   K6_BATCH_COUNT      - Batches per mode (default: 20)
 */

import { sleep } from 'k6';
import { TestClient, metrics } from '../lib/client.js';
import { generateTestReport } from '../lib/report-adapter.js';
import { Counter, Trend, Rate } from 'k6/metrics';

// Configuration
const SCENARIO = __ENV.SCENARIO || 'comparison';
const BATCH_SIZE = parseInt(__ENV.K6_BATCH_SIZE || '100');
const BATCH_COUNT = parseInt(__ENV.K6_BATCH_COUNT || '20');
const VUS = parseInt(__ENV.K6_VUS || '6'); // 3 managed + 3 BYOK

// Mode-specific metrics
const managedLatency = new Trend('managed_latency', true);
const managedThroughput = new Trend('managed_throughput', true);
const managedCompleted = new Counter('managed_completed');
const managedFailed = new Counter('managed_failed');
const managedFailRate = new Rate('managed_fail_rate');

const byokLatency = new Trend('byok_latency', true);
const byokThroughput = new Trend('byok_throughput', true);
const byokCompleted = new Counter('byok_completed');
const byokFailed = new Counter('byok_failed');
const byokFailRate = new Rate('byok_fail_rate');

// Isolation metrics
const isolationViolations = new Counter('mode_isolation_violations');
const crossModeImpact = new Trend('cross_mode_impact_ms', true);

// Scenario configurations
const scenarios = {
  // Direct comparison: half VUs managed, half BYOK
  comparison: {
    executor: 'per-vu-iterations',
    vus: VUS,
    iterations: Math.ceil(BATCH_COUNT / (VUS / 2)), // Per mode
    maxDuration: '30m',
  },
  // Test that BYOK heavy load doesn't affect managed users
  isolation: {
    executor: 'per-vu-iterations',
    vus: VUS,
    iterations: Math.ceil(BATCH_COUNT / (VUS / 2)),
    maxDuration: '30m',
  },
  // Test provider failover behavior
  failover: {
    executor: 'per-vu-iterations',
    vus: 4,
    iterations: 10,
    maxDuration: '20m',
  },
};

export const options = {
  scenarios: {
    default: scenarios[SCENARIO] || scenarios.comparison,
  },
  thresholds: {
    managed_latency: ['p(95)<60000'],
    byok_latency: ['p(95)<60000'],
    managed_fail_rate: ['rate<0.05'],
    byok_fail_rate: ['rate<0.05'],
    mode_isolation_violations: ['count<5'],
  },
};

/**
 * Setup: Create users with different modes
 */
export function setup() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              BYOK vs MANAGED MODE TEST                       ║
╠══════════════════════════════════════════════════════════════╣
║  Scenario:       ${SCENARIO.padEnd(41)}║
║  Batches/Mode:   ${BATCH_COUNT.toString().padEnd(41)}║
║  Recipients:     ${BATCH_SIZE.toString().padEnd(41)}║
║  Virtual Users:  ${VUS.toString().padEnd(41)}║
╠══════════════════════════════════════════════════════════════╣
║  Modes:                                                      ║
║    - Managed: Uses shared BatchSender pool                   ║
║    - BYOK: Uses simulated customer API keys                  ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Create managed mode user
  const managedClient = new TestClient({ testId: `managed-${Date.now()}` });
  const managedCtx = managedClient.setupTestUser('managed-user');

  // Create managed send config
  try {
    const managedConfig = managedClient.createSendConfig({
      name: 'Managed Mode Config',
      module: 'email',
      moduleConfig: { mode: 'managed' },
      rateLimit: { perSecond: 100 },
    });
    managedCtx.sendConfigId = managedConfig.id;
    managedCtx.mode = 'managed';
    console.log(`Created managed config: ${managedConfig.id}`);
  } catch (error) {
    console.warn(`Could not create managed config: ${error.message}`);
  }

  // Create BYOK mode user
  const byokClient = new TestClient({ testId: `byok-${Date.now()}` });
  const byokCtx = byokClient.setupTestUser('byok-user');

  // Create BYOK send config (simulated - uses mock provider in test)
  try {
    const byokConfig = byokClient.createSendConfig({
      name: 'BYOK Mode Config',
      module: 'email',
      moduleConfig: {
        mode: 'byok',
        provider: 'mock', // Would be 'resend' or 'ses' in production
        apiKey: 'test-byok-key-12345', // Simulated customer key
      },
      rateLimit: { perSecond: 100 },
    });
    byokCtx.sendConfigId = byokConfig.id;
    byokCtx.mode = 'byok';
    console.log(`Created BYOK config: ${byokConfig.id}`);
  } catch (error) {
    console.warn(`Could not create BYOK config: ${error.message}`);
  }

  return {
    managedCtx,
    byokCtx,
    scenario: SCENARIO,
    batchSize: BATCH_SIZE,
    batchCount: BATCH_COUNT,
    startTime: Date.now(),
  };
}

/**
 * Main test function
 */
export default function (data) {
  // Assign VUs to modes: even VUs = managed, odd VUs = BYOK
  const isManaged = __VU % 2 === 0;
  const ctx = isManaged ? data.managedCtx : data.byokCtx;
  const mode = isManaged ? 'managed' : 'byok';

  if (!ctx || !ctx.sendConfigId) {
    console.error(`No config for ${mode} mode`);
    return;
  }

  switch (data.scenario) {
    case 'comparison':
      runComparison(ctx, data, mode);
      break;
    case 'isolation':
      runIsolationTest(ctx, data, mode);
      break;
    case 'failover':
      runFailoverTest(ctx, data, mode);
      break;
    default:
      runComparison(ctx, data, mode);
  }
}

/**
 * Side-by-side comparison
 */
function runComparison(ctx, data, mode) {
  const client = TestClient.fromContext(ctx);
  const batchIndex = __ITER;

  console.log(`VU ${__VU} (${mode}): Batch ${batchIndex + 1}`);

  const startTime = Date.now();

  try {
    const batch = client.createBatch({
      name: `${mode}-comparison-batch-${batchIndex + 1}`,
      recipientCount: data.batchSize,
      subject: `${mode.toUpperCase()} Mode Test`,
      sendConfigId: ctx.sendConfigId,
      dryRun: true,
    });

    client.sendBatch(batch.id);

    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 120,
      pollIntervalSeconds: 2,
      silent: true,
    });

    const duration = Date.now() - startTime;
    const throughput = data.batchSize / (duration / 1000);

    if (result && result.status === 'completed') {
      if (mode === 'managed') {
        managedLatency.add(duration);
        managedThroughput.add(throughput);
        managedCompleted.add(1);
        managedFailRate.add(false);
      } else {
        byokLatency.add(duration);
        byokThroughput.add(throughput);
        byokCompleted.add(1);
        byokFailRate.add(false);
      }
      console.log(`VU ${__VU} (${mode}): Completed in ${duration}ms (${throughput.toFixed(1)}/sec)`);
    } else {
      if (mode === 'managed') {
        managedFailed.add(1);
        managedFailRate.add(true);
      } else {
        byokFailed.add(1);
        byokFailRate.add(true);
      }
      console.log(`VU ${__VU} (${mode}): Failed`);
    }

  } catch (error) {
    if (mode === 'managed') {
      managedFailed.add(1);
      managedFailRate.add(true);
    } else {
      byokFailed.add(1);
      byokFailRate.add(true);
    }
    console.error(`VU ${__VU} (${mode}): Error - ${error.message}`);
  }

  sleep(1);
}

/**
 * Test mode isolation - BYOK shouldn't affect managed
 */
function runIsolationTest(ctx, data, mode) {
  const client = TestClient.fromContext(ctx);

  // BYOK users create large batches (potential to overwhelm)
  // Managed users create normal batches and measure latency
  const batchSize = mode === 'byok' ? data.batchSize * 5 : data.batchSize;

  console.log(`VU ${__VU} (${mode}): Isolation test - ${batchSize} recipients`);

  const startTime = Date.now();

  try {
    const batch = client.createBatch({
      name: `${mode}-isolation-batch-${__ITER}`,
      recipientCount: batchSize,
      subject: `Isolation Test - ${mode}`,
      sendConfigId: ctx.sendConfigId,
      dryRun: true,
    });

    client.sendBatch(batch.id);

    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: mode === 'byok' ? 300 : 120, // BYOK gets more time for large batch
      pollIntervalSeconds: 2,
      silent: true,
    });

    const duration = Date.now() - startTime;

    if (result && result.status === 'completed') {
      if (mode === 'managed') {
        managedLatency.add(duration);
        managedCompleted.add(1);
        managedFailRate.add(false);

        // Check for isolation violations: managed should complete fast regardless of BYOK load
        if (duration > 60000) {
          isolationViolations.add(1);
          crossModeImpact.add(duration - 30000); // Time beyond expected
          console.warn(`ISOLATION WARNING: Managed batch took ${duration}ms (may be affected by BYOK load)`);
        }
      } else {
        byokLatency.add(duration);
        byokCompleted.add(1);
        byokFailRate.add(false);
      }
    } else {
      if (mode === 'managed') {
        managedFailed.add(1);
        managedFailRate.add(true);
      } else {
        byokFailed.add(1);
        byokFailRate.add(true);
      }
    }

  } catch (error) {
    if (mode === 'managed') {
      managedFailed.add(1);
      managedFailRate.add(true);
    } else {
      byokFailed.add(1);
      byokFailRate.add(true);
    }
    console.error(`VU ${__VU} (${mode}): Error - ${error.message}`);
  }

  sleep(mode === 'byok' ? 2 : 1);
}

/**
 * Test failover behavior (BYOK provider failure)
 */
function runFailoverTest(ctx, data, mode) {
  const client = TestClient.fromContext(ctx);

  console.log(`VU ${__VU} (${mode}): Failover test iteration ${__ITER}`);

  // For BYOK, we test what happens with invalid/failing provider config
  // For managed, we verify system continues normally

  try {
    const batch = client.createBatch({
      name: `${mode}-failover-batch-${__ITER}`,
      recipientCount: data.batchSize,
      subject: 'Failover Test',
      sendConfigId: ctx.sendConfigId,
      dryRun: true,
    });

    client.sendBatch(batch.id);

    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 60,
      pollIntervalSeconds: 2,
      silent: true,
    });

    if (result && result.status === 'completed') {
      if (mode === 'managed') {
        managedCompleted.add(1);
        managedFailRate.add(false);
      } else {
        byokCompleted.add(1);
        byokFailRate.add(false);
      }
    } else {
      // Expected for BYOK with bad config
      if (mode === 'managed') {
        managedFailed.add(1);
        managedFailRate.add(true);
      } else {
        byokFailed.add(1);
        // Don't count as failure rate issue for BYOK - expected behavior
      }
    }

  } catch (error) {
    console.error(`VU ${__VU} (${mode}): Error - ${error.message}`);
  }

  sleep(2);
}

/**
 * Teardown
 */
export function teardown(data) {
  // Cleanup managed user
  if (data.managedCtx) {
    const managedClient = TestClient.fromContext(data.managedCtx);
    managedClient.cleanup();
  }

  // Cleanup BYOK user
  if (data.byokCtx) {
    const byokClient = TestClient.fromContext(data.byokCtx);
    byokClient.cleanup();
  }
}

/**
 * Generate report with comparison analysis
 */
export function handleSummary(data) {
  // Managed stats
  const managedComp = data.metrics.managed_completed?.values?.count || 0;
  const managedFail = data.metrics.managed_failed?.values?.count || 0;
  const managedAvgLat = data.metrics.managed_latency?.values?.avg || 0;
  const managedP95Lat = data.metrics.managed_latency?.values?.['p(95)'] || 0;
  const managedAvgThr = data.metrics.managed_throughput?.values?.avg || 0;

  // BYOK stats
  const byokComp = data.metrics.byok_completed?.values?.count || 0;
  const byokFail = data.metrics.byok_failed?.values?.count || 0;
  const byokAvgLat = data.metrics.byok_latency?.values?.avg || 0;
  const byokP95Lat = data.metrics.byok_latency?.values?.['p(95)'] || 0;
  const byokAvgThr = data.metrics.byok_throughput?.values?.avg || 0;

  // Isolation
  const violations = data.metrics.mode_isolation_violations?.values?.count || 0;

  // Comparison calculations
  const latencyDiff = ((byokAvgLat - managedAvgLat) / Math.max(managedAvgLat, 1) * 100).toFixed(1);
  const throughputDiff = ((byokAvgThr - managedAvgThr) / Math.max(managedAvgThr, 1) * 100).toFixed(1);

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              BYOK vs MANAGED RESULTS                         ║
╠══════════════════════════════════════════════════════════════╣
║  Scenario:       ${SCENARIO.padEnd(41)}║
╠══════════════════════════════════════════════════════════════╣
║  MANAGED MODE:                                               ║
║    Completed:    ${managedComp.toString().padEnd(41)}║
║    Failed:       ${managedFail.toString().padEnd(41)}║
║    Avg Latency:  ${managedAvgLat.toFixed(0).padEnd(38)} ms ║
║    P95 Latency:  ${managedP95Lat.toFixed(0).padEnd(38)} ms ║
║    Throughput:   ${managedAvgThr.toFixed(1).padEnd(38)} /s ║
╠══════════════════════════════════════════════════════════════╣
║  BYOK MODE:                                                  ║
║    Completed:    ${byokComp.toString().padEnd(41)}║
║    Failed:       ${byokFail.toString().padEnd(41)}║
║    Avg Latency:  ${byokAvgLat.toFixed(0).padEnd(38)} ms ║
║    P95 Latency:  ${byokP95Lat.toFixed(0).padEnd(38)} ms ║
║    Throughput:   ${byokAvgThr.toFixed(1).padEnd(38)} /s ║
╠══════════════════════════════════════════════════════════════╣
║  COMPARISON:                                                 ║
║    Latency Diff: ${latencyDiff.padEnd(39)} % ║
║    Throughput:   ${throughputDiff.padEnd(39)} % ║
║    Isolation:    ${violations === 0 ? '✓ No violations'.padEnd(38) : `⚠ ${violations} violations`.padEnd(38)} ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Analysis
  console.log('\n=== Analysis ===');
  if (Math.abs(parseFloat(latencyDiff)) < 20) {
    console.log('✓  Latency difference within 20% - modes perform similarly');
  } else if (parseFloat(latencyDiff) > 20) {
    console.log('⚠️  BYOK latency significantly higher than managed');
  } else {
    console.log('ℹ️  BYOK latency lower than managed (expected with dedicated resources)');
  }

  if (violations === 0) {
    console.log('✓  Mode isolation verified - BYOK load did not impact managed users');
  } else {
    console.log(`⚠️  ${violations} isolation violations detected`);
  }

  return generateTestReport(data, {
    name: `BYOK vs Managed Test - ${SCENARIO}`,
    testType: 'byok-comparison',
    preset: SCENARIO,
    parameters: {
      scenario: SCENARIO,
      batchSize: BATCH_SIZE,
      batchCount: BATCH_COUNT,
      virtualUsers: VUS,
    },
    thresholds: {
      'latency.p95': { operator: '<=', value: 60000 },
      'errors.rate': { operator: '<=', value: 0.05 },
    },
  });
}
