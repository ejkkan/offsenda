/**
 * k6 Load Test: Scheduled Sends
 *
 * Tests scheduled batch functionality - batches that are queued to send at a future time.
 * This tests a different code path than immediate sends:
 * - Job gets stored with scheduledAt timestamp
 * - Scheduler picks it up at the right time
 * - Time zone and DST edge cases
 *
 * Scenarios tested:
 * 1. Immediate send vs scheduled send performance comparison
 * 2. Multiple batches scheduled for the same time (burst)
 * 3. Staggered schedules (1 batch per minute for an hour)
 * 4. Schedule → Cancel → Reschedule flow
 *
 * Usage:
 *   k6 run k6/scenarios/scheduled-sends.js
 *   k6 run -e SCENARIO=burst k6/scenarios/scheduled-sends.js
 *   k6 run -e SCENARIO=staggered k6/scenarios/scheduled-sends.js
 *
 * Environment Variables:
 *   K6_API_URL          - API base URL
 *   K6_ADMIN_SECRET     - Admin secret for test setup
 *   SCENARIO            - Test scenario (immediate, burst, staggered, cancel_reschedule)
 *   K6_BATCH_SIZE       - Recipients per batch (default: 100)
 *   K6_BATCH_COUNT      - Number of batches (default: 10)
 */

import { sleep } from 'k6';
import { TestClient, metrics } from '../lib/client.js';
import { generateTestReport } from '../lib/report-adapter.js';
import { Counter, Trend, Rate } from 'k6/metrics';

// Configuration
const SCENARIO = __ENV.SCENARIO || 'immediate';
const BATCH_SIZE = parseInt(__ENV.K6_BATCH_SIZE || '100');
const BATCH_COUNT = parseInt(__ENV.K6_BATCH_COUNT || '10');
const VUS = parseInt(__ENV.K6_VUS || '5');

// Custom metrics for scheduled sends
const scheduleLatency = new Trend('schedule_latency', true);
const scheduledBatches = new Counter('scheduled_batches');
const immediatesBatches = new Counter('immediate_batches');
const cancelledBatches = new Counter('cancelled_batches');
const rescheduledBatches = new Counter('rescheduled_batches');
const scheduleAccuracy = new Trend('schedule_accuracy_ms', true); // How close to scheduled time did it actually start?
const scheduledFailRate = new Rate('scheduled_fail_rate');

// Scenario configurations
const scenarios = {
  // Compare immediate vs scheduled performance
  immediate: {
    executor: 'per-vu-iterations',
    vus: VUS,
    iterations: Math.ceil(BATCH_COUNT / VUS),
    maxDuration: '30m',
  },
  // Multiple batches all scheduled for the same moment
  burst: {
    executor: 'shared-iterations',
    vus: VUS,
    iterations: BATCH_COUNT,
    maxDuration: '30m',
  },
  // Staggered schedules over time
  staggered: {
    executor: 'per-vu-iterations',
    vus: 1, // Single VU for controlled scheduling
    iterations: BATCH_COUNT,
    maxDuration: '60m',
  },
  // Cancel and reschedule flow
  cancel_reschedule: {
    executor: 'per-vu-iterations',
    vus: VUS,
    iterations: Math.ceil(BATCH_COUNT / VUS),
    maxDuration: '30m',
  },
};

export const options = {
  scenarios: {
    default: scenarios[SCENARIO] || scenarios.immediate,
  },
  thresholds: {
    schedule_latency: ['p(95)<5000'],
    scheduled_fail_rate: ['rate<0.05'],
    batch_completion_duration: ['p(95)<120000'], // 2 min for scheduled batches
  },
};

/**
 * Setup: Create test user
 */
