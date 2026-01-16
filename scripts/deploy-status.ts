#!/usr/bin/env node

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

/**
 * Verification mode - comprehensive health checks
 */
async function runVerification(): Promise<void> {
  console.log('');
  console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}  Production Deployment Verification${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  let errors = 0;

  // Helper to check and report
  const check = (passed: boolean, message: string): void => {
    if (passed) {
      console.log(`  ${colors.green}✓${colors.reset} ${message}`);
    } else {
      console.log(`  ${colors.red}✗${colors.reset} ${message}`);
      errors++;
    }
  };

  // Check namespace
  console.log(`${colors.cyan}[1/8]${colors.reset} Checking namespace...`);
  try {
    await execAsync('kubectl get namespace batchsender');
    check(true, 'Namespace \'batchsender\' exists');
  } catch {
    check(false, 'Namespace \'batchsender\' exists');
  }

  // Check PostgreSQL
  console.log(`${colors.cyan}[2/8]${colors.reset} Checking PostgreSQL...`);
  try {
    await execAsync('kubectl wait --for=condition=ready pod -l app=postgres -n batchsender --timeout=30s');
    check(true, 'PostgreSQL pod is ready');
  } catch {
    check(false, 'PostgreSQL pod is ready');
  }

  // Check DragonflyDB
  console.log(`${colors.cyan}[3/8]${colors.reset} Checking DragonflyDB...`);
  try {
    await execAsync('kubectl wait --for=condition=ready pod -l app=dragonfly -n batchsender --timeout=30s');
    check(true, 'DragonflyDB pod is ready');
  } catch {
    check(false, 'DragonflyDB pod is ready');
  }

  // Check NATS
  console.log(`${colors.cyan}[4/8]${colors.reset} Checking NATS cluster...`);
  try {
    const { stdout } = await execAsync('kubectl get pods -l app=nats -n batchsender -o jsonpath=\'{.items[*].status.conditions[?(@.type=="Ready")].status}\'');
    const readyCount = (stdout.match(/True/g) || []).length;
    check(readyCount >= 1, `NATS pods ready (${readyCount}/3 replicas)`);
  } catch {
    check(false, 'NATS pods not ready');
  }

  // Check ClickHouse
  console.log(`${colors.cyan}[5/8]${colors.reset} Checking ClickHouse...`);
  try {
    await execAsync('kubectl wait --for=condition=ready pod -l app=clickhouse -n batchsender --timeout=60s');
    check(true, 'ClickHouse pod is ready');
  } catch {
    check(false, 'ClickHouse pod is ready');
  }

  // Check Worker deployment
  console.log(`${colors.cyan}[6/8]${colors.reset} Checking Worker deployment...`);
  try {
    await execAsync('kubectl wait --for=condition=available deployment/worker -n batchsender --timeout=60s');
    check(true, 'Worker deployment is available');

    const { stdout } = await execAsync('kubectl get deployment worker -n batchsender -o jsonpath=\'{.status.readyReplicas}\'');
    const replicas = parseInt(stdout);
    check(replicas >= 1, `Worker replicas ready (${replicas})`);
  } catch {
    check(false, 'Worker deployment is available');
  }

  // Check KEDA ScaledObject
  console.log(`${colors.cyan}[7/8]${colors.reset} Checking KEDA autoscaling...`);
  try {
    const { stdout } = await execAsync('kubectl get scaledobject worker-scaler -n batchsender -o jsonpath=\'{.status.conditions[?(@.type=="Ready")].status}\'');
    check(stdout.trim() === 'True', 'KEDA ScaledObject is ready');

    // Show scaling config
    const { stdout: minReplicas } = await execAsync('kubectl get scaledobject worker-scaler -n batchsender -o jsonpath=\'{.spec.minReplicaCount}\'');
    const { stdout: maxReplicas } = await execAsync('kubectl get scaledobject worker-scaler -n batchsender -o jsonpath=\'{.spec.maxReplicaCount}\'');
    console.log(`    ${colors.cyan}→${colors.reset} Scaling range: ${minReplicas}-${maxReplicas} workers`);
  } catch {
    check(false, 'KEDA ScaledObject is ready');
  }

  // Check health endpoints
  console.log(`${colors.cyan}[8/8]${colors.reset} Checking health endpoints...`);
  try {
    const { stdout } = await execAsync('kubectl get pods -l app=worker -n batchsender -o jsonpath=\'{.items[0].metadata.name}\'');
    const workerPod = stdout.trim();

    if (workerPod) {
      // Test health endpoint
      try {
        const { stdout: healthResponse } = await execAsync(`kubectl exec -n batchsender ${workerPod} -- curl -s http://localhost:6001/health`);
        check(healthResponse.includes('healthy'), 'Health endpoint responding');
      } catch {
        check(false, 'Health endpoint responding');
      }

      // Test metrics endpoint
      try {
        const { stdout: metricsResponse } = await execAsync(`kubectl exec -n batchsender ${workerPod} -- curl -s http://localhost:6001/api/metrics`);
        check(metricsResponse.includes('worker_'), 'Metrics endpoint responding');
      } catch {
        check(false, 'Metrics endpoint responding');
      }
    } else {
      check(false, 'No worker pods found to test endpoints');
    }
  } catch {
    check(false, 'Health endpoint responding');
  }

  // Summary
  console.log('');
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  if (errors === 0) {
    console.log(`${colors.bold}${colors.green}✓ All checks passed! Deployment is healthy.${colors.reset}`);
    console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
    process.exit(0);
  } else {
    console.log(`${colors.bold}${colors.red}✗ Found ${errors} errors in deployment.${colors.reset}`);
    console.log(`${colors.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
    console.log(`${colors.yellow}Debugging information:${colors.reset}`);
    try {
      console.log(`\n${colors.bold}Pod Status:${colors.reset}`);
      const { stdout: pods } = await execAsync('kubectl get pods -n batchsender');
      console.log(pods);

      console.log(`\n${colors.bold}Recent Events:${colors.reset}`);
      const { stdout: events } = await execAsync('kubectl get events -n batchsender --sort-by=\'.lastTimestamp\' | tail -10');
      console.log(events);
    } catch (error) {
      // Ignore errors in debugging output
    }
    console.log('');
    process.exit(1);
  }
}

async function main() {
  // Parse command line arguments
  const { values } = parseArgs({
    options: {
      verify: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  // Check if kubectl can access cluster
  const hasAccess = await checkKubectlAccess();

  if (!hasAccess) {
    console.log('');
    console.log(`  ${colors.red}✗ Cannot connect to Kubernetes cluster${colors.reset}`);
    console.log(`    ${colors.yellow}→${colors.reset} Check kubeconfig: ${colors.cyan}export KUBECONFIG=./kubeconfig${colors.reset}`);
    console.log('');
    process.exit(1);
  }

  // Run verification mode if requested
  if (values.verify) {
    await runVerification();
    return;
  }

  // Normal status display
  console.log('');
  console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}  Production Deployment Status${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

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
  console.log(`    • ${colors.cyan}pnpm prod:logs${colors.reset}    - View production logs`);
  console.log(`    • ${colors.cyan}pnpm prod:shell${colors.reset}   - Access worker shell`);
  console.log(`    • ${colors.cyan}pnpm deploy:verify${colors.reset} - Run comprehensive health checks`);
  console.log(`    • ${colors.cyan}pnpm deploy:check${colors.reset}  - Validate before deploy`);
  console.log('');
}

main().catch((error) => {
  console.error('Error checking deployment status:', error);
  process.exit(1);
});
