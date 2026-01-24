#!/usr/bin/env npx tsx
/**
 * Load test: 100k dry run against production
 *
 * This script runs a load test batch and monitors progress. It uses server
 * timestamps for accurate throughput calculation. Optionally, if ADMIN_SECRET
 * is provided, it also queries the /api/metrics/summary endpoint to get
 * real-time Prometheus metrics for comparison.
 *
 * Usage: API_KEY=your_key npx tsx scripts/load-test-dry-run.ts
 *
 * Optional: ADMIN_SECRET=secret for Prometheus metrics comparison
 */

const API_URL = process.env.API_URL || "https://api.valuekeys.io";
const API_KEY = process.env.API_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "100000", 10);

if (!API_KEY) {
  console.error("Error: API_KEY environment variable required");
  console.error("Usage: API_KEY=your_key npx tsx scripts/load-test-dry-run.ts");
  process.exit(1);
}

interface MetricsSummary {
  emailsSentTotal: number;
  emailsSentRate1m: number;
  emailsSentRate5m: number;
  queueDepth: number;
  batchesInProgress: number;
  timestamp: string;
  source: "prometheus" | "local";
}

async function getMetricsSummary(): Promise<MetricsSummary | null> {
  if (!ADMIN_SECRET) return null;

  try {
    const response = await fetch(`${API_URL}/api/metrics/summary`, {
      headers: {
        "X-Admin-Secret": ADMIN_SECRET,
      },
    });

    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

function generateRecipients(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    email: `loadtest${i}@test.local`,
    name: `Load Test User ${i}`,
    variables: { index: String(i) },
  }));
}

async function createBatch() {
  console.log(`Creating batch with ${BATCH_SIZE.toLocaleString()} recipients (dry run)...`);

  const start = Date.now();
  const response = await fetch(`${API_URL}/api/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      name: `Load Test ${new Date().toISOString()}`,
      subject: "Load Test - Dry Run",
      fromEmail: "loadtest@batchsender.local",
      fromName: "Load Test",
      htmlContent: "<p>Hello {{name}}! This is load test email #{{index}}.</p>",
      textContent: "Hello {{name}}! This is load test email #{{index}}.",
      recipients: generateRecipients(BATCH_SIZE),
      dryRun: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create batch: ${response.status} ${error}`);
  }

  const batch = await response.json();
  console.log(`✓ Batch created in ${Date.now() - start}ms`);
  console.log(`  ID: ${batch.id}`);
  console.log(`  Recipients: ${batch.totalRecipients.toLocaleString()}`);
  return batch;
}

async function sendBatch(batchId: string) {
  console.log(`\nStarting batch...`);

  const response = await fetch(`${API_URL}/api/batches/${batchId}/send`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send batch: ${response.status} ${error}`);
  }

  console.log(`✓ Batch queued for processing`);
}

async function getBatchStatus(batchId: string) {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${API_KEY}`,
  };
  // Add admin secret to bypass rate limiting during stress tests
  if (ADMIN_SECRET) {
    headers["X-Admin-Secret"] = ADMIN_SECRET;
  }

  const response = await fetch(`${API_URL}/api/batches/${batchId}`, { headers });

  if (!response.ok) {
    throw new Error(`Failed to get batch: ${response.status}`);
  }

  return response.json();
}

async function monitorProgress(batchId: string, totalRecipients: number) {
  console.log(`\nMonitoring progress...`);
  if (ADMIN_SECRET) {
    console.log(`(Prometheus metrics available via ADMIN_SECRET)`);
  }
  console.log(`─────────────────────────────────────────`);

  const pollStart = Date.now();
  let lastSent = 0;
  let lastTime = pollStart;

  // Capture starting metrics for delta calculation
  const startMetrics = await getMetricsSummary();
  const startEmailsSent = startMetrics?.emailsSentTotal || 0;

  while (true) {
    const batch = await getBatchStatus(batchId);
    const now = Date.now();
    const pollElapsed = (now - pollStart) / 1000;
    const sentDelta = batch.sentCount - lastSent;
    const timeDelta = (now - lastTime) / 1000;
    const pct = ((batch.sentCount / totalRecipients) * 100).toFixed(1);

    const bar = "█".repeat(Math.floor(batch.sentCount / totalRecipients * 30)) +
                "░".repeat(30 - Math.floor(batch.sentCount / totalRecipients * 30));

    process.stdout.write(`\r[${bar}] ${pct}% | ${batch.sentCount.toLocaleString()}/${totalRecipients.toLocaleString()} | ${batch.status}  `);

    lastSent = batch.sentCount;
    lastTime = now;

    if (batch.status === "completed" || batch.status === "failed") {
      // Calculate ACTUAL throughput from batch timestamps (server-side truth)
      const startedAt = new Date(batch.startedAt).getTime();
      const completedAt = new Date(batch.completedAt).getTime();
      const actualProcessingTime = (completedAt - startedAt) / 1000;
      const actualThroughput = actualProcessingTime > 0 ? batch.sentCount / actualProcessingTime : 0;

      console.log(`\n─────────────────────────────────────────`);
      console.log(`\n✓ Batch ${batch.status}`);
      console.log(`  Processing time: ${actualProcessingTime.toFixed(2)}s (from server timestamps)`);
      console.log(`  Throughput: ${actualThroughput.toFixed(2)} emails/sec`);
      console.log(`  Sent: ${batch.sentCount.toLocaleString()}`);
      console.log(`  Failed: ${batch.failedCount.toLocaleString()}`);
      console.log(`  Wall clock time: ${pollElapsed.toFixed(2)}s (includes polling overhead)`);

      // If Prometheus metrics available, show comparison
      const endMetrics = await getMetricsSummary();
      if (endMetrics && startMetrics) {
        const emailsDelta = endMetrics.emailsSentTotal - startEmailsSent;
        console.log(`\n─── Prometheus Metrics ───`);
        console.log(`  Prometheus source: ${endMetrics.source}`);
        console.log(`  Prometheus rate (1m): ${endMetrics.emailsSentRate1m.toFixed(2)} emails/sec`);
        console.log(`  Prometheus rate (5m): ${endMetrics.emailsSentRate5m.toFixed(2)} emails/sec`);
        console.log(`  Emails sent delta: ${emailsDelta.toLocaleString()}`);

        // Calculate accuracy delta
        if (endMetrics.emailsSentRate1m > 0) {
          const accuracyDelta = ((actualThroughput - endMetrics.emailsSentRate1m) / endMetrics.emailsSentRate1m) * 100;
          console.log(`  Accuracy delta: ${accuracyDelta.toFixed(1)}% (server timestamps vs Prometheus)`);
        }
      }

      return batch;
    }

    await new Promise(r => setTimeout(r, 500)); // Poll faster for better UX
  }
}

async function main() {
  console.log(`\n🚀 BatchSender Load Test (Dry Run)`);
  console.log(`   API: ${API_URL}`);
  console.log(`   Batch Size: ${BATCH_SIZE.toLocaleString()}`);
  console.log(`─────────────────────────────────────────\n`);

  try {
    const batch = await createBatch();
    await sendBatch(batch.id);
    await monitorProgress(batch.id, batch.totalRecipients);
  } catch (error) {
    console.error(`\n❌ Error:`, error);
    process.exit(1);
  }
}

main();