export function setup() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              SCHEDULED SENDS TEST                            ║
╠══════════════════════════════════════════════════════════════╣
║  Scenario:       ${SCENARIO.padEnd(41)}║
║  Batches:        ${BATCH_COUNT.toString().padEnd(41)}║
║  Recipients/Batch: ${BATCH_SIZE.toString().padEnd(39)}║
║  Virtual Users:  ${VUS.toString().padEnd(41)}║
╚══════════════════════════════════════════════════════════════╝
`);

  const client = new TestClient({ testId: `scheduled-${Date.now()}` });
  const ctx = client.setupTestUser('scheduled-test');

  return {
    ...ctx,
    scenario: SCENARIO,
    batchSize: BATCH_SIZE,
    batchCount: BATCH_COUNT,
  };
}

/**
 * Main test function
 */
export default function (ctx) {
  const client = TestClient.fromContext(ctx);

  switch (ctx.scenario) {
    case 'immediate':
      testImmediateVsScheduled(client, ctx);
      break;
    case 'burst':
      testScheduledBurst(client, ctx);
      break;
    case 'staggered':
      testStaggeredSchedules(client, ctx);
      break;
    case 'cancel_reschedule':
      testCancelAndReschedule(client, ctx);
      break;
    default:
      testImmediateVsScheduled(client, ctx);
  }
}

/**
 * Scenario 1: Compare immediate vs scheduled send performance
 */
function testImmediateVsScheduled(client, ctx) {
  const batchIndex = (__VU - 1) * Math.ceil(ctx.batchCount / parseInt(__ENV.K6_VUS || '5')) + __ITER;
  const isScheduled = batchIndex % 2 === 0; // Alternate between immediate and scheduled

  console.log(`VU ${__VU}: Creating ${isScheduled ? 'scheduled' : 'immediate'} batch ${batchIndex + 1}`);

  try {
    const batchOptions = {
      name: `${isScheduled ? 'scheduled' : 'immediate'}-batch-${batchIndex + 1}`,
      recipientCount: ctx.batchSize,
      subject: `Test Batch ${batchIndex + 1}`,
      dryRun: true,
    };

    if (isScheduled) {
      // Schedule for 30 seconds from now
      const scheduledTime = new Date(Date.now() + 30000);
      batchOptions.scheduledAt = scheduledTime.toISOString();
    }

    const start = Date.now();
    const batch = client.createBatch(batchOptions);
    scheduleLatency.add(Date.now() - start);

    if (isScheduled) {
      scheduledBatches.add(1);
      console.log(`VU ${__VU}: Batch ${batch.id} scheduled for ${batchOptions.scheduledAt}`);
    } else {
      immediatesBatches.add(1);
      // Send immediately
      client.sendBatch(batch.id);
    }

    // Wait for completion (scheduled batches will take longer)
    const maxWait = isScheduled ? 120 : 60; // 2 min for scheduled, 1 min for immediate
    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: maxWait,
      pollIntervalSeconds: 2,
    });

    if (result && result.status === 'completed') {
      scheduledFailRate.add(false);

      // For scheduled batches, calculate accuracy
      if (isScheduled && batchOptions.scheduledAt) {
        const scheduledTime = new Date(batchOptions.scheduledAt).getTime();
        const actualStartTime = new Date(result.startedAt || result.createdAt).getTime();
        const accuracy = Math.abs(actualStartTime - scheduledTime);
        scheduleAccuracy.add(accuracy);
        console.log(`VU ${__VU}: Schedule accuracy: ${accuracy}ms`);
      }
    } else {
      scheduledFailRate.add(true);
      console.log(`VU ${__VU}: Batch ${batch.id} failed or timed out`);
    }

  } catch (error) {
    scheduledFailRate.add(true);
    console.error(`VU ${__VU}: Error: ${error.message}`);
  }

  sleep(1);
}

/**
 * Scenario 2: Multiple batches all scheduled for the same moment (burst test)
 */
function testScheduledBurst(client, ctx) {
  // All VUs schedule their batches for the same time: 60 seconds from test start
  const burstTime = new Date(Date.now() + 60000);

  console.log(`VU ${__VU} Iter ${__ITER}: Scheduling batch for burst at ${burstTime.toISOString()}`);

  try {
    const batch = client.createBatch({
      name: `burst-batch-vu${__VU}-iter${__ITER}`,
      recipientCount: ctx.batchSize,
      subject: `Burst Test Batch`,
      scheduledAt: burstTime.toISOString(),
      dryRun: true,
    });

    scheduledBatches.add(1);
    console.log(`VU ${__VU}: Created batch ${batch.id} for burst`);

    // Wait for completion
    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 180, // 3 min (includes 60s wait + processing)
      pollIntervalSeconds: 5,
    });

    if (result && result.status === 'completed') {
      scheduledFailRate.add(false);
      const scheduledTime = burstTime.getTime();
      const actualStartTime = new Date(result.startedAt || Date.now()).getTime();
      scheduleAccuracy.add(Math.abs(actualStartTime - scheduledTime));
    } else {
      scheduledFailRate.add(true);
    }

  } catch (error) {
    scheduledFailRate.add(true);
    console.error(`VU ${__VU}: Error: ${error.message}`);
  }
}

/**
 * Scenario 3: Staggered schedules over time
 */
function testStaggeredSchedules(client, ctx) {
  // Schedule one batch per iteration, staggered by 1 minute
  const offset = __ITER * 60000; // 1 minute apart
  const scheduledTime = new Date(Date.now() + 30000 + offset); // Start 30s from now

  console.log(`Iter ${__ITER}: Scheduling batch for ${scheduledTime.toISOString()}`);

  try {
    const batch = client.createBatch({
      name: `staggered-batch-${__ITER + 1}`,
      recipientCount: ctx.batchSize,
      subject: `Staggered Test Batch ${__ITER + 1}`,
      scheduledAt: scheduledTime.toISOString(),
      dryRun: true,
    });

    scheduledBatches.add(1);

    // For staggered test, we just create and move on
    // The test duration will capture all completions
    console.log(`Created batch ${batch.id} scheduled for +${offset / 1000}s`);

    // Short delay before next iteration
    sleep(2);

  } catch (error) {
    scheduledFailRate.add(true);
    console.error(`Iter ${__ITER}: Error: ${error.message}`);
  }
}

/**
 * Scenario 4: Cancel and reschedule flow
 */
function testCancelAndReschedule(client, ctx) {
  const batchIndex = (__VU - 1) * Math.ceil(ctx.batchCount / parseInt(__ENV.K6_VUS || '5')) + __ITER;

  console.log(`VU ${__VU}: Testing cancel/reschedule flow for batch ${batchIndex + 1}`);

  try {
    // Step 1: Create scheduled batch (far in the future)
    const originalTime = new Date(Date.now() + 3600000); // 1 hour from now
    const batch = client.createBatch({
      name: `cancel-reschedule-batch-${batchIndex + 1}`,
      recipientCount: ctx.batchSize,
      subject: `Cancel/Reschedule Test`,
      scheduledAt: originalTime.toISOString(),
      dryRun: true,
    });

    scheduledBatches.add(1);
    console.log(`VU ${__VU}: Created batch ${batch.id}, scheduled for ${originalTime.toISOString()}`);

    sleep(2);

    // Step 2: Cancel the batch
    const cancelResponse = client._request('POST', `/api/batches/${batch.id}/cancel`);
    if (cancelResponse.status === 200) {
      cancelledBatches.add(1);
      console.log(`VU ${__VU}: Cancelled batch ${batch.id}`);
    }

    sleep(2);

    // Step 3: Reschedule for sooner (30 seconds from now)
    const newTime = new Date(Date.now() + 30000);
    const rescheduleResponse = client._request('POST', `/api/batches/${batch.id}/reschedule`, {
      scheduledAt: newTime.toISOString(),
    });

    if (rescheduleResponse.status === 200) {
      rescheduledBatches.add(1);
      console.log(`VU ${__VU}: Rescheduled batch ${batch.id} for ${newTime.toISOString()}`);
    }

    // Step 4: Wait for completion
    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 120,
      pollIntervalSeconds: 2,
    });

    if (result && result.status === 'completed') {
      scheduledFailRate.add(false);
    } else {
      scheduledFailRate.add(true);
    }

  } catch (error) {
    scheduledFailRate.add(true);
    console.error(`VU ${__VU}: Error: ${error.message}`);
  }

  sleep(1);
}

/**
 * Teardown
 */
export function teardown(ctx) {
  const client = TestClient.fromContext(ctx);
  client.cleanup();
}

/**
 * Generate report
 */
export function handleSummary(data) {
  return generateTestReport(data, {
    name: `Scheduled Sends Test - ${SCENARIO}`,
    testType: 'scheduled',
    preset: SCENARIO,
    parameters: {
      scenario: SCENARIO,
      batchSize: BATCH_SIZE,
      batchCount: BATCH_COUNT,
      virtualUsers: VUS,
    },
    thresholds: {
      'latency.p95': { operator: '<=', value: 120000 },
      'errors.rate': { operator: '<=', value: 0.05 },
    },
  });
}
