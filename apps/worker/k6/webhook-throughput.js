/**
 * k6 Load Test: Webhook Throughput
 *
 * Tests the worker's webhook endpoint that receives provider callbacks
 * (delivery confirmations, bounces, etc.)
 *
 * This tests the hot path: webhook → ClickHouse → status update
 *
 * Usage:
 *   k6 run k6/webhook-throughput.js
 *   k6 run -e SCENARIO=stress k6/webhook-throughput.js
 *   k6 run -e K6_WORKER_URL=http://worker:6001 k6/webhook-throughput.js
 *
 * Environment variables:
 *   K6_WORKER_URL    - Worker API URL (default: http://localhost:6001)
 *   K6_WEBHOOK_SECRET - Webhook secret for signature
 *   SCENARIO         - Test scenario (smoke, load, stress, spike)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { scenarios, thresholds } from './config.js';
import crypto from 'k6/crypto';

const workerUrl = __ENV.K6_WORKER_URL || 'http://localhost:6001';
const webhookSecret = __ENV.K6_WEBHOOK_SECRET || 'test-webhook-secret';
const scenario = __ENV.SCENARIO || 'smoke';

// Custom metrics
const webhookDuration = new Trend('webhook_duration', true);
const webhookFailRate = new Rate('webhook_fail_rate');
const webhooksProcessed = new Counter('webhooks_processed');

// Select scenario
const selectedScenario = scenarios[scenario] || scenarios.smoke;
const selectedThresholds = thresholds[scenario] || thresholds.smoke;

export const options = {
  scenarios: {
    default: selectedScenario,
  },
  thresholds: {
    ...selectedThresholds,
    webhook_duration: ['p(95)<100', 'p(99)<500'], // Webhooks should be fast
    webhook_fail_rate: ['rate<0.01'],
  },
};

// Generate webhook event types
const eventTypes = ['delivered', 'bounced', 'complained', 'opened', 'clicked'];

function generateWebhookPayload() {
  const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
  const timestamp = new Date().toISOString();
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // Simulate different provider webhook formats
  return {
    // Generic webhook format
    event: eventType,
    timestamp: timestamp,
    messageId: messageId,
    recipient: `user-${Math.floor(Math.random() * 10000)}@example.com`,
    metadata: {
      batchId: `batch-${Math.floor(Math.random() * 100)}`,
      recipientId: `recipient-${Math.floor(Math.random() * 10000)}`,
    },
    // SES-style nested data
    mail: {
      messageId: messageId,
      timestamp: timestamp,
    },
    // Resend-style data
    data: {
      email_id: messageId,
      created_at: timestamp,
      to: [`user-${Math.floor(Math.random() * 10000)}@example.com`],
    },
  };
}

function generateSignature(payload, secret) {
  // Simple HMAC signature (adjust based on your actual webhook signature scheme)
  const payloadString = JSON.stringify(payload);
  return crypto.hmac('sha256', secret, payloadString, 'hex');
}

export default function () {
  const payload = generateWebhookPayload();
  const payloadString = JSON.stringify(payload);
  const signature = generateSignature(payload, webhookSecret);

  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Signature': signature,
    'X-Webhook-Timestamp': Date.now().toString(),
  };

  const startTime = Date.now();
  const response = http.post(`${workerUrl}/webhooks/provider`, payloadString, { headers });
  const duration = Date.now() - startTime;

  webhookDuration.add(duration);

  const success = check(response, {
    'webhook: status 200': (r) => r.status === 200,
    'webhook: response time < 100ms': () => duration < 100,
  });

  webhookFailRate.add(!success);

  if (success) {
    webhooksProcessed.add(1);
  } else {
    console.log(`Webhook failed: ${response.status} - ${response.body}`);
  }

  // Minimal sleep for high-throughput testing
  sleep(0.01); // 10ms between requests per VU
}

export function handleSummary(data) {
  const totalWebhooks = data.metrics.webhooks_processed?.values?.count || 0;
  const duration = data.state?.testRunDurationMs || 1;
  const rps = (totalWebhooks / (duration / 1000)).toFixed(2);

  console.log(`\n========================================`);
  console.log(`  Webhook Throughput Results`);
  console.log(`========================================`);
  console.log(`  Total webhooks: ${totalWebhooks}`);
  console.log(`  Requests/sec: ${rps}`);
  console.log(`  p95 latency: ${(data.metrics.webhook_duration?.values['p(95)'] || 0).toFixed(2)}ms`);
  console.log(`  p99 latency: ${(data.metrics.webhook_duration?.values['p(99)'] || 0).toFixed(2)}ms`);
  console.log(`  Fail rate: ${((data.metrics.webhook_fail_rate?.values?.rate || 0) * 100).toFixed(2)}%`);
  console.log(`========================================\n`);

  return {
    'k6/results/webhook-throughput-summary.json': JSON.stringify({
      timestamp: new Date().toISOString(),
      scenario: scenario,
      total_webhooks: totalWebhooks,
      requests_per_second: parseFloat(rps),
      p95_latency_ms: data.metrics.webhook_duration?.values['p(95)'] || 0,
      p99_latency_ms: data.metrics.webhook_duration?.values['p(99)'] || 0,
      fail_rate: data.metrics.webhook_fail_rate?.values?.rate || 0,
    }, null, 2),
  };
}
