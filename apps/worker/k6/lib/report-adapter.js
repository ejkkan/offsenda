/**
 * k6 Report Adapter
 *
 * Transforms k6 summary data into the unified TestReport schema.
 * Use in handleSummary() to output standardized reports.
 *
 * Usage in k6 test:
 *   import { generateTestReport } from './lib/report-adapter.js';
 *
 *   export function handleSummary(data) {
 *     return generateTestReport(data, {
 *       name: 'Stress Test - 1M Recipients',
 *       testType: 'stress',
 *       preset: 'stress',
 *       parameters: {
 *         batches: 10,
 *         recipientsPerBatch: 100000,
 *         targetRps: 1000,
 *       },
 *       thresholds: {
 *         'throughput.average': { operator: '>=', value: 800 },
 *         'latency.p95': { operator: '<=', value: 500 },
 *         'errors.rate': { operator: '<=', value: 0.01 },
 *       },
 *     });
 *   }
 */

/**
 * Extract metric value from k6 data
 */
function getMetric(data, name, stat = 'avg') {
  const metric = data.metrics[name];
  if (!metric || !metric.values) return 0;
  return metric.values[stat] || 0;
}

/**
 * Generate a test report from k6 summary data
 *
 * @param {object} data - k6 summary data
 * @param {object} options - Report options
 * @param {string} options.name - Test name
 * @param {string} options.testType - Type of test (load/stress/etc)
 * @param {string} options.preset - Configuration preset used
 * @param {object} options.parameters - Test parameters
 * @param {object} options.thresholds - Threshold definitions
 * @param {object} options.prometheusMetrics - Optional real metrics from Prometheus
 */
