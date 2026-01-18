/**
 * k6 Stress Test: Combined Production Load
 *
 * Simulates realistic production load with multiple concurrent operations:
 * - Users creating batches
 * - Batches being processed
 * - Webhooks arriving
 * - Status checks
 *
 * This test finds the breaking point of the system.
 *
 * Usage:
 *   k6 run k6/stress-test.js
 *   k6 run -e TARGET_RPS=1000 k6/stress-test.js
 *
 * Environment variables:
 *   K6_API_URL        - Web API URL (default: http://localhost:3000)
 *   K6_WORKER_URL     - Worker API URL (default: http://localhost:6001)
 *   K6_API_KEY        - API key for authentication
 *   K6_SEND_CONFIG_ID - Send config ID to use
 *   TARGET_RPS        - Target requests per second (default: 100)
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { config, getHeaders, generateRecipients, generateBatchName } from './config.js';

const workerUrl = __ENV.K6_WORKER_URL || 'http://localhost:6001';
const targetRps = parseInt(__ENV.TARGET_RPS || '100');

// Custom metrics
const overallFailRate = new Rate('overall_fail_rate');
const batchCreateRate = new Counter('batch_creates');
const statusCheckRate = new Counter('status_checks');
const webhookRate = new Counter('webhook_calls');

// Operation latencies
const batchCreateLatency = new Trend('batch_create_latency', true);
const statusCheckLatency = new Trend('status_check_latency', true);
const webhookLatency = new Trend('webhook_latency', true);

export const options = {
  scenarios: {
    // Batch creation - lower rate, larger payloads
    batch_creators: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { duration: '2m', target: 5 },    // Warm up: 5 batches/sec
        { duration: '5m', target: 10 },   // Normal: 10 batches/sec
        { duration: '5m', target: 20 },   // Stress: 20 batches/sec
        { duration: '3m', target: 50 },   // Breaking point: 50 batches/sec
        { duration: '2m', target: 10 },   // Recovery
        { duration: '1m', target: 0 },    // Cool down
      ],
      exec: 'createBatch',
    },

    // Status checks - higher rate, smaller payloads
    status_checkers: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 500,
      stages: [
        { duration: '2m', target: 50 },   // Warm up
        { duration: '5m', target: 100 },  // Normal
        { duration: '5m', target: 200 },  // Stress
        { duration: '3m', target: 500 },  // Breaking point
        { duration: '2m', target: 100 },  // Recovery
        { duration: '1m', target: 0 },    // Cool down
      ],
      exec: 'checkStatus',
    },

    // Webhook processing - highest rate
    webhook_processors: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: [
        { duration: '2m', target: 500 },   // Warm up
        { duration: '5m', target: 1000 },  // Normal
        { duration: '5m', target: 2000 },  // Stress
        { duration: '3m', target: 5000 },  // Breaking point
        { duration: '2m', target: 1000 },  // Recovery
        { duration: '1m', target: 0 },     // Cool down
      ],
      exec: 'processWebhook',
    },
  },

  thresholds: {
    // Overall
    overall_fail_rate: ['rate<0.10'], // 10% max failure

    // Batch creation (slower, more tolerance)
    batch_create_latency: ['p(95)<10000'], // 10s

    // Status checks (should be fast)
    status_check_latency: ['p(95)<2000'], // 2s

    // Webhooks (must be very fast)
    webhook_latency: ['p(95)<200', 'p(99)<1000'], // 200ms p95, 1s p99
  },
};

// Shared state for batch IDs (for status checks)
const batchIds = [];

export function createBatch() {
  const headers = getHeaders();
  const batchSize = Math.floor(Math.random() * 100) + 10; // 10-110 recipients

  const payload = JSON.stringify({
    name: generateBatchName('stress'),
    subject: 'k6 Stress Test',
    fromEmail: 'stress-test@batchsender.com',
    fromName: 'Stress Test',
    htmlContent: '<p>Stress test email</p>',
    recipients: generateRecipients(batchSize, 'stress'),
    ...(config.sendConfigId && { sendConfigId: config.sendConfigId }),
  });

  const start = Date.now();
  const response = http.post(`${config.baseUrl}/api/batches`, payload, { headers });
  batchCreateLatency.add(Date.now() - start);
  batchCreateRate.add(1);

  const success = check(response, {
    'batch: status 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  overallFailRate.add(!success);

  if (success) {
    try {
      const body = JSON.parse(response.body);
      if (body.id && batchIds.length < 1000) {
        batchIds.push(body.id);
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
}

export function checkStatus() {
  if (batchIds.length === 0) {
    sleep(0.1);
    return;
  }

  const headers = getHeaders();
  const batchId = batchIds[Math.floor(Math.random() * batchIds.length)];

  const start = Date.now();
  const response = http.get(`${config.baseUrl}/api/batches/${batchId}`, { headers });
  statusCheckLatency.add(Date.now() - start);
  statusCheckRate.add(1);

  const success = check(response, {
    'status: status 200': (r) => r.status === 200,
  });

  overallFailRate.add(!success);
}

export function processWebhook() {
  const payload = JSON.stringify({
    event: 'delivered',
    messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    recipient: `user${Math.floor(Math.random() * 10000)}@example.com`,
  });

  const start = Date.now();
  const response = http.post(`${workerUrl}/webhooks/provider`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': 'test-signature',
    },
  });
  webhookLatency.add(Date.now() - start);
  webhookRate.add(1);

  const success = check(response, {
    'webhook: status 200': (r) => r.status === 200,
  });

  overallFailRate.add(!success);
}

export function handleSummary(data) {
  const totalOps =
    (data.metrics.batch_creates?.values?.count || 0) +
    (data.metrics.status_checks?.values?.count || 0) +
    (data.metrics.webhook_calls?.values?.count || 0);

  const duration = data.state?.testRunDurationMs || 1;
  const opsPerSec = (totalOps / (duration / 1000)).toFixed(2);

  console.log(`\n========================================`);
  console.log(`  Stress Test Results`);
  console.log(`========================================`);
  console.log(`  Total operations: ${totalOps.toLocaleString()}`);
  console.log(`  Operations/sec: ${opsPerSec}`);
  console.log(`  Duration: ${(duration / 1000 / 60).toFixed(1)} minutes`);
  console.log(`----------------------------------------`);
  console.log(`  Batch creates: ${data.metrics.batch_creates?.values?.count || 0}`);
  console.log(`  Status checks: ${data.metrics.status_checks?.values?.count || 0}`);
  console.log(`  Webhooks: ${data.metrics.webhook_calls?.values?.count || 0}`);
  console.log(`----------------------------------------`);
  console.log(`  Batch p95: ${(data.metrics.batch_create_latency?.values['p(95)'] || 0).toFixed(0)}ms`);
  console.log(`  Status p95: ${(data.metrics.status_check_latency?.values['p(95)'] || 0).toFixed(0)}ms`);
  console.log(`  Webhook p95: ${(data.metrics.webhook_latency?.values['p(95)'] || 0).toFixed(0)}ms`);
  console.log(`----------------------------------------`);
  console.log(`  Fail rate: ${((data.metrics.overall_fail_rate?.values?.rate || 0) * 100).toFixed(2)}%`);
  console.log(`========================================\n`);

  return {
    'k6/results/stress-test-summary.json': JSON.stringify({
      timestamp: new Date().toISOString(),
      duration_minutes: duration / 1000 / 60,
      total_operations: totalOps,
      operations_per_second: parseFloat(opsPerSec),
      batches_created: data.metrics.batch_creates?.values?.count || 0,
      status_checks: data.metrics.status_checks?.values?.count || 0,
      webhooks_processed: data.metrics.webhook_calls?.values?.count || 0,
      latency: {
        batch_p95_ms: data.metrics.batch_create_latency?.values['p(95)'] || 0,
        status_p95_ms: data.metrics.status_check_latency?.values['p(95)'] || 0,
        webhook_p95_ms: data.metrics.webhook_latency?.values['p(95)'] || 0,
      },
      fail_rate: data.metrics.overall_fail_rate?.values?.rate || 0,
    }, null, 2),
  };
}
