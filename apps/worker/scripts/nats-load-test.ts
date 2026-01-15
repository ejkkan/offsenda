#!/usr/bin/env tsx

import { NatsClient } from "../src/nats/client.js";
import { NatsQueueService } from "../src/nats/queue-service.js";
import { log, createTimer } from "../src/logger.js";

// Configuration for load test
const TEST_CONFIG = {
  USERS: 50,
  EMAILS_PER_USER: 30000,
  BATCH_SIZE: 1000,  // Send emails in chunks
  REPORT_INTERVAL: 5000, // Report stats every 5 seconds
};

async function generateTestBatch(userId: string, batchId: string, count: number) {
  const emails = [];
  for (let i = 0; i < count; i++) {
    emails.push({
      batchId,
      recipientId: `test-${userId}-${i}`,
      userId,
      email: `user${i}@example.com`,
      name: `Test User ${i}`,
      fromEmail: "test@batchsender.com",
      fromName: "Load Test",
      subject: "Load Test Email",
      htmlContent: "<h1>Test Email</h1><p>This is a load test email.</p>",
      textContent: "Test Email\n\nThis is a load test email.",
    });
  }
  return emails;
}

async function runLoadTest() {
  const totalTimer = createTimer();

  console.log(`
========================================
  NATS Load Test
========================================
  Users: ${TEST_CONFIG.USERS}
  Emails per user: ${TEST_CONFIG.EMAILS_PER_USER}
  Total emails: ${TEST_CONFIG.USERS * TEST_CONFIG.EMAILS_PER_USER}
========================================
`);

  // Initialize NATS
  const natsClient = new NatsClient();
  await natsClient.connect();

  const queueService = new NatsQueueService(natsClient);

  // Initial stats
  const initialStats = await queueService.getQueueStats();
  console.log("Initial queue state:", {
    batch: initialStats.batch.pending,
    email: initialStats.email.pending,
  });

  // Queue all batches
  console.log("\nQueuing batches...");
  const batchTimer = createTimer();

  const batchPromises = [];
  for (let user = 0; user < TEST_CONFIG.USERS; user++) {
    const userId = `test-user-${user}`;
    const batchId = `test-batch-${user}`;
    batchPromises.push(queueService.enqueueBatch(batchId, userId));
  }

  await Promise.all(batchPromises);
  console.log(`✓ Queued ${TEST_CONFIG.USERS} batches in ${batchTimer()}`);

  // Queue all emails
  console.log("\nQueuing emails...");
  const emailTimer = createTimer();

  let totalQueued = 0;

  // Process users in parallel but emails in chunks
  const userPromises = [];

  for (let user = 0; user < TEST_CONFIG.USERS; user++) {
    const userId = `test-user-${user}`;
    const batchId = `test-batch-${user}`;

    userPromises.push((async () => {
      // Queue emails in chunks
      for (let i = 0; i < TEST_CONFIG.EMAILS_PER_USER; i += TEST_CONFIG.BATCH_SIZE) {
        const chunkSize = Math.min(TEST_CONFIG.BATCH_SIZE, TEST_CONFIG.EMAILS_PER_USER - i);
        const emails = await generateTestBatch(userId, batchId, chunkSize);

        await queueService.enqueueEmails(userId, emails);
        totalQueued += chunkSize;

        if (totalQueued % 100000 === 0) {
          console.log(`  Queued ${totalQueued.toLocaleString()} emails...`);
        }
      }
    })());
  }

  await Promise.all(userPromises);

  console.log(`✓ Queued ${totalQueued.toLocaleString()} emails in ${emailTimer()}`);

  // Monitor processing
  console.log("\nMonitoring processing...");

  let lastStats = await queueService.getQueueStats();
  let lastPending = lastStats.email.pending;
  let lastTime = Date.now();

  const monitorInterval = setInterval(async () => {
    try {
      const currentStats = await queueService.getQueueStats();
      const currentTime = Date.now();
      const timeDelta = (currentTime - lastTime) / 1000;

      const processed = Math.max(0, lastPending - currentStats.email.pending);
      const rate = Math.round(processed / timeDelta);

      const pendingTotal = currentStats.batch.pending + currentStats.email.pending;

      console.log({
        time: new Date().toISOString(),
        pending: {
          batches: currentStats.batch.pending,
          emails: currentStats.email.pending,
          total: pendingTotal,
        },
        rate: `${rate}/sec`,
        consumers: currentStats.email.consumers,
      });

      // Update for next iteration
      lastStats = currentStats;
      lastPending = currentStats.email.pending;
      lastTime = currentTime;

      // Stop monitoring when done
      if (pendingTotal === 0) {
        clearInterval(monitorInterval);
        console.log(`
========================================
  Load Test Complete
========================================
  Total time: ${totalTimer()}
  Emails sent: ${totalQueued.toLocaleString()}
  Average rate: ${Math.round(totalQueued / (Date.now() - Date.now()) * 1000)}/sec
========================================
`);

        await natsClient.close();
        process.exit(0);
      }
    } catch (error) {
      console.error("Monitor error:", error);
    }
  }, TEST_CONFIG.REPORT_INTERVAL);

  // Safety timeout after 30 minutes
  setTimeout(() => {
    console.log("\nLoad test timeout reached (30 minutes)");
    clearInterval(monitorInterval);
    natsClient.close();
    process.exit(1);
  }, 30 * 60 * 1000);
}

// Run the test
runLoadTest().catch((error) => {
  console.error("Load test failed:", error);
  process.exit(1);
});