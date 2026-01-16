#!/usr/bin/env node

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

async function checkKubectlAccess(): Promise<boolean> {
  try {
    await execAsync('kubectl cluster-info');
    return true;
  } catch {
    return false;
  }
}

async function getPods(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      'kubectl get pods -n batchsender -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp --no-headers'
    );

    console.log(`  ${colors.bold}Pods:${colors.reset}`);
    const pods = stdout.trim().split('\n');

    if (pods.length === 0 || pods[0] === '') {
      console.log(`    ${colors.gray}No pods found${colors.reset}`);
      return;
    }

    for (const pod of pods) {
      const [name, status, restarts, age] = pod.trim().split(/\s+/);
      const statusColor = status === 'Running' ? colors.green : colors.yellow;
      const ageDate = new Date(age);
      const ageStr = getRelativeTime(ageDate);

      console.log(`    ${statusColor}●${colors.reset} ${name}`);
      console.log(`      Status: ${statusColor}${status}${colors.reset}  Restarts: ${restarts}  Age: ${ageStr}`);
    }
  } catch (error) {
    console.log(`    ${colors.red}Error fetching pods${colors.reset}`);
  }
}

async function getServices(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      'kubectl get svc -n batchsender -o custom-columns=NAME:.metadata.name,TYPE:.spec.type,CLUSTER-IP:.spec.clusterIP,EXTERNAL-IP:.status.loadBalancer.ingress[0].ip --no-headers'
    );

    console.log(`\n  ${colors.bold}Services:${colors.reset}`);
    const services = stdout.trim().split('\n');

    if (services.length === 0 || services[0] === '') {
      console.log(`    ${colors.gray}No services found${colors.reset}`);
      return;
    }

    for (const svc of services) {
      const [name, type, clusterIP, externalIP] = svc.trim().split(/\s+/);
      console.log(`    ${colors.cyan}●${colors.reset} ${name}`);
      console.log(`      Type: ${type}  Cluster IP: ${clusterIP}${externalIP !== '<none>' ? `  External IP: ${externalIP}` : ''}`);
    }
  } catch (error) {
    console.log(`    ${colors.red}Error fetching services${colors.reset}`);
  }
}

async function getDeployments(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      'kubectl get deployments -n batchsender -o custom-columns=NAME:.metadata.name,READY:.status.readyReplicas,AVAILABLE:.status.availableReplicas,DESIRED:.spec.replicas --no-headers'
    );

    console.log(`\n  ${colors.bold}Deployments:${colors.reset}`);
    const deployments = stdout.trim().split('\n');

    if (deployments.length === 0 || deployments[0] === '') {
      console.log(`    ${colors.gray}No deployments found${colors.reset}`);
      return;
    }

    for (const deploy of deployments) {
      const [name, ready, available, desired] = deploy.trim().split(/\s+/);
      const readyNum = parseInt(ready || '0');
      const desiredNum = parseInt(desired || '0');
      const isHealthy = readyNum === desiredNum && readyNum > 0;
      const statusColor = isHealthy ? colors.green : colors.yellow;

      console.log(`    ${statusColor}●${colors.reset} ${name}`);
      console.log(`      Ready: ${ready || '0'}/${desired}  Available: ${available || '0'}`);
    }
  } catch (error) {
    console.log(`    ${colors.red}Error fetching deployments${colors.reset}`);
  }
}

async function getIngresses(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      'kubectl get ingress -n batchsender -o custom-columns=NAME:.metadata.name,HOSTS:.spec.rules[*].host,ADDRESS:.status.loadBalancer.ingress[0].ip --no-headers'
    );

    console.log(`\n  ${colors.bold}Ingresses:${colors.reset}`);
    const ingresses = stdout.trim().split('\n');

    if (ingresses.length === 0 || ingresses[0] === '') {
      console.log(`    ${colors.gray}No ingresses found${colors.reset}`);
      return;
    }

    for (const ing of ingresses) {
      const [name, hosts, address] = ing.trim().split(/\s+/);
      console.log(`    ${colors.cyan}●${colors.reset} ${name}`);
      console.log(`      Hosts: ${hosts}  Address: ${address || 'pending'}`);
    }
  } catch (error) {
    console.log(`    ${colors.red}Error fetching ingresses${colors.reset}`);
  }
}

function getRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d`;
  if (diffHours > 0) return `${diffHours}h`;
  if (diffMins > 0) return `${diffMins}m`;
  return 'just now';
}

async function main() {
  console.log('');
  console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}  Production Deployment Status${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  // Check if kubectl can access cluster
  const hasAccess = await checkKubectlAccess();

  if (!hasAccess) {
    console.log(`  ${colors.red}✗ Cannot connect to Kubernetes cluster${colors.reset}`);
    console.log(`    ${colors.yellow}→${colors.reset} Check kubeconfig: ${colors.cyan}export KUBECONFIG=./kubeconfig${colors.reset}`);
    console.log('');
    process.exit(1);
  }

  console.log(`  ${colors.green}✓${colors.reset} Connected to cluster\n`);

  // Get deployment information
  await getDeployments();
  await getPods();
  await getServices();
  await getIngresses();

  console.log('');
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  console.log(`  ${colors.bold}Quick Actions:${colors.reset}`);
  console.log(`    • ${colors.cyan}pnpm prod:logs${colors.reset}   - View production logs`);
  console.log(`    • ${colors.cyan}pnpm prod:shell${colors.reset}  - Access worker shell`);
  console.log(`    • ${colors.cyan}pnpm deploy:check${colors.reset} - Validate before deploy`);
  console.log('');
}

main().catch((error) => {
  console.error('Error checking deployment status:', error);
  process.exit(1);
});
