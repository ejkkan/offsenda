/**
 * k6 Load Test: Full Batch Flow
 *
 * Tests the complete batch lifecycle:
 * 1. Create batch
 * 2. Send batch (trigger processing)
 * 3. Poll until completion
 *
 * Usage:
 *   k6 run k6/batch-flow.js
 *   k6 run -e SCENARIO=load k6/batch-flow.js
 *   k6 run -e K6_BATCH_SIZE=1000 k6/batch-flow.js
 *
 * Environment variables:
 *   K6_API_URL        - Base API URL
 *   K6_API_KEY        - API key for authentication
 *   K6_BATCH_SIZE     - Recipients per batch (default: 100)
 *   K6_SEND_CONFIG_ID - Send config ID to use
 *   K6_MAX_POLL_TIME  - Max seconds to wait for completion (default: 300)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { config, getHeaders, generateRecipients, generateBatchName, scenarios } from './config.js';

// Custom metrics
const batchCreateDuration = new Trend('batch_create_duration', true);
const batchSendDuration = new Trend('batch_send_duration', true);
const batchCompletionDuration = new Trend('batch_completion_duration', true);
const batchThroughput = new Trend('batch_throughput_per_sec', true);
const batchesCompleted = new Counter('batches_completed');
const batchesFailed = new Counter('batches_failed');
const failRate = new Rate('batch_flow_fail_rate');

const maxPollTime = parseInt(__ENV.K6_MAX_POLL_TIME || '300');
const scenario = __ENV.SCENARIO || 'smoke';

export const options = {
  scenarios: {
    default: {
      executor: 'constant-vus',
      vus: scenario === 'load' ? 5 : 1,
      duration: scenario === 'load' ? '10m' : '2m',
    },
  },
  thresholds: {
    batch_create_duration: ['p(95)<5000'],
    batch_send_duration: ['p(95)<2000'],
    batch_completion_duration: ['p(95)<60000'], // 60s for batch to complete
    batch_flow_fail_rate: ['rate<0.10'],
  },
};

export default function () {
  const headers = getHeaders();
  const batchName = generateBatchName();
  const recipients = generateRecipients(config.batchSize);

  // ========================================
  // Step 1: Create Batch
  // ========================================
  const createPayload = JSON.stringify({
    name: batchName,
    subject: 'k6 Full Flow Test',
    fromEmail: 'loadtest@batchsender.com',
    fromName: 'k6 Load Test',
    htmlContent: '<h1>Load Test</h1><p>Hello {{firstName}}!</p>',
    textContent: 'Hello {{firstName}}!',
    recipients: recipients,
    ...(config.sendConfigId && { sendConfigId: config.sendConfigId }),
  });

  let createStart = Date.now();
  let createResponse = http.post(`${config.baseUrl}/api/batches`, createPayload, { headers });
  batchCreateDuration.add(Date.now() - createStart);

  let createSuccess = check(createResponse, {
    'create: status 200/201': (r) => r.status === 200 || r.status === 201,
    'create: has batch id': (r) => {
      try {
        return JSON.parse(r.body).id !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (!createSuccess) {
    console.log(`Create failed: ${createResponse.status} - ${createResponse.body}`);
    failRate.add(true);
    batchesFailed.add(1);
    return;
  }

  const batchId = JSON.parse(createResponse.body).id;
  console.log(`Created batch: ${batchId} (${recipients.length} recipients)`);

  // ========================================
  // Step 2: Send Batch (trigger processing)
  // ========================================
  let sendStart = Date.now();
  let sendResponse = http.post(`${config.baseUrl}/api/batches/${batchId}/send`, null, { headers });
  batchSendDuration.add(Date.now() - sendStart);

  let sendSuccess = check(sendResponse, {
    'send: status 200': (r) => r.status === 200,
  });

  if (!sendSuccess) {
    console.log(`Send failed: ${sendResponse.status} - ${sendResponse.body}`);
    failRate.add(true);
    batchesFailed.add(1);
    return;
  }

  console.log(`Batch ${batchId} sent, waiting for completion...`);

  // ========================================
  // Step 3: Poll for Completion
  // ========================================
  const pollStart = Date.now();
  const pollInterval = 2; // seconds
  let completed = false;
  let finalStatus = '';

  while ((Date.now() - pollStart) / 1000 < maxPollTime) {
    sleep(pollInterval);

    const statusResponse = http.get(`${config.baseUrl}/api/batches/${batchId}`, { headers });

    if (statusResponse.status !== 200) {
      console.log(`Status check failed: ${statusResponse.status}`);
      continue;
    }

    try {
      const batch = JSON.parse(statusResponse.body);
      finalStatus = batch.status;

      if (batch.status === 'completed' || batch.status === 'failed') {
        completed = true;
        const completionTime = Date.now() - pollStart;
        batchCompletionDuration.add(completionTime);

        // Calculate throughput
        const throughput = recipients.length / (completionTime / 1000);
        batchThroughput.add(throughput);

        console.log(`Batch ${batchId} ${batch.status} in ${completionTime}ms (${throughput.toFixed(1)}/sec)`);
        console.log(`  Sent: ${batch.sentCount}, Failed: ${batch.failedCount}`);
        break;
      }

      // Log progress
      const progress = ((batch.sentCount + batch.failedCount) / batch.totalRecipients * 100).toFixed(1);
      console.log(`Batch ${batchId}: ${progress}% (${batch.sentCount}/${batch.totalRecipients})`);

    } catch (e) {
      console.log(`Failed to parse status: ${e.message}`);
    }
  }

  // Record success/failure
  if (completed && finalStatus === 'completed') {
    failRate.add(false);
    batchesCompleted.add(1);
  } else {
    failRate.add(true);
    batchesFailed.add(1);
    console.log(`Batch ${batchId} did not complete in time (status: ${finalStatus})`);
  }

  // Brief pause before next iteration
  sleep(1);
}

export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    scenario: scenario,
    batchSize: config.batchSize,
    metrics: {
      batches_completed: data.metrics.batches_completed?.values?.count || 0,
      batches_failed: data.metrics.batches_failed?.values?.count || 0,
      avg_completion_time_ms: data.metrics.batch_completion_duration?.values?.avg || 0,
      p95_completion_time_ms: data.metrics.batch_completion_duration?.values['p(95)'] || 0,
      avg_throughput_per_sec: data.metrics.batch_throughput_per_sec?.values?.avg || 0,
    },
  };

  return {
    'k6/results/batch-flow-summary.json': JSON.stringify(summary, null, 2),
  };
}
