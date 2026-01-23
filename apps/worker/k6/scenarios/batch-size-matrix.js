/**
 * k6 Load Test: Batch Size Matrix
 *
 * Systematically tests different batch size patterns to reveal bottlenecks:
 * - Many small batches (job creation overhead)
 * - Few large batches (chunking, memory, sustained throughput)
 * - Mixed realistic distribution
 *
 * This helps answer: "What's the optimal batch size for our workload?"
 *
 * Matrix configurations:
 * - tiny:    10 recipients x 500 batches    (5,000 total)
 * - small:   100 recipients x 100 batches   (10,000 total)
 * - medium:  1,000 recipients x 50 batches  (50,000 total)
 * - large:   10,000 recipients x 10 batches (100,000 total)
 * - xlarge:  50,000 recipients x 5 batches  (250,000 total)
 * - mixed:   Realistic distribution mix
 *
 * Usage:
 *   k6 run k6/scenarios/batch-size-matrix.js
 *   k6 run -e PRESET=small k6/scenarios/batch-size-matrix.js
 *   k6 run -e PRESET=large k6/scenarios/batch-size-matrix.js
 *   k6 run -e PRESET=mixed k6/scenarios/batch-size-matrix.js
 *
 * Environment Variables:
 *   K6_API_URL          - API base URL
 *   K6_ADMIN_SECRET     - Admin secret for test setup
 *   PRESET              - Size preset (tiny, small, medium, large, xlarge, mixed, all)
 *   K6_VUS              - Virtual users (default: 5)
 */

import { sleep } from 'k6';
import { TestClient, metrics } from '../lib/client.js';
import { generateTestReport } from '../lib/report-adapter.js';
import { Counter, Trend, Rate } from 'k6/metrics';

// Configuration
const PRESET = __ENV.PRESET || 'small';
const VUS = parseInt(__ENV.K6_VUS || '5');

// Matrix definitions
const MATRIX = {
  tiny: {
    recipientCount: 10,
    batchCount: 500,
    description: 'Many tiny batches (job overhead test)',
  },
  small: {
    recipientCount: 100,
    batchCount: 100,
    description: 'Small batches (baseline)',
  },
  medium: {
    recipientCount: 1000,
    batchCount: 50,
    description: 'Medium batches',
  },
  large: {
    recipientCount: 10000,
    batchCount: 10,
    description: 'Large batches (chunking test)',
  },
  xlarge: {
    recipientCount: 50000,
    batchCount: 5,
    description: 'XL batches (memory/sustained test)',
  },
  mixed: {
    // Will be handled specially - mix of sizes
    recipientCount: 0,
    batchCount: 100,
    description: 'Realistic mix of sizes',
  },
};

// Mixed distribution (realistic production pattern)
const MIXED_DISTRIBUTION = [
  { size: 10, weight: 0.30 },     // 30% tiny batches
  { size: 100, weight: 0.35 },    // 35% small batches
  { size: 1000, weight: 0.25 },   // 25% medium batches
  { size: 10000, weight: 0.08 },  // 8% large batches
  { size: 50000, weight: 0.02 },  // 2% xlarge batches
];

// Get configuration for preset
const config = MATRIX[PRESET] || MATRIX.small;

// Custom metrics for size analysis
const batchSizeMetrics = {
  tiny: { latency: new Trend('tiny_batch_latency', true), count: new Counter('tiny_batch_count') },
  small: { latency: new Trend('small_batch_latency', true), count: new Counter('small_batch_count') },
  medium: { latency: new Trend('medium_batch_latency', true), count: new Counter('medium_batch_count') },
  large: { latency: new Trend('large_batch_latency', true), count: new Counter('large_batch_count') },
  xlarge: { latency: new Trend('xlarge_batch_latency', true), count: new Counter('xlarge_batch_count') },
};

const overallThroughput = new Trend('overall_throughput', true);
const jobCreationLatency = new Trend('job_creation_latency', true);
const chunkingLatency = new Trend('chunking_latency', true);
const completionLatency = new Trend('completion_latency', true);
const batchFailRate = new Rate('matrix_batch_fail_rate');
const recipientsPerSecond = new Trend('recipients_per_second', true);

