/**
 * k6 Load Test: SMS Module Throughput
 *
 * Tests SMS-specific functionality with different rate limits and providers.
 * SMS has different characteristics than email:
 * - Lower rate limits (Telnyx: 50/sec vs Email: 100/sec)
 * - No batch API (parallel individual calls)
 * - Different webhook patterns (delivery reports)
 *
 * Scenarios:
 * - baseline: Standard SMS throughput
 * - high_volume: Push SMS limits
 * - mixed: SMS + Email concurrent (resource sharing)
 * - webhook_flood: SMS delivery webhooks (Telnyx callbacks)
 *
 * Usage:
 *   k6 run k6/scenarios/sms-throughput.js
 *   k6 run -e SCENARIO=high_volume k6/scenarios/sms-throughput.js
 *   k6 run -e SCENARIO=mixed k6/scenarios/sms-throughput.js
 *
 * Environment Variables:
 *   K6_API_URL          - API base URL
 *   K6_WORKER_URL       - Worker URL (for webhooks)
 *   K6_ADMIN_SECRET     - Admin secret for test setup
 *   SCENARIO            - Test scenario
 *   K6_BATCH_SIZE       - Recipients per batch (default: 50)
 *   K6_BATCH_COUNT      - Number of batches (default: 20)
 */

import { sleep } from 'k6';
import http from 'k6/http';
import { check } from 'k6';
import { TestClient, metrics } from '../lib/client.js';
import { generateTestReport } from '../lib/report-adapter.js';
import { Counter, Trend, Rate } from 'k6/metrics';

// Configuration
const SCENARIO = __ENV.SCENARIO || 'baseline';
const BATCH_SIZE = parseInt(__ENV.K6_BATCH_SIZE || '50');
const BATCH_COUNT = parseInt(__ENV.K6_BATCH_COUNT || '20');
const VUS = parseInt(__ENV.K6_VUS || '5');
const WORKER_URL = __ENV.K6_WORKER_URL || 'http://localhost:6001';

// Custom metrics for SMS
const smsThroughput = new Trend('sms_throughput_per_sec', true);
const smsLatency = new Trend('sms_batch_latency', true);
const smsWebhookLatency = new Trend('sms_webhook_latency', true);
const smsBatchesCompleted = new Counter('sms_batches_completed');
const smsBatchesFailed = new Counter('sms_batches_failed');
const smsWebhooksProcessed = new Counter('sms_webhooks_processed');
const emailBatchesCompleted = new Counter('email_batches_completed'); // For mixed scenario
const smsFailRate = new Rate('sms_fail_rate');

// Scenario configurations
const scenarios = {
  baseline: {
    executor: 'per-vu-iterations',
    vus: VUS,
    iterations: Math.ceil(BATCH_COUNT / VUS),
    maxDuration: '30m',
  },
  high_volume: {
    executor: 'ramping-arrival-rate',
    startRate: 1,
    timeUnit: '1s',
    preAllocatedVUs: 20,
    maxVUs: 50,
    stages: [
      { duration: '1m', target: 5 },
      { duration: '3m', target: 10 },
      { duration: '3m', target: 20 },
      { duration: '2m', target: 5 },
      { duration: '1m', target: 0 },
    ],
  },
  mixed: {
    // Run SMS and Email batches concurrently
    executor: 'per-vu-iterations',
    vus: VUS * 2, // Double VUs for mixed
    iterations: BATCH_COUNT,
    maxDuration: '30m',
  },
  webhook_flood: {
    // Simulate Telnyx sending delivery webhooks
    executor: 'ramping-arrival-rate',
    startRate: 100,
    timeUnit: '1s',
    preAllocatedVUs: 50,
    maxVUs: 200,
    stages: [
      { duration: '30s', target: 500 },
      { duration: '2m', target: 1000 },
      { duration: '2m', target: 2000 },
      { duration: '1m', target: 500 },
      { duration: '30s', target: 0 },
    ],
  },
};

export const options = {
  scenarios: {
    default: scenarios[SCENARIO] || scenarios.baseline,
  },
  thresholds: {
    sms_throughput_per_sec: ['avg>20'], // Lower than email due to Telnyx limits
    sms_batch_latency: ['p(95)<120000'],
    sms_webhook_latency: ['p(95)<100'],
    sms_fail_rate: ['rate<0.05'],
  },
};

/**
 * Setup
 */
