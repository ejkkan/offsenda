#!/usr/bin/env node

/**
 * BatchSender Production Stress Test Script
 *
 * Runs graduated stress tests with dryRun mode to validate system performance
 * without sending real emails. Monitors queue depth, pod autoscaling, and
 * provides a final report with success criteria.
 *
 * Presets:
 *   small   - 2 batches × 1,000 = 2,000 emails (warm-up)
 *   medium  - 5 batches × 5,000 = 25,000 emails (validate autoscaling)
 *   large   - 10 batches × 10,000 = 100,000 emails (sustained load)
 *   stress  - 20 batches × 20,000 = 400,000 emails (stress test)
 *
 * Usage:
 *   # Local development
 *   API_KEY=xxx pnpm test:load --preset=small
 *
 *   # Production stress test (defaults to dryRun: true)
 *   API_KEY=xxx pnpm test:load --production --preset=small
 *   API_KEY=xxx pnpm test:load --production --preset=medium
 *   API_KEY=xxx pnpm test:load --production --preset=large
 *
 *   # Custom configuration
 *   API_KEY=xxx pnpm test:load --production --batches=10 --recipients=5000
 *
 *   # With explicit kubeconfig for pod monitoring
 *   API_KEY=xxx KUBECONFIG=/path/to/kubeconfig pnpm test:load --production --preset=medium
 *
 *   # Disable dryRun (DANGER: sends real emails!)
 *   API_KEY=xxx pnpm test:load --production --preset=small --no-dry-run
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const execAsync = promisify(exec);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
};

interface LoadTestConfig {
  apiUrl: string;
  apiKey: string;
  namespace: string;
  batchSize: number;
  numBatches: number;
  dryRun: boolean;
  kubeconfigPath?: string;
}

interface Preset {
  batchSize: number;
  numBatches: number;
  description: string;
}

const PRESETS: Record<string, Preset> = {
  small: {
    batchSize: 1000,
    numBatches: 2,
    description: '2 batches × 1,000 recipients = 2,000 emails',
  },
  medium: {
    batchSize: 5000,
    numBatches: 5,
    description: '5 batches × 5,000 recipients = 25,000 emails',
  },
  large: {
    batchSize: 10000,
    numBatches: 10,
    description: '10 batches × 10,000 recipients = 100,000 emails',
  },
  stress: {
    batchSize: 20000,
    numBatches: 20,
    description: '20 batches × 20,000 recipients = 400,000 emails',
  },
};

/**
 * Get load test configuration
 */
function showHelp(): void {
  console.log(`
${colors.blue}BatchSender Production Stress Test${colors.reset}

${colors.yellow}USAGE:${colors.reset}
  API_KEY=xxx pnpm test:load [OPTIONS]

${colors.yellow}OPTIONS:${colors.reset}
  --preset=PRESET    Use a preset configuration (small, medium, large, stress)
  --batches=N        Number of batches to create
  --recipients=N     Number of recipients per batch
  --production       Use production API (https://api.valuekeys.io)
  --api-url=URL      Custom API URL
  --namespace=NS     Kubernetes namespace (default: batchsender)
  --kubeconfig=PATH  Path to kubeconfig for pod monitoring
  --no-dry-run       Disable dry run mode (DANGER: sends real emails!)
  --help             Show this help message

${colors.yellow}PRESETS:${colors.reset}
  small   2 batches × 1,000  = 2,000 emails    (warm-up test)
  medium  5 batches × 5,000  = 25,000 emails   (autoscaling validation)
  large   10 batches × 10,000 = 100,000 emails (sustained load)
  stress  20 batches × 20,000 = 400,000 emails (stress test)

${colors.yellow}EXAMPLES:${colors.reset}
  # Local development
  API_KEY=xxx pnpm test:load --preset=small

  # Production small test
  API_KEY=xxx pnpm test:load --production --preset=small

  # Production with custom batches
  API_KEY=xxx pnpm test:load --production --batches=3 --recipients=2000

  # With kubeconfig for pod monitoring
  API_KEY=xxx KUBECONFIG=./kubeconfig pnpm test:load --production --preset=medium
`);
  process.exit(0);
}

