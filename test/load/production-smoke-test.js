import http from 'k6/http';
import { check, sleep } from 'k6';

// Test configuration
export let options = {
  stages: [
    { duration: '1m', target: 10 },   // Ramp up to 10 virtual users
    { duration: '3m', target: 10 },   // Stay at 10 users for 3 minutes
    { duration: '1m', target: 0 },    // Ramp down to 0
  ],
  thresholds: {
    'http_req_duration': ['p(95)<500'],  // 95% of requests should be below 500ms
    'http_req_failed': ['rate<0.05'],    // Error rate should be below 5%
  },
};

// Base URL - change this to your actual API endpoint
const BASE_URL = __ENV.API_URL || 'http://localhost:6001';

export default function () {
  // Test health endpoint
  let healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health status is 200': (r) => r.status === 200,
    'health response contains status': (r) => r.json('status') !== undefined,
  });

  sleep(1);

  // Test metrics endpoint
  let metricsRes = http.get(`${BASE_URL}/api/metrics`);
  check(metricsRes, {
    'metrics status is 200': (r) => r.status === 200,
    'metrics response contains worker metrics': (r) => r.body.includes('worker_'),
  });

  sleep(2);
}

// Summary at the end
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function textSummary(data, options = {}) {
  const indent = options.indent || '';
  const enableColors = options.enableColors || false;

  let summary = '\n';
  summary += `${indent}✓ checks.........................: ${data.metrics.checks.values.rate * 100}% ✓ ${data.metrics.checks.values.passes} ✗ ${data.metrics.checks.values.fails}\n`;
  summary += `${indent}data_received..................: ${formatBytes(data.metrics.data_received.values.count)}\n`;
  summary += `${indent}data_sent......................: ${formatBytes(data.metrics.data_sent.values.count)}\n`;
  summary += `${indent}http_req_duration..............: avg=${data.metrics.http_req_duration.values.avg.toFixed(2)}ms min=${data.metrics.http_req_duration.values.min.toFixed(2)}ms med=${data.metrics.http_req_duration.values.med.toFixed(2)}ms max=${data.metrics.http_req_duration.values.max.toFixed(2)}ms p(90)=${data.metrics.http_req_duration.values['p(90)'].toFixed(2)}ms p(95)=${data.metrics.http_req_duration.values['p(95)'].toFixed(2)}ms\n`;
  summary += `${indent}http_req_failed................: ${data.metrics.http_req_failed.values.rate * 100}%\n`;
  summary += `${indent}http_reqs......................: ${data.metrics.http_reqs.values.count} ${(data.metrics.http_reqs.values.rate).toFixed(2)}/s\n`;
  summary += `${indent}vus............................: ${data.metrics.vus.values.value} (max=${data.metrics.vus_max.values.value})\n`;

  return summary;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