export function generateTestReport(data, options) {
  const {
    name,
    testType = 'load',
    preset,
    parameters = {},
    thresholds: thresholdDefs = {},
    prometheusMetrics = null,
  } = options;

  const now = new Date().toISOString();
  const date = now.split('T')[0];
  const time = now.split('T')[1].slice(0, 5).replace(':', '');
  const random = Math.random().toString(36).slice(2, 6);
  const runId = `${testType}-${date}-${time}-${random}`;

  // Helper to calculate accuracy delta percentage
  function calculateAccuracyDelta(calculated, actual) {
    if (!actual || actual === 0) return null;
    const delta = ((calculated - actual) / actual) * 100;
    return Math.round(delta * 100) / 100; // Round to 2 decimal places
  }

  // Extract metrics from k6 data
  const metrics = {
    type: 'load',
    throughput: {
      peak: getMetric(data, 'batch_throughput_per_sec', 'max') || getMetric(data, 'http_reqs', 'rate'),
      average: getMetric(data, 'batch_throughput_per_sec', 'avg') || getMetric(data, 'http_reqs', 'rate'),
      target: parameters.targetRps || 100,
      unit: 'rps',
    },
    latency: {
      p50: getMetric(data, 'batch_completion_duration', 'med') || getMetric(data, 'http_req_duration', 'med'),
      p95: getMetric(data, 'batch_completion_duration', 'p(95)') || getMetric(data, 'http_req_duration', 'p(95)'),
      p99: getMetric(data, 'batch_completion_duration', 'p(99)') || getMetric(data, 'http_req_duration', 'p(99)'),
      max: getMetric(data, 'batch_completion_duration', 'max') || getMetric(data, 'http_req_duration', 'max'),
    },
    errors: {
      total: getMetric(data, 'batches_failed', 'count') || 0,
      rate: getMetric(data, 'batch_create_fail_rate', 'rate') || 0,
      byType: {},
    },
    resources: {
      cpuPeakPercent: 0, // Would need external metrics
      memoryPeakMb: 0,   // Would need external metrics
      podScaleEvents: 0, // Would need external metrics
    },
    batches: {
      total: (getMetric(data, 'batches_completed', 'count') || 0) + (getMetric(data, 'batches_failed', 'count') || 0),
      completed: getMetric(data, 'batches_completed', 'count') || 0,
      failed: getMetric(data, 'batches_failed', 'count') || 0,
      avgCompletionTimeMs: getMetric(data, 'batch_completion_duration', 'avg') || 0,
    },
    // Actual vs Calculated comparison (when Prometheus metrics available)
    accuracy: prometheusMetrics ? {
      k6CalculatedThroughput: getMetric(data, 'batch_throughput_per_sec', 'avg') || getMetric(data, 'http_reqs', 'rate'),
      actualThroughput: prometheusMetrics.realThroughput || prometheusMetrics.emailsSentRate1m || 0,
      emailsSentDelta: prometheusMetrics.emailsSentDelta || 0,
      prometheusAvailable: prometheusMetrics.prometheusAvailable || false,
      accuracyDelta: calculateAccuracyDelta(
        getMetric(data, 'batch_throughput_per_sec', 'avg') || getMetric(data, 'http_reqs', 'rate'),
        prometheusMetrics.realThroughput || prometheusMetrics.emailsSentRate1m || 0
      ),
    } : null,
  };

  // Evaluate thresholds
  const evaluatedThresholds = [];
  for (const [metricPath, def] of Object.entries(thresholdDefs)) {
    const actual = getNestedValue(metrics, metricPath);
    const passed = evaluateThreshold(def.operator, actual, def.value);
    evaluatedThresholds.push({
      metric: metricPath,
      operator: def.operator,
      value: def.value,
      actual,
      passed,
    });
  }

  // Auto-detect issues
  const issues = [];
  if (metrics.errors.rate > 0.01) {
    issues.push({
      severity: metrics.errors.rate > 0.05 ? 'critical' : 'high',
      category: 'reliability',
      title: 'Elevated error rate',
      description: `Error rate of ${(metrics.errors.rate * 100).toFixed(2)}% exceeds acceptable threshold`,
      evidence: `Total errors: ${metrics.errors.total}`,
      recommendation: 'Check worker logs for error patterns',
    });
  }

  if (metrics.latency.p95 > 1000) {
    issues.push({
      severity: metrics.latency.p95 > 5000 ? 'high' : 'medium',
      category: 'performance',
      title: 'High p95 latency',
      description: `P95 latency of ${metrics.latency.p95}ms may impact user experience`,
      evidence: `p50: ${metrics.latency.p50}ms, p95: ${metrics.latency.p95}ms`,
      recommendation: 'Profile hot paths and consider scaling',
    });
  }

  // Check accuracy delta (k6 vs Prometheus throughput)
  if (metrics.accuracy && metrics.accuracy.accuracyDelta !== null) {
    const absDelta = Math.abs(metrics.accuracy.accuracyDelta);
    if (absDelta > 50) {
      issues.push({
        severity: 'medium',
        category: 'measurement',
        title: 'Large throughput measurement discrepancy',
        description: `k6 calculated throughput differs from Prometheus by ${metrics.accuracy.accuracyDelta.toFixed(1)}%`,
        evidence: `k6: ${metrics.accuracy.k6CalculatedThroughput.toFixed(1)}/sec, Prometheus: ${metrics.accuracy.actualThroughput.toFixed(1)}/sec`,
        recommendation: 'k6 throughput includes polling overhead - use Prometheus metrics for accurate reporting',
      });
    }
  }

  // Determine status
  const allThresholdsPassed = evaluatedThresholds.every((t) => t.passed);
  const hasCriticalIssues = issues.some((i) => i.severity === 'critical');
  const hasHighIssues = issues.some((i) => i.severity === 'high');

  let status;
  if (hasCriticalIssues || !allThresholdsPassed) {
    status = 'failed';
  } else if (hasHighIssues) {
    status = 'degraded';
  } else {
    status = 'passed';
  }

  // Generate narrative
  const narrative = generateNarrative(name, status, metrics, issues, evaluatedThresholds);

  // Build report
  const report = {
    schemaVersion: '1.0',
    runId,
    testType,
    name,
    status,
    startedAt: new Date(Date.now() - (data.state?.testRunDurationMs || 0)).toISOString(),
    completedAt: now,
    durationMs: data.state?.testRunDurationMs || 0,
    environment: {
      gitCommit: __ENV.GIT_COMMIT || 'unknown',
      gitBranch: __ENV.GIT_BRANCH || 'unknown',
      environment: __ENV.TEST_ENV || 'local',
      infrastructure: {
        workerPods: parseInt(__ENV.WORKER_PODS || '1', 10),
        dragonflyMemoryMb: parseInt(__ENV.DRAGONFLY_MEMORY_MB || '900', 10),
        natsNodes: parseInt(__ENV.NATS_NODES || '1', 10),
        provider: __ENV.EMAIL_PROVIDER || 'mock',
      },
    },
    configuration: {
      preset,
      parameters,
      thresholds: evaluatedThresholds,
    },
    summary: {
      total: evaluatedThresholds.length,
      passed: evaluatedThresholds.filter((t) => t.passed).length,
      failed: evaluatedThresholds.filter((t) => !t.passed).length,
      skipped: 0,
      passRate: evaluatedThresholds.length > 0
        ? (evaluatedThresholds.filter((t) => t.passed).length / evaluatedThresholds.length) * 100
        : 100,
      keyFindings: generateKeyFindings(status, metrics, issues, evaluatedThresholds),
    },
    metrics,
    issues,
    narrative,
  };

  // Return files to write
  // Paths are relative to where k6 is run (typically apps/worker/)
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    [`./test-reports/latest.json`]: JSON.stringify(report, null, 2),
    [`./test-reports/latest-${testType}.json`]: JSON.stringify(report, null, 2),
    [`./test-reports/history/${date}/${runId}.json`]: JSON.stringify(report, null, 2),
  };
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => (o || {})[k], obj) || 0;
}

