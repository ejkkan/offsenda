#!/usr/bin/env node

/**
 * BatchSender Infrastructure Bootstrap Script
 *
 * Installs all infrastructure components on an existing k3s cluster:
 * - Metrics Server (CPU/memory metrics)
 * - KEDA (worker autoscaling)
 * - Sealed Secrets (secret encryption)
 * - Prometheus + Grafana (monitoring)
 * - cert-manager (SSL certificates)
 *
 * Prerequisites:
 * - kubeconfig file in ./kubeconfig
 * - kubectl, helm, kubeseal installed
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

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
 * Check prerequisites
 */
async function checkPrerequisites(): Promise<void> {
  console.log(`${colors.cyan}[1/6]${colors.reset} Checking prerequisites...`);

  // Check kubeconfig
  if (!existsSync('./kubeconfig')) {
    console.error(`${colors.red}✗ kubeconfig not found${colors.reset}`);
    console.log(`  Run: ${colors.cyan}hetzner-k3s create --config cluster-config.yaml${colors.reset}`);
    process.exit(1);
  }

  // Check kubectl
  if (!(await commandExists('kubectl'))) {
    console.error(`${colors.red}✗ kubectl not found${colors.reset}`);
    console.log(`  Install: ${colors.cyan}brew install kubectl${colors.reset}`);
    process.exit(1);
  }

  // Check helm
  if (!(await commandExists('helm'))) {
    console.error(`${colors.red}✗ helm not found${colors.reset}`);
    console.log(`  Install: ${colors.cyan}brew install helm${colors.reset}`);
    process.exit(1);
  }

  // Check kubeseal
  if (!(await commandExists('kubeseal'))) {
    console.error(`${colors.red}✗ kubeseal not found${colors.reset}`);
    console.log(`  Install: ${colors.cyan}brew install kubeseal${colors.reset}`);
    process.exit(1);
  }

  // Set kubeconfig
  process.env.KUBECONFIG = './kubeconfig';

  // Verify cluster connection
  console.log(`${colors.cyan}→${colors.reset} Verifying cluster connection...`);
  try {
    await execAsync('kubectl cluster-info');
  } catch {
    console.error(`${colors.red}✗ Cannot connect to cluster${colors.reset}`);
    console.log(`  Check your kubeconfig: ${colors.cyan}./kubeconfig${colors.reset}`);
    process.exit(1);
  }

  console.log(`${colors.green}✓${colors.reset} All prerequisites met`);
}

/**
 * Install Metrics Server
 */
async function installMetricsServer(): Promise<void> {
  console.log(`${colors.cyan}[2/6]${colors.reset} Installing Metrics Server...`);
  console.log(`  ${colors.yellow}Provides CPU/memory metrics for autoscaling${colors.reset}`);

  await execAsync('kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml');

  // Patch metrics-server for k3s compatibility
  try {
    await execAsync(`kubectl patch deployment metrics-server -n kube-system --type='json' -p='[
      {
        "op": "add",
        "path": "/spec/template/spec/containers/0/args/-",
        "value": "--kubelet-insecure-tls"
      }
    ]'`);
  } catch {
    // Patch might already be applied, ignore error
  }

  console.log(`${colors.green}✓${colors.reset} Metrics Server installed`);
}

/**
 * Install KEDA
 */
async function installKEDA(): Promise<void> {
  console.log(`${colors.cyan}[3/6]${colors.reset} Installing KEDA for worker autoscaling...`);
  console.log(`  ${colors.yellow}Scales workers based on NATS queue depth${colors.reset}`);

  // Add helm repo
  try {
    await execAsync('helm repo add kedacore https://kedacore.github.io/charts');
  } catch {
    // Repo might already exist
  }
  await execAsync('helm repo update');

  // Install KEDA
  await execAsync(`helm upgrade --install keda kedacore/keda \
    --namespace keda \
    --create-namespace \
    --version 2.16.0 \
    --set image.keda.tag=2.16.0 \
    --set image.metricsApiServer.tag=2.16.0 \
    --set image.webhooks.tag=2.16.0 \
    --wait \
    --timeout 5m`);

  console.log(`${colors.green}✓${colors.reset} KEDA installed`);
}

/**
 * Install Sealed Secrets
 */
async function installSealedSecrets(): Promise<void> {
  console.log(`${colors.cyan}[4/6]${colors.reset} Installing Sealed Secrets for secret encryption...`);
  console.log(`  ${colors.yellow}Encrypts secrets so they can be safely stored in Git${colors.reset}`);

  // Add helm repo
  try {
    await execAsync('helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets');
  } catch {
    // Repo might already exist
  }
  await execAsync('helm repo update');

  // Install Sealed Secrets
  await execAsync(`helm upgrade --install sealed-secrets sealed-secrets/sealed-secrets \
    --namespace kube-system \
    --version 2.16.2 \
    --wait \
    --timeout 5m`);

  // Wait for controller
  console.log(`${colors.cyan}→${colors.reset} Waiting for Sealed Secrets controller...`);
  await execAsync('kubectl wait --for=condition=available --timeout=120s deployment/sealed-secrets -n kube-system');

  console.log(`${colors.green}✓${colors.reset} Sealed Secrets installed`);

  // Fetch certificate
  console.log(`${colors.cyan}→${colors.reset} Fetching Sealed Secrets certificate...`);
  await execAsync('kubeseal --fetch-cert --controller-name=sealed-secrets --controller-namespace=kube-system > sealed-secrets-cert.pem');

  console.log(`${colors.green}✓${colors.reset} Certificate saved to: ${colors.cyan}sealed-secrets-cert.pem${colors.reset}`);
}

