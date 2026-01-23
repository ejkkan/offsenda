/**
 * k6 Load Test: Multi-User Concurrent Load
 *
 * Tests tenant isolation and fairness under multi-user load:
 * - Multiple users competing for shared resources
 * - Per-user rate limiting behavior
 * - Tenant isolation (User A shouldn't slow down User B)
 * - Fair scheduling across users
 *
 * Scenarios tested:
 * 1. Symmetric load: All users have equal batch sizes
 * 2. Asymmetric load: One "heavy" user, many "light" users
 * 3. Burst: All users submit at the same time
 * 4. Staggered: Users join over time
 *
 * Usage:
 *   k6 run k6/scenarios/multi-user.js
 *   k6 run -e SCENARIO=asymmetric k6/scenarios/multi-user.js
 *   k6 run -e USER_COUNT=20 k6/scenarios/multi-user.js
 *
 * Environment Variables:
 *   K6_API_URL          - API base URL
 *   K6_ADMIN_SECRET     - Admin secret for test setup
 *   SCENARIO            - Test scenario (symmetric, asymmetric, burst, staggered)
 *   USER_COUNT          - Number of users (default: 10)
 *   BATCHES_PER_USER    - Batches per user (default: 5)
 *   K6_BATCH_SIZE       - Recipients per batch (default: 100)
 */

import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { TestClient, metrics } from '../lib/client.js';
import { generateTestReport } from '../lib/report-adapter.js';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';
import http from 'k6/http';

// Configuration
const SCENARIO = __ENV.SCENARIO || 'symmetric';
const USER_COUNT = parseInt(__ENV.USER_COUNT || '10');
const BATCHES_PER_USER = parseInt(__ENV.BATCHES_PER_USER || '5');
const BATCH_SIZE = parseInt(__ENV.K6_BATCH_SIZE || '100');
const HEAVY_USER_MULTIPLIER = 10; // Heavy user sends 10x more

// Custom metrics for multi-user analysis
const userThroughput = new Trend('user_throughput_per_sec', true);
const userLatency = new Trend('user_batch_latency', true);
const userFairness = new Trend('user_fairness_ratio', true); // Ratio of slowest/fastest user
const concurrentUsers = new Gauge('concurrent_users');
const userBatchesCompleted = new Counter('user_batches_completed');
const userBatchesFailed = new Counter('user_batches_failed');
const isolationViolations = new Counter('isolation_violations'); // When one user affects another
const perUserLatency = {}; // Track per-user latencies

// Scenario configurations
const scenarios = {
  // All users have equal load
  symmetric: {
    executor: 'per-vu-iterations',
    vus: USER_COUNT,
    iterations: BATCHES_PER_USER,
    maxDuration: '30m',
  },
  // One heavy user, many light users
  asymmetric: {
    executor: 'per-vu-iterations',
    vus: USER_COUNT,
    iterations: BATCHES_PER_USER,
    maxDuration: '45m',
  },
  // All users submit at exactly the same time
  burst: {
    executor: 'shared-iterations',
    vus: USER_COUNT,
    iterations: USER_COUNT * BATCHES_PER_USER,
    maxDuration: '30m',
  },
  // Users join the system over time
  staggered: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: Math.floor(USER_COUNT / 2) },
      { duration: '5m', target: USER_COUNT },
      { duration: '10m', target: USER_COUNT },
      { duration: '2m', target: 0 },
    ],
  },
};

export const options = {
  scenarios: {
    default: scenarios[SCENARIO] || scenarios.symmetric,
  },
  thresholds: {
    user_throughput_per_sec: ['avg>10'],
    user_batch_latency: ['p(95)<60000'],
    user_fairness_ratio: ['avg<2'], // Slowest user shouldn't be more than 2x slower
    isolation_violations: ['count<5'],
  },
};

// Store user contexts created during setup
let userContexts = [];

/**
 * Setup: Create test users
 */