export function setup() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              SMS THROUGHPUT TEST                             ║
╠══════════════════════════════════════════════════════════════╣
║  Scenario:       ${SCENARIO.padEnd(41)}║
║  Batches:        ${BATCH_COUNT.toString().padEnd(41)}║
║  Recipients:     ${BATCH_SIZE.toString().padEnd(41)}║
║  Virtual Users:  ${VUS.toString().padEnd(41)}║
╠══════════════════════════════════════════════════════════════╣
║  SMS Rate Limit: ~50/sec (Telnyx)                            ║
║  Expected Time:  ~${((BATCH_SIZE * BATCH_COUNT) / 50).toFixed(0).padEnd(35)}sec  ║
╚══════════════════════════════════════════════════════════════╝
`);

  const client = new TestClient({ testId: `sms-${SCENARIO}-${Date.now()}` });
  const ctx = client.setupTestUser(`sms-test`);

  // Create SMS send config
  try {
    const smsConfig = client.createSendConfig({
      name: 'SMS Test Config',
      module: 'sms',
      moduleConfig: {
        provider: 'mock', // Use mock for testing
        fromNumber: '+15551234567',
      },
      rateLimit: { perSecond: 50 },
    });
    ctx.smsSendConfigId = smsConfig.id;
    console.log(`Created SMS send config: ${smsConfig.id}`);
  } catch (error) {
    console.warn(`Could not create SMS config: ${error.message}`);
  }

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
export default function (data) {
  switch (data.scenario) {
    case 'baseline':
    case 'high_volume':
      runSmsBaseline(data);
      break;
    case 'mixed':
      runMixedLoad(data);
      break;
    case 'webhook_flood':
      runWebhookFlood(data);
      break;
    default:
      runSmsBaseline(data);
  }
}

/**
 * Baseline SMS test
 */
function runSmsBaseline(data) {
  const client = TestClient.fromContext(data);
  const batchIndex = __ITER;

  console.log(`VU ${__VU}: SMS batch ${batchIndex + 1}/${Math.ceil(data.batchCount / VUS)}`);

  const startTime = Date.now();

  try {
    // Generate SMS recipients (phone numbers)
    const recipients = [];
    for (let i = 0; i < data.batchSize; i++) {
      recipients.push({
        phone: `+1555${String(Date.now()).slice(-7)}${i.toString().padStart(3, '0')}`,
        name: `Test User ${i}`,
        variables: {
          code: Math.random().toString(36).slice(2, 8).toUpperCase(),
        },
      });
    }

    const batch = client.createBatch({
      name: `sms-batch-${batchIndex + 1}`,
      recipients: recipients,
      module: 'sms',
      message: 'Your verification code is {{code}}',
      sendConfigId: data.smsSendConfigId,
      dryRun: true,
    });

    client.sendBatch(batch.id);

    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 180, // SMS is slower
      pollIntervalSeconds: 3,
      silent: true,
    });

    const duration = Date.now() - startTime;
    smsLatency.add(duration);

    if (result && result.status === 'completed') {
      smsFailRate.add(false);
      smsBatchesCompleted.add(1);
      const throughput = data.batchSize / (duration / 1000);
      smsThroughput.add(throughput);
      console.log(`VU ${__VU}: SMS batch completed: ${duration}ms (${throughput.toFixed(1)}/sec)`);
    } else {
      smsFailRate.add(true);
      smsBatchesFailed.add(1);
    }

  } catch (error) {
    smsFailRate.add(true);
    smsBatchesFailed.add(1);
    console.error(`VU ${__VU}: Error - ${error.message}`);
  }

  sleep(2);
}

/**
 * Mixed SMS + Email load
 */
function runMixedLoad(data) {
  const client = TestClient.fromContext(data);
  const isSms = __VU % 2 === 0; // Even VUs do SMS, odd do Email

  console.log(`VU ${__VU}: ${isSms ? 'SMS' : 'Email'} batch`);

  const startTime = Date.now();

  try {
    let batch;

    if (isSms) {
      const recipients = [];
      for (let i = 0; i < data.batchSize; i++) {
        recipients.push({
          phone: `+1555${String(Date.now()).slice(-7)}${i.toString().padStart(3, '0')}`,
          name: `SMS User ${i}`,
        });
      }

      batch = client.createBatch({
        name: `mixed-sms-vu${__VU}-${__ITER}`,
        recipients: recipients,
        module: 'sms',
        message: 'Mixed load test SMS',
        sendConfigId: data.smsSendConfigId,
        dryRun: true,
      });
    } else {
      batch = client.createBatch({
        name: `mixed-email-vu${__VU}-${__ITER}`,
        recipientCount: data.batchSize,
        subject: 'Mixed Load Test Email',
        dryRun: true,
      });
    }

    client.sendBatch(batch.id);

    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: 180,
      pollIntervalSeconds: 3,
      silent: true,
    });

    const duration = Date.now() - startTime;

    if (result && result.status === 'completed') {
      if (isSms) {
        smsBatchesCompleted.add(1);
        smsLatency.add(duration);
        smsThroughput.add(data.batchSize / (duration / 1000));
      } else {
        emailBatchesCompleted.add(1);
      }
      smsFailRate.add(false);
    } else {
      smsFailRate.add(true);
      if (isSms) smsBatchesFailed.add(1);
    }

  } catch (error) {
    smsFailRate.add(true);
    console.error(`VU ${__VU}: Error - ${error.message}`);
  }

  sleep(1);
}

/**
 * Webhook flood test (simulates Telnyx delivery reports)
 */
function runWebhookFlood(data) {
  // Simulate Telnyx webhook payload
  const payload = JSON.stringify({
    data: {
      event_type: 'message.finalized',
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      occurred_at: new Date().toISOString(),
      payload: {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        to: [{
          phone_number: `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
          status: 'delivered',
        }],
        from: {
          phone_number: '+15551234567',
        },
        type: 'SMS',
        direction: 'outbound',
        cost: { amount: '0.0075', currency: 'USD' },
      },
    },
  });

  const headers = {
    'Content-Type': 'application/json',
    'Telnyx-Signature-ed25519': 'test-signature',
    'Telnyx-Timestamp': Date.now().toString(),
  };

  const start = Date.now();
  const response = http.post(`${WORKER_URL}/webhooks/telnyx`, payload, { headers });
  const duration = Date.now() - start;

  smsWebhookLatency.add(duration);

  const success = check(response, {
    'webhook: status 200': (r) => r.status === 200,
    'webhook: fast (<100ms)': () => duration < 100,
  });

  if (success) {
    smsWebhooksProcessed.add(1);
  }

  // Minimal delay for high throughput
  sleep(0.001);
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
  const smsCompleted = data.metrics.sms_batches_completed?.values?.count || 0;
  const smsFailed = data.metrics.sms_batches_failed?.values?.count || 0;
  const emailCompleted = data.metrics.email_batches_completed?.values?.count || 0;
  const webhooksProcessed = data.metrics.sms_webhooks_processed?.values?.count || 0;
  const avgThroughput = data.metrics.sms_throughput_per_sec?.values?.avg || 0;
  const p95Latency = data.metrics.sms_batch_latency?.values?.['p(95)'] || 0;
  const webhookP95 = data.metrics.sms_webhook_latency?.values?.['p(95)'] || 0;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              SMS THROUGHPUT RESULTS                          ║
