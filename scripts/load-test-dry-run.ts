#!/usr/bin/env npx tsx
/**
 * Load test: 100k dry run against production
 *
 * Usage: API_KEY=your_key npx tsx scripts/load-test-dry-run.ts
 */

const API_URL = process.env.API_URL || "https://api.valuekeys.io";
const API_KEY = process.env.API_KEY;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "100000", 10);

if (!API_KEY) {
  console.error("Error: API_KEY environment variable required");
  console.error("Usage: API_KEY=your_key npx tsx scripts/load-test-dry-run.ts");
  process.exit(1);
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
  const response = await fetch(`${API_URL}/api/batches/${batchId}`, {
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get batch: ${response.status}`);
  }

  return response.json();
}

async function monitorProgress(batchId: string, totalRecipients: number) {
  console.log(`\nMonitoring progress...`);
  console.log(`─────────────────────────────────────────`);

  const start = Date.now();
  let lastSent = 0;
  let lastTime = start;

  while (true) {
    const batch = await getBatchStatus(batchId);
    const now = Date.now();
    const elapsed = (now - start) / 1000;
    const sentDelta = batch.sentCount - lastSent;
    const timeDelta = (now - lastTime) / 1000;
    const currentRate = timeDelta > 0 ? sentDelta / timeDelta : 0;
    const overallRate = elapsed > 0 ? batch.sentCount / elapsed : 0;
    const pct = ((batch.sentCount / totalRecipients) * 100).toFixed(1);

    const bar = "█".repeat(Math.floor(batch.sentCount / totalRecipients * 30)) +
                "░".repeat(30 - Math.floor(batch.sentCount / totalRecipients * 30));

    process.stdout.write(`\r[${bar}] ${pct}% | ${batch.sentCount.toLocaleString()}/${totalRecipients.toLocaleString()} | ${currentRate.toFixed(0)}/s (avg: ${overallRate.toFixed(0)}/s) | ${batch.status}  `);

    lastSent = batch.sentCount;
    lastTime = now;

    if (batch.status === "completed" || batch.status === "failed") {
      console.log(`\n─────────────────────────────────────────`);
      console.log(`\n✓ Batch ${batch.status}`);
      console.log(`  Total time: ${elapsed.toFixed(2)}s`);
      console.log(`  Throughput: ${overallRate.toFixed(2)} emails/sec`);
      console.log(`  Sent: ${batch.sentCount.toLocaleString()}`);
      console.log(`  Failed: ${batch.failedCount.toLocaleString()}`);
      return batch;
    }

    await new Promise(r => setTimeout(r, 2000));
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
