#!/usr/bin/env npx tsx
/**
 * Extreme Stress Test: Multiple users, multiple batches, maximum concurrency
 *
 * This script creates multiple test users who each schedule multiple batches
 * simultaneously to trigger massive queue depth and worker scaling.
 *
 * Usage: ADMIN_SECRET=secret npx tsx scripts/stress-test-extreme.ts
 *
 * Configuration via environment:
 *   NUM_USERS=5           Number of concurrent test users
 *   BATCHES_PER_USER=10   Batches per user
 *   RECIPIENTS_PER_BATCH=10000  Recipients per batch (max 10000)
 *   API_URL=https://api.valuekeys.io
 */

const API_URL = process.env.API_URL || "https://api.valuekeys.io";
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const NUM_USERS = parseInt(process.env.NUM_USERS || "5", 10);
const BATCHES_PER_USER = parseInt(process.env.BATCHES_PER_USER || "10", 10);
const RECIPIENTS_PER_BATCH = parseInt(process.env.RECIPIENTS_PER_BATCH || "10000", 10);

if (!ADMIN_SECRET) {
  console.error("Error: ADMIN_SECRET environment variable required");
  console.error("Usage: ADMIN_SECRET=secret npx tsx scripts/stress-test-extreme.ts");
  process.exit(1);
}

interface TestUser {
  userId: string;
  email: string;
  apiKey: string;
  sendConfigId: string;
}

interface Batch {
  id: string;
  userId: string;
  totalRecipients: number;
  status: string;
  sentCount: number;
  failedCount: number;
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

async function createTestUser(index: number): Promise<TestUser> {
  const response = await fetch(`${API_URL}/api/test-setup/user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Secret": ADMIN_SECRET,
    },
    body: JSON.stringify({
      email: `stresstest-user-${index}-${Date.now()}@test.batchsender.com`,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create test user: ${response.status} ${error}`);
  }

  return response.json();
}

function generateRecipients(batchIndex: number, userIndex: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    email: `stress-u${userIndex}-b${batchIndex}-r${i}@test.local`,
    name: `Stress Test ${userIndex}-${batchIndex}-${i}`,
    variables: { index: String(i) },
  }));
}

async function createBatch(user: TestUser, batchIndex: number, userIndex: number): Promise<Batch> {
  const response = await fetch(`${API_URL}/api/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${user.apiKey}`,
    },
    body: JSON.stringify({
      name: `Stress Test U${userIndex} B${batchIndex} ${new Date().toISOString()}`,
      sendConfigId: user.sendConfigId,
      subject: "Stress Test - Dry Run",
      fromEmail: "stresstest@batchsender.local",
      fromName: "Stress Test",
      htmlContent: "<p>Hello {{name}}! Stress test email.</p>",
      textContent: "Hello {{name}}! Stress test email.",
      recipients: generateRecipients(batchIndex, userIndex, RECIPIENTS_PER_BATCH),
      dryRun: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create batch: ${response.status} ${error}`);
  }

  return response.json();
}

async function sendBatch(user: TestUser, batchId: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/batches/${batchId}/send`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${user.apiKey}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send batch: ${response.status} ${error}`);
  }
}

async function getBatchStatus(user: TestUser, batchId: string): Promise<Batch> {
  const response = await fetch(`${API_URL}/api/batches/${batchId}`, {
    headers: {
      "Authorization": `Bearer ${user.apiKey}`,
      "X-Admin-Secret": ADMIN_SECRET,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get batch: ${response.status}`);
  }

  return response.json();
}

