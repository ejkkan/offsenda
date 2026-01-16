#!/usr/bin/env node

/**
 * BatchSender Autoscaling Load Test Script
 *
 * Generates synthetic load to test queue-depth based autoscaling.
 * Creates batches, queues them, and monitors KEDA autoscaling behavior.
 *
 * Usage:
 *   pnpm test:load
 *   pnpm test:load --preset=large
 *   API_KEY=xxx pnpm test:load --batches=10 --recipients=10000
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
function getConfig(): LoadTestConfig {
  const { values } = parseArgs({
    options: {
      preset: { type: 'string' },
      batches: { type: 'string' },
      recipients: { type: 'string' },
      'api-url': { type: 'string' },
      namespace: { type: 'string' },
    },
    allowPositionals: false,
  });

  // Check if API key is set
  const apiKey = process.env.API_KEY || '';
  if (!apiKey) {
    console.error(`${colors.red}✗ API_KEY environment variable not set${colors.reset}`);
    console.log(`  Usage: ${colors.cyan}API_KEY=your-key pnpm test:load${colors.reset}`);
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

  return {
    apiUrl: values['api-url'] || process.env.API_URL || 'http://localhost:3000',
    apiKey,
    namespace: values.namespace || process.env.NAMESPACE || 'batchsender',
    batchSize,
    numBatches,
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
      email: `test${i}@example.com`,
      name: `Test User ${i}`,
    });
  }

  const payload = {
    name: `Load Test Batch ${batchNum} - ${Date.now()}`,
    subject: 'Autoscaling Load Test',
    fromEmail: 'loadtest@example.com',
    fromName: 'Load Test',
    htmlContent: '<p>This is a load test email to test autoscaling.</p>',
    textContent: 'This is a load test email to test autoscaling.',
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

/**
 * Monitor autoscaling
 */
async function monitorAutoscaling(config: LoadTestConfig): Promise<void> {
  console.log('');
  console.log(`${colors.blue}=== Monitoring Autoscaling ===${colors.reset}`);
  console.log('');

  const checks = 60; // Monitor for 10 minutes (60 * 10 seconds)

  for (let i = 1; i <= checks; i++) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`${colors.yellow}--- Check ${i}/${checks} (${timestamp}) ---${colors.reset}`);

    // Get HPA status
    console.log(`${colors.blue}HPA Status:${colors.reset}`);
    try {
      const { stdout } = await execAsync(`kubectl get hpa worker-hpa -n ${config.namespace}`);
      console.log(stdout);
    } catch {
      console.log('HPA not found');
    }

    // Get current worker count
    console.log(`${colors.blue}Worker Pods:${colors.reset}`);
    try {
      const { stdout: podList } = await execAsync(`kubectl get pods -n ${config.namespace} -l app=batchsender-worker --no-headers`);
      const podCount = podList.trim().split('\n').filter(line => line.length > 0).length;
      console.log(`Count: ${podCount}`);
      console.log(podList);
    } catch {
      console.log('No workers found');
    }

    // Get queue depth
    console.log(`${colors.blue}Queue Depth:${colors.reset}`);
    try {
      const { stdout: podName } = await execAsync(`kubectl get pods -n ${config.namespace} -l app=batchsender-worker -o name | head -1`);
      const pod = podName.trim();

      if (pod) {
        const { stdout: metrics } = await execAsync(`kubectl exec -n ${config.namespace} ${pod} -- curl -s localhost:3000/api/metrics`);
        const queueMatch = metrics.match(/nats_queue_depth\{[^}]*\}\s+(\d+)/);
        if (queueMatch) {
          console.log(`Queue depth: ${queueMatch[1]} messages`);
        } else {
          console.log('No queue metrics');
        }
      }
    } catch {
      console.log('Cannot fetch queue metrics');
    }

    console.log('');

    // Sleep between checks (except on last iteration)
    if (i < checks) {
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
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
  console.log('');
  console.log(`${colors.blue}=== Autoscaling Load Test ===${colors.reset}`);
  console.log('');

  const config = getConfig();

  console.log(`API URL: ${config.apiUrl}`);
  console.log(`Namespace: ${config.namespace}`);
  console.log(`Batch size: ${config.batchSize} emails`);
  console.log(`Number of batches: ${config.numBatches}`);
  console.log(`Total: ${config.batchSize * config.numBatches} emails`);
  console.log('');

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
  await monitorAutoscaling(config);

  console.log('');
  console.log(`${colors.green}=== Load Test Complete ===${colors.reset}`);
  console.log('');
  console.log('Review the results:');
  console.log('1. Check Grafana dashboards for metrics');
  console.log(`2. View scaling events: ${colors.cyan}kubectl describe scaledobject worker-scaler -n ${config.namespace}${colors.reset}`);
  console.log('3. Check batch completion times in the API');
  console.log('');
}

main().catch((error) => {
  console.error('');
  console.error(`${colors.red}✗ Load test failed:${colors.reset}`, error instanceof Error ? error.message : error);
  console.log('');
  process.exit(1);
});
