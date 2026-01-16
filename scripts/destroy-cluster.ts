#!/usr/bin/env node

/**
 * BatchSender Cluster Destroy Script
 *
 * Safely destroys the Hetzner k3s cluster and cleans up all resources.
 *
 * Prerequisites:
 * - cluster-config.yaml exists
 * - hetzner-k3s CLI installed
 *
 * WARNING: This will delete ALL resources in the cluster!
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const execAsync = promisify(exec);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

/**
 * Check if a command exists
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    await execAsync(`command -v ${command}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get cluster name from config
 */
function getClusterName(): string | null {
  if (!existsSync('cluster-config.yaml')) {
    return null;
  }

  const content = readFileSync('cluster-config.yaml', 'utf-8');
  const match = content.match(/cluster_name:\s*(.+)/);
  return match ? match[1].trim() : null;
}

/**
 * Check prerequisites
 */
async function checkPrerequisites(): Promise<void> {
  // Check hetzner-k3s
  if (!(await commandExists('hetzner-k3s'))) {
    console.error(`${colors.red}✗ hetzner-k3s not found${colors.reset}`);
    console.log(`  Install: ${colors.cyan}brew install vitobotta/tap/hetzner_k3s${colors.reset}`);
    process.exit(1);
  }

  // Check cluster config
  if (!existsSync('cluster-config.yaml')) {
    console.error(`${colors.red}✗ cluster-config.yaml not found${colors.reset}`);
    console.log('  Cannot determine which cluster to destroy.');
    process.exit(1);
  }
}

/**
 * Show cluster info and confirm destruction
 */
async function confirmDestruction(): Promise<boolean> {
  const clusterName = getClusterName();

  console.log(`${colors.yellow}This will destroy the following cluster:${colors.reset}`);
  console.log('');
  console.log(`  Cluster: ${colors.bold}${clusterName}${colors.reset}`);
  console.log('');
  console.log(`${colors.red}${colors.bold}All resources will be permanently deleted:${colors.reset}`);
  console.log('  • 3 master nodes');
  console.log('  • All worker nodes');
  console.log('  • All load balancers');
  console.log('  • All volumes');
  console.log('  • All data (databases, ClickHouse, etc.)');
  console.log('');

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`${colors.yellow}Type 'destroy' to confirm: ${colors.reset}`);
  rl.close();

  return answer.trim() === 'destroy';
}

/**
 * Destroy the cluster
 */
async function destroyCluster(): Promise<void> {
  console.log('');
  console.log(`${colors.cyan}→${colors.reset} Destroying cluster...`);
  console.log('');

  await execAsync('hetzner-k3s delete --config cluster-config.yaml');

  console.log('');
  console.log(`${colors.green}✓${colors.reset} Cluster destroyed successfully`);
  console.log('');
}

/**
 * Optionally clean up local files
 */
async function cleanupLocalFiles(): Promise<void> {
  console.log(`${colors.yellow}Clean up local files?${colors.reset}`);
  console.log('  • kubeconfig');
  console.log('  • sealed-secrets-cert.pem');
  console.log('');

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`${colors.yellow}Clean up? [y/N]: ${colors.reset}`);
  rl.close();

  if (answer.trim().toLowerCase() === 'y') {
    if (existsSync('kubeconfig')) {
      unlinkSync('kubeconfig');
    }
    if (existsSync('sealed-secrets-cert.pem')) {
      unlinkSync('sealed-secrets-cert.pem');
    }
    console.log(`${colors.green}✓${colors.reset} Local files cleaned up`);
  }
}

/**
 * Show final summary
 */
function showSummary(): void {
  console.log('');
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.green}✓ Destruction complete${colors.reset}`);
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');
  console.log(`${colors.cyan}To create a new cluster:${colors.reset}`);
  console.log(`  ${colors.cyan}hetzner-k3s create --config cluster-config.yaml${colors.reset}`);
  console.log('');
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('');
  console.log(`${colors.bold}${colors.red}⚠️  BatchSender Cluster Destruction${colors.reset}`);
  console.log(`${colors.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  try {
    await checkPrerequisites();

    const confirmed = await confirmDestruction();

    if (!confirmed) {
      console.log('');
      console.log(`${colors.green}✓${colors.reset} Cluster destruction cancelled.`);
      console.log('');
      process.exit(0);
    }

    await destroyCluster();
    await cleanupLocalFiles();
    showSummary();
  } catch (error) {
    console.error('');
    console.error(`${colors.red}✗ Destruction failed:${colors.reset}`, error instanceof Error ? error.message : error);
    console.log('');
    process.exit(1);
  }
}

main();