async function getMetricsSummary(): Promise<MetricsSummary | null> {
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

async function main() {
  const totalRecipients = NUM_USERS * BATCHES_PER_USER * RECIPIENTS_PER_BATCH;

  console.log(`\n🔥 EXTREME STRESS TEST`);
  console.log(`─────────────────────────────────────────`);
  console.log(`   API: ${API_URL}`);
  console.log(`   Users: ${NUM_USERS}`);
  console.log(`   Batches per user: ${BATCHES_PER_USER}`);
  console.log(`   Recipients per batch: ${RECIPIENTS_PER_BATCH.toLocaleString()}`);
  console.log(`   TOTAL RECIPIENTS: ${totalRecipients.toLocaleString()}`);
  console.log(`─────────────────────────────────────────\n`);

  // Capture starting metrics
  const startMetrics = await getMetricsSummary();
  const startEmailsSent = startMetrics?.emailsSentTotal || 0;
  const testStartTime = Date.now();

  // Phase 1: Create all test users
  console.log(`Phase 1: Creating ${NUM_USERS} test users...`);
  const users: TestUser[] = [];
  for (let i = 0; i < NUM_USERS; i++) {
    const user = await createTestUser(i);
    users.push(user);
    process.stdout.write(`  User ${i + 1}/${NUM_USERS} created\r`);
  }
  console.log(`\n✓ ${NUM_USERS} test users created\n`);

  // Phase 2: Create all batches (parallel per user)
  console.log(`Phase 2: Creating ${NUM_USERS * BATCHES_PER_USER} batches...`);
  const allBatches: { user: TestUser; batch: Batch }[] = [];

  for (let userIndex = 0; userIndex < users.length; userIndex++) {
    const user = users[userIndex];
    const batchPromises = [];

    for (let batchIndex = 0; batchIndex < BATCHES_PER_USER; batchIndex++) {
      batchPromises.push(
        createBatch(user, batchIndex, userIndex).then((batch) => ({
          user,
          batch,
        }))
      );
    }

    const userBatches = await Promise.all(batchPromises);
    allBatches.push(...userBatches);
    process.stdout.write(`  User ${userIndex + 1}/${NUM_USERS}: ${BATCHES_PER_USER} batches created\r`);
  }
  console.log(`\n✓ ${allBatches.length} batches created\n`);

  // Phase 3: Send ALL batches simultaneously
  console.log(`Phase 3: Sending all ${allBatches.length} batches SIMULTANEOUSLY...`);
  const sendStartTime = Date.now();

  await Promise.all(
    allBatches.map(({ user, batch }) => sendBatch(user, batch.id))
  );

  console.log(`✓ All batches queued in ${Date.now() - sendStartTime}ms\n`);

  // Phase 4: Monitor progress
  console.log(`Phase 4: Monitoring progress...`);
  console.log(`─────────────────────────────────────────`);
  console.log(`Watch Grafana for worker scaling and throughput!`);
  console.log(`─────────────────────────────────────────\n`);

  const pollStart = Date.now();
  let lastTotalSent = 0;

  while (true) {
    // Get all batch statuses
    const statusPromises = allBatches.map(({ user, batch }) =>
      getBatchStatus(user, batch.id).catch(() => null)
    );
    const statuses = await Promise.all(statusPromises);

    // Calculate totals
    let totalSent = 0;
    let totalFailed = 0;
    let completedCount = 0;
    let processingCount = 0;

    for (const status of statuses) {
      if (!status) continue;
      totalSent += status.sentCount || 0;
      totalFailed += status.failedCount || 0;
      if (status.status === "completed") completedCount++;
      if (status.status === "processing") processingCount++;
    }

    const pct = ((totalSent / totalRecipients) * 100).toFixed(1);
    const elapsed = (Date.now() - pollStart) / 1000;
    const instantRate = (totalSent - lastTotalSent) / 0.5; // Polling every 500ms

    // Get real metrics
    const metrics = await getMetricsSummary();
    const prometheusRate = metrics?.emailsSentRate1m?.toFixed(0) || "?";

    const bar =
      "█".repeat(Math.floor((totalSent / totalRecipients) * 40)) +
      "░".repeat(40 - Math.floor((totalSent / totalRecipients) * 40));

    process.stdout.write(
      `\r[${bar}] ${pct}% | ${totalSent.toLocaleString()}/${totalRecipients.toLocaleString()} | ` +
        `${completedCount}/${allBatches.length} done | ${prometheusRate}/s (prometheus)      `
    );

    lastTotalSent = totalSent;

    // Check if all done
    if (completedCount === allBatches.length) {
      const totalTime = (Date.now() - testStartTime) / 1000;
      const endMetrics = await getMetricsSummary();
      const emailsDelta = (endMetrics?.emailsSentTotal || 0) - startEmailsSent;

      console.log(`\n\n─────────────────────────────────────────`);
      console.log(`\n✓ ALL BATCHES COMPLETED`);
      console.log(`  Total time: ${totalTime.toFixed(1)}s`);
      console.log(`  Total sent: ${totalSent.toLocaleString()}`);
      console.log(`  Total failed: ${totalFailed.toLocaleString()}`);
      console.log(`  Average throughput: ${(totalSent / totalTime).toFixed(0)} emails/sec`);

      if (endMetrics) {
        console.log(`\n─── Prometheus Metrics ───`);
        console.log(`  Emails sent delta: ${emailsDelta.toLocaleString()}`);
        console.log(`  Final rate (1m): ${endMetrics.emailsSentRate1m.toFixed(0)} emails/sec`);
        console.log(`  Final rate (5m): ${endMetrics.emailsSentRate5m.toFixed(0)} emails/sec`);
      }

      break;
    }

    // Check for stuck batches (all processing but no progress for 30s)
    if (processingCount > 0 && totalSent === lastTotalSent && elapsed > 30) {
      console.log(`\n\n⚠️  Warning: No progress in 30s with ${processingCount} batches still processing`);
    }

    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch((error) => {
  console.error(`\n❌ Error:`, error);
  process.exit(1);
});