/**
 * Install Prometheus + Grafana
 */
async function installMonitoring(): Promise<void> {
  console.log(`${colors.cyan}[5/6]${colors.reset} Installing Prometheus + Grafana monitoring stack...`);
  console.log(`  ${colors.yellow}This may take 5-10 minutes...${colors.reset}`);

  // Add helm repo
  try {
    await execAsync('helm repo add prometheus-community https://prometheus-community.github.io/helm-charts');
  } catch {
    // Repo might already exist
  }
  await execAsync('helm repo update');

  // Create monitoring namespace
  await execAsync('kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -');

  // Install kube-prometheus-stack
  await execAsync(`helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --version 67.4.0 \
    --set prometheus.prometheusSpec.retention=30d \
    --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=20Gi \
    --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName=hcloud-volumes \
    --set grafana.persistence.enabled=true \
    --set grafana.persistence.size=10Gi \
    --set grafana.persistence.storageClassName=hcloud-volumes \
    --set grafana.adminPassword=admin \
    --set grafana.service.type=ClusterIP \
    --wait \
    --timeout 10m`);

  console.log(`${colors.green}✓${colors.reset} Monitoring stack installed`);
}

/**
 * Install cert-manager
 */
async function installCertManager(): Promise<void> {
  console.log(`${colors.cyan}[6/6]${colors.reset} Installing cert-manager for SSL certificates...`);
  console.log(`  ${colors.yellow}Automatically manages TLS certificates${colors.reset}`);

  // Add helm repo
  try {
    await execAsync('helm repo add jetstack https://charts.jetstack.io');
  } catch {
    // Repo might already exist
  }
  await execAsync('helm repo update');

  // Install cert-manager
  await execAsync(`helm upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager \
    --create-namespace \
    --version v1.16.2 \
    --set crds.enabled=true \
    --wait \
    --timeout 5m`);

  console.log(`${colors.green}✓${colors.reset} cert-manager installed`);
}

/**
 * Show final summary
 */
function showSummary(): void {
  console.log('');
  console.log(`${colors.bold}${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.green}✓ Infrastructure bootstrap complete!${colors.reset}`);
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');
  console.log(`  ${colors.bold}Installed components:${colors.reset}`);
  console.log('  ┌─────────────────────────────────────────────────────────┐');
  console.log('  │ ✓ Metrics Server (CPU/memory metrics)                  │');
  console.log('  │ ✓ KEDA (worker autoscaling)                            │');
  console.log('  │ ✓ Sealed Secrets (secret encryption)                   │');
  console.log('  │ ✓ Prometheus + Grafana (monitoring)                    │');
  console.log('  │ ✓ cert-manager (SSL certificates)                      │');
  console.log('  └─────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  ${colors.bold}Important files:${colors.reset}`);
  console.log(`  • Kubeconfig: ${colors.cyan}./kubeconfig${colors.reset}`);
  console.log(`  • Sealed Secrets cert: ${colors.cyan}sealed-secrets-cert.pem${colors.reset}`);
  console.log('');
  console.log(`  ${colors.bold}Next steps:${colors.reset}`);
  console.log(`  1. Encrypt secrets: ${colors.cyan}pnpm secrets:seal${colors.reset}`);
  console.log(`  2. Deploy app: ${colors.cyan}kubectl apply -k k8s/overlays/production${colors.reset}`);
  console.log(`  3. Verify: ${colors.cyan}pnpm deploy:verify${colors.reset}`);
  console.log('');
  console.log(`  ${colors.bold}Access Grafana:${colors.reset}`);
  console.log(`  ${colors.cyan}kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80${colors.reset}`);
  console.log('  Username: admin');
  console.log('  Password: admin (change after first login)');
  console.log('');
  console.log(`${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('');
  console.log(`${colors.bold}${colors.blue}╔══════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bold}${colors.blue}║                                                          ║${colors.reset}`);
  console.log(`${colors.bold}${colors.blue}║     🚀 BatchSender Infrastructure Bootstrap             ║${colors.reset}`);
  console.log(`${colors.bold}${colors.blue}║                                                          ║${colors.reset}`);
  console.log(`${colors.bold}${colors.blue}╚══════════════════════════════════════════════════════════╝${colors.reset}`);
  console.log('');

  try {
    await checkPrerequisites();
    await installMetricsServer();
    await installKEDA();
    await installSealedSecrets();
    await installMonitoring();
    await installCertManager();
    showSummary();
  } catch (error) {
    console.error('');
    console.error(`${colors.red}✗ Bootstrap failed:${colors.reset}`, error instanceof Error ? error.message : error);
    console.log('');
    process.exit(1);
  }
}

main();