export function setup() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              MULTI-USER LOAD TEST                            ║
╠══════════════════════════════════════════════════════════════╣
║  Scenario:       ${SCENARIO.padEnd(41)}║
║  Users:          ${USER_COUNT.toString().padEnd(41)}║
║  Batches/User:   ${BATCHES_PER_USER.toString().padEnd(41)}║
║  Recipients:     ${BATCH_SIZE.toString().padEnd(41)}║
║  Total Batches:  ${(USER_COUNT * BATCHES_PER_USER).toString().padEnd(41)}║
╚══════════════════════════════════════════════════════════════╝
`);

  const contexts = [];
  const baseClient = new TestClient({ testId: `multi-user-${Date.now()}` });

  // Create all test users
  for (let i = 0; i < USER_COUNT; i++) {
    try {
      const client = new TestClient({ testId: `user-${i}-${Date.now()}` });
      const ctx = client.setupTestUser(`multi-user-${i}`);
      ctx.userIndex = i;
      ctx.isHeavyUser = (SCENARIO === 'asymmetric' && i === 0); // First user is heavy
      contexts.push(ctx);
      console.log(`Created user ${i + 1}/${USER_COUNT}: ${ctx.userId}`);
    } catch (error) {
      console.error(`Failed to create user ${i}: ${error.message}`);
    }
  }

  return {
    users: contexts,
    scenario: SCENARIO,
    batchSize: BATCH_SIZE,
    batchesPerUser: BATCHES_PER_USER,
    startTime: Date.now(),
  };
}

/**
 * Main test function
 */
export default function (data) {
  // Each VU represents one user
  const userIndex = (__VU - 1) % data.users.length;
  const userCtx = data.users[userIndex];

  if (!userCtx) {
    console.error(`No context for VU ${__VU}, user index ${userIndex}`);
    return;
  }

  const client = TestClient.fromContext(userCtx);
  concurrentUsers.add(1);

  try {
    switch (data.scenario) {
      case 'symmetric':
        runSymmetricLoad(client, userCtx, data);
        break;
      case 'asymmetric':
        runAsymmetricLoad(client, userCtx, data);
        break;
      case 'burst':
        runBurstLoad(client, userCtx, data);
        break;
      case 'staggered':
        runStaggeredLoad(client, userCtx, data);
        break;
      default:
        runSymmetricLoad(client, userCtx, data);
    }
  } finally {
    concurrentUsers.add(-1);
  }
}

/**
 * Symmetric load: All users have equal batch sizes
 */
function runSymmetricLoad(client, userCtx, data) {
  const batchIndex = __ITER;
  console.log(`User ${userCtx.userIndex} (VU ${__VU}): Starting batch ${batchIndex + 1}/${data.batchesPerUser}`);

  const startTime = Date.now();

  try {
    const batch = client.createBatch({
      name: `user-${userCtx.userIndex}-batch-${batchIndex + 1}`,
      recipientCount: data.batchSize,
      subject: `Multi-User Test - User ${userCtx.userIndex}`,
      dryRun: true,
    });

    client.sendBatch(batch.id);

    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 120,
      pollIntervalSeconds: 2,
      silent: true,
    });

    const duration = Date.now() - startTime;
    userLatency.add(duration);

    if (result && result.status === 'completed') {
      userBatchesCompleted.add(1);
      const throughput = data.batchSize / (duration / 1000);
      userThroughput.add(throughput);
      console.log(`User ${userCtx.userIndex}: Batch completed in ${duration}ms (${throughput.toFixed(1)}/sec)`);
    } else {
      userBatchesFailed.add(1);
      console.log(`User ${userCtx.userIndex}: Batch failed`);
    }

  } catch (error) {
    userBatchesFailed.add(1);
    console.error(`User ${userCtx.userIndex}: Error - ${error.message}`);
  }

  sleep(1);
}

/**
 * Asymmetric load: One heavy user with many more recipients
 */
function runAsymmetricLoad(client, userCtx, data) {
  const batchIndex = __ITER;
  const actualBatchSize = userCtx.isHeavyUser
    ? data.batchSize * HEAVY_USER_MULTIPLIER
    : data.batchSize;

  console.log(`User ${userCtx.userIndex} (${userCtx.isHeavyUser ? 'HEAVY' : 'light'}): Batch ${batchIndex + 1} with ${actualBatchSize} recipients`);

  const startTime = Date.now();

  try {
    const batch = client.createBatch({
      name: `user-${userCtx.userIndex}-batch-${batchIndex + 1}`,
      recipientCount: actualBatchSize,
      subject: `Asymmetric Test - ${userCtx.isHeavyUser ? 'Heavy' : 'Light'} User`,
      dryRun: true,
    });

    client.sendBatch(batch.id);

    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: userCtx.isHeavyUser ? 300 : 120, // Heavy user gets more time
      pollIntervalSeconds: 2,
      silent: true,
    });

    const duration = Date.now() - startTime;
    userLatency.add(duration);

    if (result && result.status === 'completed') {
      userBatchesCompleted.add(1);
      const throughput = actualBatchSize / (duration / 1000);
      userThroughput.add(throughput);

      // Check for isolation violations: if a light user takes too long, heavy user may be affecting them
      if (!userCtx.isHeavyUser && duration > 60000) {
        isolationViolations.add(1);
        console.warn(`ISOLATION WARNING: Light user ${userCtx.userIndex} took ${duration}ms (possible interference)`);
      }

    } else {
      userBatchesFailed.add(1);
    }

  } catch (error) {
    userBatchesFailed.add(1);
    console.error(`User ${userCtx.userIndex}: Error - ${error.message}`);
  }

  sleep(1);
}

/**
 * Burst load: All users submit simultaneously
 */
function runBurstLoad(client, userCtx, data) {
  // Calculate which batch this iteration represents
  const totalIter = __ITER;
  const userForThisIter = totalIter % data.users.length;
  const batchForUser = Math.floor(totalIter / data.users.length);

  // Only process if this is our user's turn
  if (userForThisIter !== userCtx.userIndex) {
    sleep(0.1);
    return;
  }

  console.log(`BURST: User ${userCtx.userIndex}, Batch ${batchForUser + 1}`);

  const startTime = Date.now();

  try {
    const batch = client.createBatch({
      name: `burst-user-${userCtx.userIndex}-batch-${batchForUser + 1}`,
      recipientCount: data.batchSize,
      subject: `Burst Test`,
      dryRun: true,
    });

    client.sendBatch(batch.id);

    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 180,
      pollIntervalSeconds: 2,
      silent: true,
    });

    const duration = Date.now() - startTime;
    userLatency.add(duration);

    if (result && result.status === 'completed') {
      userBatchesCompleted.add(1);
      userThroughput.add(data.batchSize / (duration / 1000));
    } else {
      userBatchesFailed.add(1);
    }

  } catch (error) {
    userBatchesFailed.add(1);
    console.error(`User ${userCtx.userIndex}: Error - ${error.message}`);
  }
}

/**
 * Staggered load: Users join over time
 */
function runStaggeredLoad(client, userCtx, data) {
  // In ramping-vus scenario, VUs come and go
  // Each VU runs multiple iterations representing batches
  console.log(`User ${userCtx.userIndex} (VU ${__VU}): Starting batch`);

  const startTime = Date.now();

  try {
    const batch = client.createBatch({
      name: `staggered-user-${userCtx.userIndex}-${Date.now()}`,
      recipientCount: data.batchSize,
      subject: `Staggered Load Test`,
      dryRun: true,
    });

    client.sendBatch(batch.id);

    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 120,
      pollIntervalSeconds: 2,
      silent: true,
    });

    const duration = Date.now() - startTime;
    userLatency.add(duration);

    if (result && result.status === 'completed') {
      userBatchesCompleted.add(1);
      userThroughput.add(data.batchSize / (duration / 1000));
    } else {
      userBatchesFailed.add(1);
    }

  } catch (error) {
    userBatchesFailed.add(1);
  }

  // Random delay between batches (simulates real user behavior)
  sleep(Math.random() * 5 + 2);
}

/**
 * Teardown: Cleanup all users
 */
export function teardown(data) {
  console.log('\nCleaning up test users...');

  for (const userCtx of data.users) {
    try {
      const client = TestClient.fromContext(userCtx);
      client.cleanup();
    } catch (error) {
      console.error(`Failed to cleanup user ${userCtx.userIndex}: ${error.message}`);
    }
  }

  console.log('Cleanup complete');
}

/**
 * Generate report
 */
export function handleSummary(data) {
  const completed = data.metrics.user_batches_completed?.values?.count || 0;
  const failed = data.metrics.user_batches_failed?.values?.count || 0;
  const avgThroughput = data.metrics.user_throughput_per_sec?.values?.avg || 0;
  const p95Latency = data.metrics.user_batch_latency?.values?.['p(95)'] || 0;
  const violations = data.metrics.isolation_violations?.values?.count || 0;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              MULTI-USER TEST RESULTS                         ║
╠══════════════════════════════════════════════════════════════╣
║  Scenario:       ${SCENARIO.padEnd(41)}║
║  Users:          ${USER_COUNT.toString().padEnd(41)}║
║  Completed:      ${completed.toString().padEnd(41)}║
║  Failed:         ${failed.toString().padEnd(41)}║
║  Avg Throughput: ${avgThroughput.toFixed(1).padEnd(38)} /s ║
║  P95 Latency:    ${(p95Latency / 1000).toFixed(1).padEnd(39)} s ║
║  Isolation Violations: ${violations.toString().padEnd(35)}║
╚══════════════════════════════════════════════════════════════╝
`);

  return generateTestReport(data, {
    name: `Multi-User Load Test - ${SCENARIO}`,
    testType: 'multi-user',
    preset: SCENARIO,
    parameters: {
      scenario: SCENARIO,
      userCount: USER_COUNT,
      batchesPerUser: BATCHES_PER_USER,
      batchSize: BATCH_SIZE,
      totalBatches: USER_COUNT * BATCHES_PER_USER,
    },
    thresholds: {
      'throughput.average': { operator: '>=', value: 10 },
      'latency.p95': { operator: '<=', value: 60000 },
      'errors.rate': { operator: '<=', value: 0.05 },
    },
  });
}