function evaluateThreshold(operator, actual, target) {
  switch (operator) {
    case '<': return actual < target;
    case '<=': return actual <= target;
    case '>': return actual > target;
    case '>=': return actual >= target;
    case '==': return actual === target;
    case '!=': return actual !== target;
    default: return false;
  }
}

function generateNarrative(name, status, metrics, issues, thresholds) {
  const lines = [];
  lines.push(`## ${name} - ${status.toUpperCase()}`);
  lines.push('');
  lines.push(`**Throughput**: Peak ${metrics.throughput.peak.toFixed(1)} ${metrics.throughput.unit}, Average ${metrics.throughput.average.toFixed(1)} ${metrics.throughput.unit}`);
  lines.push(`**Latency**: p50=${metrics.latency.p50.toFixed(0)}ms, p95=${metrics.latency.p95.toFixed(0)}ms, p99=${metrics.latency.p99.toFixed(0)}ms`);
  lines.push(`**Errors**: ${metrics.errors.total} total (${(metrics.errors.rate * 100).toFixed(3)}% rate)`);

  if (metrics.batches) {
    lines.push(`**Batches**: ${metrics.batches.completed}/${metrics.batches.total} completed`);
  }

  // Add accuracy comparison if Prometheus metrics available
  if (metrics.accuracy && metrics.accuracy.prometheusAvailable) {
    lines.push('');
    lines.push('### Throughput Accuracy (k6 vs Prometheus)');
    lines.push(`- k6 Calculated: ${metrics.accuracy.k6CalculatedThroughput.toFixed(1)}/sec`);
    lines.push(`- Prometheus Actual: ${metrics.accuracy.actualThroughput.toFixed(1)}/sec`);
    lines.push(`- Delta: ${metrics.accuracy.accuracyDelta?.toFixed(1) || 'N/A'}%`);
    lines.push(`- Emails Sent: ${metrics.accuracy.emailsSentDelta}`);
  }

  if (issues.length > 0) {
    lines.push('');
    lines.push(`### Issues (${issues.length})`);
    issues.forEach((i) => lines.push(`- [${i.severity.toUpperCase()}] ${i.title}`));
  }

  const failed = thresholds.filter((t) => !t.passed);
  if (failed.length > 0) {
    lines.push('');
    lines.push(`### Failed Thresholds (${failed.length})`);
    failed.forEach((t) => lines.push(`- ${t.metric}: expected ${t.operator} ${t.value}, got ${t.actual.toFixed(2)}`));
  }

  return lines.join('\n');
}

function generateKeyFindings(status, metrics, issues, thresholds) {
  const findings = [];

  if (status === 'passed') {
    findings.push('All thresholds met successfully');
  } else {
    const failedCount = thresholds.filter((t) => !t.passed).length;
    if (failedCount > 0) findings.push(`${failedCount} threshold(s) failed`);
  }

  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  if (criticalCount > 0) findings.push(`${criticalCount} critical issue(s) require attention`);

  if (metrics.batches && metrics.batches.completed > 0) {
    findings.push(`Processed ${metrics.batches.completed} batches successfully`);
  }

  return findings.slice(0, 3);
}

// Stub for k6's textSummary (import from k6-summary in real usage)
function textSummary(data, options) {
  return JSON.stringify(data.metrics, null, 2);
}