function getConfig(): LoadTestConfig {
  const { values } = parseArgs({
    options: {
      preset: { type: 'string' },
      batches: { type: 'string' },
      recipients: { type: 'string' },
      'api-url': { type: 'string' },
      namespace: { type: 'string' },
      'dry-run': { type: 'boolean', default: true },
      kubeconfig: { type: 'string' },
      production: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    showHelp();
  }

  // Production mode sets default API URL
  const isProduction = values.production || false;
  const defaultApiUrl = isProduction ? 'https://api.valuekeys.io' : 'http://localhost:3000';

  // Check if API key is set
  const apiKey = process.env.API_KEY || '';
  if (!apiKey) {
    console.error(`${colors.red}✗ API_KEY environment variable not set${colors.reset}`);
    console.log(`  Usage: ${colors.cyan}API_KEY=your-key pnpm test:load${colors.reset}`);
    console.log(`  Production: ${colors.cyan}API_KEY=your-key pnpm test:load --production --preset=small${colors.reset}`);
    process.exit(1);
  }

  // Apply preset if specified
  let batchSize = 5000;
  let numBatches = 5;

  if (values.preset && PRESETS[values.preset]) {
    const preset = PRESETS[values.preset];
    batchSize = preset.batchSize;
    numBatches = preset.numBatches;
  }

  // Override with explicit values if provided
  if (values.recipients) {
    batchSize = parseInt(values.recipients);
  }
  if (values.batches) {
    numBatches = parseInt(values.batches);
  }

  // dryRun defaults to true for safety
  const dryRun = values['dry-run'] !== false;

  return {
    apiUrl: values['api-url'] || process.env.API_URL || defaultApiUrl,
    apiKey,
    namespace: values.namespace || process.env.NAMESPACE || 'batchsender',
    batchSize,
    numBatches,
    dryRun,
    kubeconfigPath: values.kubeconfig || process.env.KUBECONFIG,
  };
}

/**
 * Check prerequisites
 */
async function checkPrerequisites(): Promise<void> {
  // Check kubectl
  try {
    await execAsync('command -v kubectl');
  } catch {
    console.error(`${colors.red}✗ kubectl not found${colors.reset}`);
    console.log(`  Install: ${colors.cyan}brew install kubectl${colors.reset}`);
    process.exit(1);
  }

  // Check jq (optional)
  try {
    await execAsync('command -v jq');
  } catch {
    console.log(`${colors.yellow}⚠ jq not found. Install jq for better output formatting.${colors.reset}`);
  }
}

/**
 * Create a test batch
 */
async function createBatch(config: LoadTestConfig, batchNum: number): Promise<string | null> {
  const recipients = [];
  for (let i = 1; i <= config.batchSize; i++) {
    recipients.push({
      email: `user${i}b${batchNum}@test.local`,
      name: `User ${i}`,
    });
  }

  const payload = {
    name: `Load Test Batch ${batchNum} - ${new Date().toISOString()}`,
    subject: 'Load Test',
    fromEmail: 'test@valuekeys.io',
    fromName: 'Load Test',
    htmlContent: '<p>This is a load test email to test autoscaling.</p>',
    textContent: 'This is a load test email to test autoscaling.',
    dryRun: config.dryRun,
    recipients,
  };

  console.log(`${colors.blue}Creating batch ${batchNum}/${config.numBatches} with ${config.batchSize} recipients...${colors.reset}`);

  try {
    const { stdout } = await execAsync(
      `curl -s -X POST "${config.apiUrl}/api/batches" \
        -H "Authorization: Bearer ${config.apiKey}" \
        -H "Content-Type: application/json" \
        -d '${JSON.stringify(payload)}'`
    );

    let batchId: string | null = null;

    try {
      // Try parsing with jq
      const { stdout: id } = await execAsync(`echo '${stdout}' | jq -r '.id'`);
      batchId = id.trim();
    } catch {
      // Fallback to grep
      const match = stdout.match(/"id":"([^"]+)"/);
      batchId = match ? match[1] : null;
    }

    if (!batchId || batchId === 'null') {
      console.error(`${colors.red}✗ Failed to create batch. Response: ${stdout}${colors.reset}`);
      return null;
    }

    console.log(`${colors.green}✓ Batch created: ${batchId}${colors.reset}`);
    return batchId;
  } catch (error) {
    console.error(`${colors.red}✗ Failed to create batch:${colors.reset}`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Start sending a batch
 */
async function sendBatch(config: LoadTestConfig, batchId: string): Promise<void> {
  console.log(`${colors.blue}Starting batch: ${batchId}${colors.reset}`);

  try {
    await execAsync(
      `curl -s -X POST "${config.apiUrl}/api/batches/${batchId}/send" \
        -H "Authorization: Bearer ${config.apiKey}"`
    );

    console.log(`${colors.green}✓ Batch queued for sending${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}✗ Failed to send batch:${colors.reset}`, error instanceof Error ? error.message : error);
  }
}

interface QueueStatus {
  batches: { pending: number; consumers: number; bytes: number };
  emails: { pending: number; consumers: number; bytes: number };
  priority: { pending: number; consumers: number; bytes: number };
}

interface BatchStatus {
  id: string;
  name: string;
  status: string;
  sentCount: number;
  failedCount: number;
  totalRecipients: number;
  dryRun?: boolean;
}

/**
 * Fetch queue status via API
 */
async function getQueueStatus(config: LoadTestConfig): Promise<QueueStatus | null> {
  try {
    const { stdout } = await execAsync(
      `curl -s "${config.apiUrl}/api/queue/status" -H "Authorization: Bearer ${config.apiKey}"`
    );
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Get current pod count via kubectl
 */
async function getPodCount(config: LoadTestConfig): Promise<{ running: number; pending: number; total: number } | null> {
  try {
    const kubeconfigArg = config.kubeconfigPath ? `KUBECONFIG=${config.kubeconfigPath}` : '';
    const { stdout } = await execAsync(
      `${kubeconfigArg} kubectl get pods -n ${config.namespace} -l app=worker --no-headers 2>/dev/null || true`
    );
    const lines = stdout.trim().split('\n').filter(line => line.length > 0);
    const running = lines.filter(line => line.includes('Running')).length;
    const pending = lines.filter(line => line.includes('Pending') || line.includes('ContainerCreating')).length;
    return { running, pending, total: lines.length };
  } catch {
    return null;
  }
}

/**
 * Get batch statuses
 */
async function getBatchStatuses(config: LoadTestConfig, limit = 20): Promise<BatchStatus[]> {
  try {
    const { stdout } = await execAsync(
      `curl -s "${config.apiUrl}/api/batches?limit=${limit}" -H "Authorization: Bearer ${config.apiKey}"`
    );
    const data = JSON.parse(stdout);
    return data.batches || [];
  } catch {
    return [];
  }
}

/**
 * Monitor autoscaling and queue progress
 */
async function monitorAutoscaling(config: LoadTestConfig, batchIds: string[]): Promise<void> {
  console.log('');
  console.log(`${colors.blue}=== Monitoring Progress ===${colors.reset}`);
  console.log('');

  const startTime = Date.now();
  const maxDuration = 90 * 60 * 1000; // Max 90 minutes
  let lastQueueDepth = -1;
  let stableCount = 0;
  let peakPods = 0;
  let peakQueueDepth = 0;

  while (Date.now() - startTime < maxDuration) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const timestamp = new Date().toLocaleTimeString();

    // Get queue status
    const queueStatus = await getQueueStatus(config);
    const queueDepth = queueStatus?.emails?.pending || 0;
    peakQueueDepth = Math.max(peakQueueDepth, queueDepth);

    // Get pod count
    const podInfo = await getPodCount(config);
    if (podInfo) {
      peakPods = Math.max(peakPods, podInfo.running);
    }

    // Get batch completion status
    const batches = await getBatchStatuses(config);
    const ourBatches = batches.filter(b => batchIds.includes(b.id));
    const completed = ourBatches.filter(b => b.status === 'completed' || b.status === 'failed').length;
    const totalSent = ourBatches.reduce((acc, b) => acc + (b.sentCount || 0), 0);
    const totalFailed = ourBatches.reduce((acc, b) => acc + (b.failedCount || 0), 0);

    // Display status
    console.log(`${colors.yellow}[${timestamp}] Elapsed: ${elapsed}s${colors.reset}`);
    console.log(`  Queue: ${colors.cyan}${queueDepth}${colors.reset} pending`);
    if (podInfo) {
      console.log(`  Pods:  ${colors.cyan}${podInfo.running}${colors.reset} running, ${podInfo.pending} pending (peak: ${peakPods})`);
    }
    console.log(`  Batches: ${colors.cyan}${completed}/${batchIds.length}${colors.reset} complete, ${totalSent} sent, ${totalFailed} failed`);

    // Check if done
    if (queueDepth === 0 && completed === batchIds.length) {
      stableCount++;
      if (stableCount >= 2) {
        console.log('');
        console.log(`${colors.green}✓ All batches completed and queue is empty${colors.reset}`);
        break;
      }
    } else {
      stableCount = 0;
    }

    // Wait before next check
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  // Print summary
  const totalDuration = Math.floor((Date.now() - startTime) / 1000);
  console.log('');
  console.log(`${colors.blue}=== Test Summary ===${colors.reset}`);
  console.log(`  Duration: ${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`);
  console.log(`  Peak queue depth: ${peakQueueDepth}`);
  console.log(`  Peak pod count: ${peakPods}`);

  // Final batch status
  const finalBatches = await getBatchStatuses(config);
  const ourFinalBatches = finalBatches.filter(b => batchIds.includes(b.id));
  const totalSent = ourFinalBatches.reduce((acc, b) => acc + (b.sentCount || 0), 0);
  const totalFailed = ourFinalBatches.reduce((acc, b) => acc + (b.failedCount || 0), 0);
  const throughput = totalDuration > 0 ? Math.round(totalSent / totalDuration) : 0;

  console.log(`  Total emails sent: ${totalSent}`);
  console.log(`  Total failed: ${totalFailed}`);
  console.log(`  Average throughput: ${throughput} emails/sec`);
  console.log('');
}

/**
 * Show test summary
 */
function showSummary(config: LoadTestConfig, batchIds: string[]): void {
  const totalEmails = config.batchSize * config.numBatches;
  const expectedPods = Math.ceil(totalEmails / 1000);

  console.log('');
  console.log(`${colors.green}✓ All batches queued!${colors.reset}`);
  console.log('');
  console.log(`${colors.yellow}Expected behavior:${colors.reset}`);
  console.log(`1. Queue depth will spike to ~${totalEmails} messages`);
  console.log(`2. KEDA should detect high queue depth (>1000 msgs/pod)`);
  console.log(`3. Workers should scale up from 2 to ~${expectedPods} pods`);
  console.log(`4. Emails will process faster with more workers`);
  console.log(`5. After queue empties, workers will scale back down to 2 (after 5 min)`);
  console.log('');
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Check for help early, before printing anything
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showHelp();
  }

  console.log('');
  console.log(`${colors.blue}=== Production Stress Test ===${colors.reset}`);
  console.log('');

  const config = getConfig();

  console.log(`API URL: ${config.apiUrl}`);
  console.log(`Namespace: ${config.namespace}`);
  console.log(`Batch size: ${config.batchSize} emails`);
  console.log(`Number of batches: ${config.numBatches}`);
  console.log(`Total: ${colors.bold}${config.batchSize * config.numBatches}${colors.reset} emails`);
  console.log(`Dry Run: ${config.dryRun ? `${colors.green}YES${colors.reset} (no real emails)` : `${colors.red}NO${colors.reset} (REAL EMAILS!)`}`);
  if (config.kubeconfigPath) {
    console.log(`Kubeconfig: ${config.kubeconfigPath}`);
  }
  console.log('');

  // Safety check for non-dryRun
  if (!config.dryRun) {
    console.log(`${colors.red}⚠ WARNING: dryRun is disabled. Real emails will be sent!${colors.reset}`);
    console.log(`${colors.yellow}Press Ctrl+C within 10 seconds to cancel...${colors.reset}`);
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  await checkPrerequisites();

  console.log(`${colors.yellow}Starting load test in 5 seconds... (Ctrl+C to cancel)${colors.reset}`);
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Create batches
  console.log('');
  console.log(`${colors.blue}=== Creating Test Batches ===${colors.reset}`);
  const batchIds: string[] = [];

  for (let i = 1; i <= config.numBatches; i++) {
    const batchId = await createBatch(config, i);
    if (batchId) {
      batchIds.push(batchId);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause
    }
  }

  console.log('');
  console.log(`${colors.green}✓ Created ${batchIds.length} batches${colors.reset}`);
  console.log('');

  // Send all batches
  console.log(`${colors.blue}=== Starting All Batches ===${colors.reset}`);
  for (const batchId of batchIds) {
    await sendBatch(config, batchId);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  showSummary(config, batchIds);

  // Start monitoring
  await monitorAutoscaling(config, batchIds);

  // Verify results
  await verifyResults(config, batchIds);

  console.log('');
  console.log(`${colors.green}=== Load Test Complete ===${colors.reset}`);
  console.log('');
  console.log('Review the results:');
  console.log('1. Check Grafana dashboards for metrics');
  console.log(`2. View scaling events: ${colors.cyan}kubectl describe scaledobject worker-scaler -n ${config.namespace}${colors.reset}`);
  console.log('3. Check batch completion times in the API');
  console.log('');
}

/**
 * Verify test results
 */
async function verifyResults(config: LoadTestConfig, batchIds: string[]): Promise<void> {
  console.log('');
  console.log(`${colors.blue}=== Verification ===${colors.reset}`);
  console.log('');

  // Check batch completion
  const batches = await getBatchStatuses(config);
  const ourBatches = batches.filter(b => batchIds.includes(b.id));

  console.log(`${colors.yellow}Batch Results:${colors.reset}`);
  for (const batch of ourBatches) {
    const statusColor = batch.status === 'completed' ? colors.green : colors.red;
    console.log(`  ${batch.name}`);
    console.log(`    Status: ${statusColor}${batch.status}${colors.reset}`);
    console.log(`    Sent: ${batch.sentCount}, Failed: ${batch.failedCount}`);
    console.log(`    DryRun: ${batch.dryRun ? 'yes' : 'no'}`);
  }

  // Verify queue is empty
  const queueStatus = await getQueueStatus(config);
  console.log('');
  console.log(`${colors.yellow}Queue Status:${colors.reset}`);
  if (queueStatus) {
    const emailsPending = queueStatus.emails?.pending || 0;
    const statusColor = emailsPending === 0 ? colors.green : colors.yellow;
    console.log(`  Emails pending: ${statusColor}${emailsPending}${colors.reset}`);
  } else {
    console.log(`  ${colors.red}Could not fetch queue status${colors.reset}`);
  }

  // Summary
  const allCompleted = ourBatches.every(b => b.status === 'completed');
  const totalSent = ourBatches.reduce((acc, b) => acc + (b.sentCount || 0), 0);
  const totalFailed = ourBatches.reduce((acc, b) => acc + (b.failedCount || 0), 0);
  const errorRate = totalSent > 0 ? (totalFailed / (totalSent + totalFailed)) * 100 : 0;

  console.log('');
  console.log(`${colors.yellow}Final Stats:${colors.reset}`);
  console.log(`  All batches completed: ${allCompleted ? `${colors.green}YES${colors.reset}` : `${colors.red}NO${colors.reset}`}`);
  console.log(`  Total sent: ${totalSent}`);
  console.log(`  Total failed: ${totalFailed}`);
  console.log(`  Error rate: ${errorRate < 0.1 ? colors.green : colors.red}${errorRate.toFixed(2)}%${colors.reset}`);

  // Check success criteria
  const emailsPending = queueStatus?.emails?.pending || 0;
  console.log('');
  console.log(`${colors.yellow}Success Criteria:${colors.reset}`);
  console.log(`  ${allCompleted ? '✓' : '✗'} All batches completed`);
  console.log(`  ${emailsPending === 0 ? '✓' : '✗'} Queue empty`);
  console.log(`  ${errorRate < 0.1 ? '✓' : '✗'} Error rate < 0.1%`);
}

main().catch((error) => {
  console.error('');
  console.error(`${colors.red}✗ Load test failed:${colors.reset}`, error instanceof Error ? error.message : error);
  console.log('');
  process.exit(1);
});
