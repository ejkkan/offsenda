#!/usr/bin/env node

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const execAsync = promisify(exec);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

interface CheckResult {
  name: string;
  passed: boolean;
  message?: string;
}

async function checkKubectlInstalled(): Promise<CheckResult> {
  try {
    await execAsync('kubectl version --client');
    return { name: 'kubectl installed', passed: true };
  } catch {
    return {
      name: 'kubectl installed',
      passed: false,
      message: 'kubectl not found - install with: brew install kubectl',
    };
  }
}

async function checkKubeconfigExists(): Promise<CheckResult> {
  try {
    await access(resolve(process.cwd(), 'kubeconfig'));
    return { name: 'kubeconfig exists', passed: true };
  } catch {
    return {
      name: 'kubeconfig exists',
      passed: false,
      message: 'kubeconfig file not found in project root',
    };
  }
}

async function checkKubesealInstalled(): Promise<CheckResult> {
  try {
    await execAsync('kubeseal --version');
    return { name: 'kubeseal installed', passed: true };
  } catch {
    return {
      name: 'kubeseal installed',
      passed: false,
      message: 'kubeseal not found - install with: brew install kubeseal',
    };
  }
}

async function checkSealedSecretsCert(): Promise<CheckResult> {
  try {
    await access(resolve(process.cwd(), 'sealed-secrets-cert.pem'));
    return { name: 'sealed-secrets cert exists', passed: true };
  } catch {
    return {
      name: 'sealed-secrets cert exists',
      passed: false,
      message: 'sealed-secrets-cert.pem not found - run bootstrap script first',
    };
  }
}

async function checkEnvProdExists(): Promise<CheckResult> {
  try {
    await access(resolve(process.cwd(), '.env.prod'));
    return { name: '.env.prod exists', passed: true };
  } catch {
    return {
      name: '.env.prod exists',
      passed: false,
      message: '.env.prod file not found - create from .env.example',
    };
  }
}

async function checkK8sManifests(): Promise<CheckResult> {
  try {
    const { stdout } = await execAsync('kubectl apply -k k8s/overlays/production --dry-run=client');

    if (stdout.includes('error') || stdout.includes('Error')) {
      return {
        name: 'K8s manifests valid',
        passed: false,
        message: 'Manifest validation failed',
      };
    }

    return { name: 'K8s manifests valid', passed: true };
  } catch (error) {
    return {
      name: 'K8s manifests valid',
      passed: false,
      message: error instanceof Error ? error.message : 'Validation failed',
    };
  }
}

async function checkDockerImageBuildable(): Promise<CheckResult> {
  try {
    // Check if Dockerfile exists
    await access(resolve(process.cwd(), 'apps/worker/Dockerfile'));
    return {
      name: 'Worker Dockerfile exists',
      passed: true,
    };
  } catch {
    return {
      name: 'Worker Dockerfile exists',
      passed: false,
      message: 'apps/worker/Dockerfile not found',
    };
  }
}

async function main() {
  console.log('');
  console.log(`${colors.bold}${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}  Deployment Pre-Flight Checks${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  const checks: CheckResult[] = [];

  // Run all checks
  console.log('  Running checks...\n');

  checks.push(await checkKubectlInstalled());
  checks.push(await checkKubesealInstalled());
  checks.push(await checkKubeconfigExists());
  checks.push(await checkSealedSecretsCert());
  checks.push(await checkEnvProdExists());
  checks.push(await checkDockerImageBuildable());
  checks.push(await checkK8sManifests());

  // Display results
  for (const check of checks) {
    if (check.passed) {
      console.log(`  ${colors.green}✓${colors.reset} ${check.name}`);
    } else {
      console.log(`  ${colors.red}✗${colors.reset} ${check.name}`);
      if (check.message) {
        console.log(`    ${colors.yellow}→${colors.reset} ${check.message}`);
      }
    }
  }

  console.log('');

  const allPassed = checks.every((c) => c.passed);

  if (allPassed) {
    console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}${colors.green}  ✓ All checks passed - Ready to deploy!${colors.reset}`);
    console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
    console.log(`  ${colors.bold}Next steps:${colors.reset}`);
    console.log(`    1. ${colors.cyan}./scripts/seal-secrets.sh${colors.reset}  - Encrypt secrets`);
    console.log(`    2. ${colors.cyan}git add k8s/base/*/sealed-*.yaml${colors.reset}`);
    console.log(`    3. ${colors.cyan}git commit -m "Deploy: <description>"${colors.reset}`);
    console.log(`    4. ${colors.cyan}git push origin main${colors.reset}  - Auto-deploys via GitHub Actions`);
    console.log('');
    process.exit(0);
  } else {
    console.log(`${colors.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}${colors.red}  ✗ Some checks failed - Fix issues before deploying${colors.reset}`);
    console.log(`${colors.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error running deployment checks:', error);
  process.exit(1);
});