╠══════════════════════════════════════════════════════════════╣
║  Scenario:       ${SCENARIO.padEnd(41)}║
║  SMS Completed:  ${smsCompleted.toString().padEnd(41)}║
║  SMS Failed:     ${smsFailed.toString().padEnd(41)}║
${SCENARIO === 'mixed' ? `║  Email Completed: ${emailCompleted.toString().padEnd(40)}║\n` : ''}${SCENARIO === 'webhook_flood' ? `║  Webhooks:       ${webhooksProcessed.toString().padEnd(41)}║\n║  Webhook p95:    ${webhookP95.toFixed(1).padEnd(38)} ms ║\n` : ''}║  Avg Throughput: ${avgThroughput.toFixed(1).padEnd(38)} /s ║
║  P95 Latency:    ${(p95Latency / 1000).toFixed(1).padEnd(39)} s ║
╚══════════════════════════════════════════════════════════════╝
`);

  return generateTestReport(data, {
    name: `SMS Throughput Test - ${SCENARIO}`,
    testType: 'sms',
    preset: SCENARIO,
    parameters: {
      scenario: SCENARIO,
      batchSize: BATCH_SIZE,
      batchCount: BATCH_COUNT,
      virtualUsers: VUS,
      expectedRateLimit: 50,
    },
    thresholds: {
      'throughput.average': { operator: '>=', value: 20 },
      'latency.p95': { operator: '<=', value: 120000 },
      'errors.rate': { operator: '<=', value: 0.05 },
    },
  });
}