export const options = {
  scenarios: {
    default: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: Math.ceil(config.batchCount / VUS),
      maxDuration: '60m',
    },
  },
  thresholds: {
    job_creation_latency: ['p(95)<5000'],
    completion_latency: ['p(95)<300000'], // 5 min for large batches
    matrix_batch_fail_rate: ['rate<0.05'],
    recipients_per_second: ['avg>100'],
  },
};

/**
 * Setup
 */
export function setup() {
  const totalRecipients = PRESET === 'mixed'
    ? estimateMixedRecipients(config.batchCount)
    : config.recipientCount * config.batchCount;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              BATCH SIZE MATRIX TEST                          ║
╠══════════════════════════════════════════════════════════════╣
║  Preset:         ${PRESET.padEnd(41)}║
║  Description:    ${config.description.padEnd(41).slice(0, 41)}║
║  Batches:        ${config.batchCount.toString().padEnd(41)}║
║  Recipients/Batch: ${(PRESET === 'mixed' ? 'varies' : config.recipientCount.toString()).padEnd(39)}║
║  Total Recipients: ~${totalRecipients.toLocaleString().padEnd(38)}║
║  Virtual Users:  ${VUS.toString().padEnd(41)}║
╚══════════════════════════════════════════════════════════════╝
`);

  const client = new TestClient({ testId: `matrix-${PRESET}-${Date.now()}` });
  const ctx = client.setupTestUser(`matrix-${PRESET}`);

  return {
    ...ctx,
    preset: PRESET,
    config: config,
    totalBatches: config.batchCount,
  };
}

/**
 * Main test function
 */
export default function (data) {
  const client = TestClient.fromContext(data);
  const batchIndex = (__VU - 1) * Math.ceil(data.totalBatches / VUS) + __ITER;

  if (batchIndex >= data.totalBatches) {
    return;
  }

  // Determine batch size
  let recipientCount;
  let sizeCategory;

  if (data.preset === 'mixed') {
    const result = selectMixedSize();
    recipientCount = result.size;
    sizeCategory = result.category;
  } else {
    recipientCount = data.config.recipientCount;
    sizeCategory = getSizeCategory(recipientCount);
  }

  console.log(`VU ${__VU}: Batch ${batchIndex + 1}/${data.totalBatches} (${recipientCount} recipients, ${sizeCategory})`);

  const startTime = Date.now();

  try {
    // Step 1: Create batch (measures job creation overhead)
    const createStart = Date.now();
    const batch = client.createBatch({
      name: `matrix-${data.preset}-batch-${batchIndex + 1}`,
      recipientCount: recipientCount,
      subject: `Matrix Test - ${sizeCategory}`,
      dryRun: true,
    });
    const createDuration = Date.now() - createStart;
    jobCreationLatency.add(createDuration);

    // For large batches, track chunking separately
    if (recipientCount > 5000) {
      chunkingLatency.add(createDuration);
    }

    // Step 2: Send batch
    client.sendBatch(batch.id);

    // Step 3: Wait for completion
    const maxWait = Math.max(60, recipientCount / 100); // At least 1 min, or 1 sec per 100 recipients
    const result = client.waitForCompletion(batch.id, {
      maxWaitSeconds: maxWait,
      pollIntervalSeconds: Math.min(5, maxWait / 10),
      silent: true,
    });

    const totalDuration = Date.now() - startTime;

    if (result && result.status === 'completed') {
      batchFailRate.add(false);

      // Record metrics by size category
      if (batchSizeMetrics[sizeCategory]) {
        batchSizeMetrics[sizeCategory].latency.add(totalDuration);
        batchSizeMetrics[sizeCategory].count.add(1);
      }

      completionLatency.add(totalDuration);

      const throughput = recipientCount / (totalDuration / 1000);
      overallThroughput.add(throughput);
      recipientsPerSecond.add(throughput);

      console.log(`VU ${__VU}: ${sizeCategory} batch completed: ${recipientCount} recipients in ${totalDuration}ms (${throughput.toFixed(1)}/sec)`);

    } else {
      batchFailRate.add(true);
      console.log(`VU ${__VU}: Batch failed or timed out`);
    }

  } catch (error) {
    batchFailRate.add(true);
    console.error(`VU ${__VU}: Error - ${error.message}`);
  }

  sleep(1);
}

/**
 * Select a size based on mixed distribution
 */
function selectMixedSize() {
  const rand = Math.random();
  let cumulative = 0;

  for (const { size, weight } of MIXED_DISTRIBUTION) {
    cumulative += weight;
    if (rand <= cumulative) {
      return {
        size: size,
        category: getSizeCategory(size),
      };
    }
  }

  // Default to small
  return { size: 100, category: 'small' };
}

/**
 * Get size category from recipient count
 */
function getSizeCategory(count) {
  if (count <= 50) return 'tiny';
  if (count <= 500) return 'small';
  if (count <= 5000) return 'medium';
  if (count <= 25000) return 'large';
  return 'xlarge';
}

/**
 * Estimate total recipients for mixed distribution
 */
function estimateMixedRecipients(batchCount) {
  let total = 0;
  for (const { size, weight } of MIXED_DISTRIBUTION) {
    total += size * weight * batchCount;
  }
  return Math.round(total);
}

/**
 * Teardown
 */
export function teardown(data) {
  const client = TestClient.fromContext(data);
  client.cleanup();
}

/**
 * Generate report with per-size breakdown
 */
export function handleSummary(data) {
  // Calculate per-size statistics
  const sizeStats = {};
  for (const [size, metricsObj] of Object.entries(batchSizeMetrics)) {
    const count = data.metrics[`${size}_batch_count`]?.values?.count || 0;
    const avgLatency = data.metrics[`${size}_batch_latency`]?.values?.avg || 0;
    const p95Latency = data.metrics[`${size}_batch_latency`]?.values?.['p(95)'] || 0;

    if (count > 0) {
      sizeStats[size] = {
        count,
        avgLatencyMs: avgLatency,
        p95LatencyMs: p95Latency,
      };
    }
  }

  const avgThroughput = data.metrics.recipients_per_second?.values?.avg || 0;
  const totalFailed = data.metrics.batches_failed?.values?.count || 0;
  const totalCompleted = data.metrics.batches_completed?.values?.count || 0;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              BATCH SIZE MATRIX RESULTS                       ║
╠══════════════════════════════════════════════════════════════╣
║  Preset:            ${PRESET.padEnd(38)}║
║  Batches Completed: ${totalCompleted.toString().padEnd(38)}║
║  Batches Failed:    ${totalFailed.toString().padEnd(38)}║
║  Avg Throughput:    ${avgThroughput.toFixed(1).padEnd(35)} /sec ║
╠══════════════════════════════════════════════════════════════╣
║  Per-Size Breakdown:                                         ║`);

  for (const [size, stats] of Object.entries(sizeStats)) {
    console.log(`║    ${size.padEnd(8)}: ${stats.count.toString().padStart(4)} batches, avg ${stats.avgLatencyMs.toFixed(0).padStart(6)}ms, p95 ${stats.p95LatencyMs.toFixed(0).padStart(6)}ms ║`);
  }

  console.log(`╚══════════════════════════════════════════════════════════════╝`);

  return generateTestReport(data, {
    name: `Batch Size Matrix - ${PRESET}`,
    testType: 'matrix',
    preset: PRESET,
    parameters: {
      preset: PRESET,
      description: config.description,
      recipientCount: config.recipientCount,
      batchCount: config.batchCount,
      virtualUsers: VUS,
      sizeDistribution: PRESET === 'mixed' ? MIXED_DISTRIBUTION : null,
    },
    thresholds: {
      'throughput.average': { operator: '>=', value: 100 },
      'latency.p95': { operator: '<=', value: 300000 },
      'errors.rate': { operator: '<=', value: 0.05 },
    },
  });
}
