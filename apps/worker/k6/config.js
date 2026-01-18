/**
 * k6 Load Test Configuration
 *
 * Environment variables:
 *   K6_API_URL      - Base API URL (default: http://localhost:3000)
 *   K6_API_KEY      - API key for authentication
 *   K6_BATCH_SIZE   - Recipients per batch (default: 100)
 */

export const config = {
  baseUrl: __ENV.K6_API_URL || 'http://localhost:3000',
  apiKey: __ENV.K6_API_KEY || '',
  batchSize: parseInt(__ENV.K6_BATCH_SIZE || '100'),
  sendConfigId: __ENV.K6_SEND_CONFIG_ID || '',
};

/**
 * Get authentication headers
 */
export function getHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  return headers;
}

/**
 * Generate test recipients
 */
export function generateRecipients(count, prefix = 'loadtest') {
  const recipients = [];
  const timestamp = Date.now();

  for (let i = 0; i < count; i++) {
    recipients.push({
      email: `${prefix}-${timestamp}-${i}@test.example.com`,
      name: `Test User ${i}`,
      variables: {
        firstName: `User${i}`,
        orderId: `ORD-${timestamp}-${i}`,
      },
    });
  }

  return recipients;
}

/**
 * Generate a unique batch name
 */
export function generateBatchName(prefix = 'k6-load-test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Standard thresholds for different test types
 */
export const thresholds = {
  // Smoke test - basic functionality
  smoke: {
    http_req_duration: ['p(95)<2000'], // 95% of requests under 2s
    http_req_failed: ['rate<0.01'],     // Less than 1% failure rate
  },

  // Load test - normal expected load
  load: {
    http_req_duration: ['p(95)<3000'],  // 95% under 3s
    http_req_failed: ['rate<0.05'],     // Less than 5% failure rate
  },

  // Stress test - beyond normal capacity
  stress: {
    http_req_duration: ['p(95)<10000'], // 95% under 10s (allowing degradation)
    http_req_failed: ['rate<0.10'],     // Less than 10% failure rate
  },

  // Spike test - sudden traffic surge
  spike: {
    http_req_duration: ['p(95)<5000'],  // 95% under 5s
    http_req_failed: ['rate<0.15'],     // Allow higher failure during spike
  },
};

/**
 * Standard scenarios
 */
export const scenarios = {
  // Smoke test - verify system works
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '1m',
  },

  // Load test - sustained normal load
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 10 },  // Ramp up to 10 users
      { duration: '5m', target: 10 },  // Stay at 10 users
      { duration: '2m', target: 0 },   // Ramp down
    ],
  },

  // Stress test - find breaking point
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 10 },   // Warm up
      { duration: '5m', target: 50 },   // Push to 50 users
      { duration: '5m', target: 100 },  // Push to 100 users
      { duration: '5m', target: 200 },  // Push to 200 users
      { duration: '2m', target: 0 },    // Recovery
    ],
  },

  // Spike test - sudden surge
  spike: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 10 },   // Normal load
      { duration: '10s', target: 100 }, // Spike!
      { duration: '2m', target: 100 },  // Stay at spike
      { duration: '10s', target: 10 },  // Back to normal
      { duration: '2m', target: 10 },   // Stay normal
      { duration: '1m', target: 0 },    // Ramp down
    ],
  },

  // Soak test - long duration for memory leaks
  soak: {
    executor: 'constant-vus',
    vus: 20,
    duration: '30m',
  },
};
