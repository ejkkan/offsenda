/**
 * k6 Load Test: Batch Creation
 *
 * Tests the batch creation API endpoint under load.
 *
 * Usage:
 *   k6 run k6/batch-create.js                           # Smoke test (default)
 *   k6 run -e SCENARIO=load k6/batch-create.js          # Load test
 *   k6 run -e SCENARIO=stress k6/batch-create.js        # Stress test
 *   k6 run -e SCENARIO=spike k6/batch-create.js         # Spike test
 *
 * Environment variables:
 *   K6_API_URL        - Base API URL
 *   K6_API_KEY        - API key for authentication
 *   K6_BATCH_SIZE     - Recipients per batch (default: 100)
 *   K6_SEND_CONFIG_ID - Send config ID to use
 *   SCENARIO          - Test scenario (smoke, load, stress, spike)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { config, getHeaders, generateRecipients, generateBatchName, thresholds, scenarios } from './config.js';

// Custom metrics
const batchCreateDuration = new Trend('batch_create_duration', true);
const batchCreateFailRate = new Rate('batch_create_fail_rate');

// Select scenario based on environment variable
const scenario = __ENV.SCENARIO || 'smoke';
const selectedScenario = scenarios[scenario] || scenarios.smoke;
const selectedThresholds = thresholds[scenario] || thresholds.smoke;

export const options = {
  scenarios: {
    default: selectedScenario,
  },
  thresholds: {
    ...selectedThresholds,
    batch_create_duration: ['p(95)<5000'], // Custom: batch creation under 5s
    batch_create_fail_rate: ['rate<0.05'],  // Custom: less than 5% failure
  },
};

export default function () {
  const url = `${config.baseUrl}/api/batches`;
  const headers = getHeaders();

  // Generate batch payload
  const payload = JSON.stringify({
    name: generateBatchName(),
    subject: 'k6 Load Test Email',
    fromEmail: 'loadtest@batchsender.com',
    fromName: 'k6 Load Test',
    htmlContent: '<h1>Load Test</h1><p>Hello {{firstName}}, this is a load test email.</p>',
    textContent: 'Hello {{firstName}}, this is a load test email.',
    recipients: generateRecipients(config.batchSize),
    ...(config.sendConfigId && { sendConfigId: config.sendConfigId }),
  });

  const startTime = Date.now();
  const response = http.post(url, payload, { headers });
  const duration = Date.now() - startTime;

  // Record metrics
  batchCreateDuration.add(duration);

  // Validate response
  const success = check(response, {
    'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    'response has batch id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.id !== undefined;
      } catch {
        return false;
      }
    },
    'response time < 5s': () => duration < 5000,
  });

  batchCreateFailRate.add(!success);

  if (!success) {
    console.log(`Batch creation failed: ${response.status} - ${response.body}`);
  }

  // Think time between requests (1-3 seconds)
  sleep(Math.random() * 2 + 1);
}

export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'k6/results/batch-create-summary.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data, options) {
  // k6 will use its built-in text summary
  return '';
}
