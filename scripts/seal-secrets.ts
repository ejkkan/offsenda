#!/usr/bin/env node

/**
 * Sealed Secrets Generator
 * Encrypts production secrets for safe storage in Git
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
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

interface EnvSecrets {
  DATABASE_URL: string;
  RESEND_API_KEY: string;
  WEBHOOK_SECRET: string;
  CLICKHOUSE_PASSWORD: string;
  CLICKHOUSE_USER: string;
  CLICKHOUSE_DATABASE: string;
  B2_KEY_ID: string;
  B2_APP_KEY: string;
  B2_BUCKET: string;
  NEXTAUTH_SECRET: string;
  GRAFANA_ADMIN_PASSWORD: string;
  PROMETHEUS_ADMIN_PASSWORD: string;
}

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
 * Check all prerequisites
 */
async function checkPrerequisites(): Promise<void> {
  console.log(`${colors.cyan}→${colors.reset} Checking prerequisites...`);

  // Check kubeseal
  if (!(await commandExists('kubeseal'))) {
    console.error(`${colors.red}✗ kubeseal not found${colors.reset}`);
    console.log(`  Install: ${colors.cyan}brew install kubeseal${colors.reset}`);
    process.exit(1);
  }

  // Check .env.prod
  if (!existsSync('.env.prod')) {
    console.error(`${colors.red}✗ .env.prod file not found${colors.reset}`);
    console.log('');
    console.log('  Create .env.prod with your production secrets:');
    console.log(`  ${colors.cyan}cp .env.example .env.prod${colors.reset}`);
    console.log('');
    console.log('  Required variables:');
    console.log('  - DATABASE_URL');
    console.log('  - RESEND_API_KEY');
    console.log('  - WEBHOOK_SECRET');
    console.log('  - CLICKHOUSE_PASSWORD');
    console.log('  - CLICKHOUSE_USER');
    console.log('  - CLICKHOUSE_DATABASE');
    console.log('  - B2_KEY_ID');
    console.log('  - B2_APP_KEY');
    console.log('  - B2_BUCKET');
    console.log('  - NEXTAUTH_SECRET');
    console.log('  - GRAFANA_ADMIN_PASSWORD');
    console.log('  - PROMETHEUS_ADMIN_PASSWORD');
    console.log('');
    process.exit(1);
  }

  // Check sealed-secrets-cert.pem
  if (!existsSync('sealed-secrets-cert.pem')) {
    console.error(`${colors.red}✗ sealed-secrets-cert.pem not found${colors.reset}`);
    console.log(`  Run bootstrap first: ${colors.cyan}pnpm cluster:bootstrap${colors.reset}`);
    process.exit(1);
  }

  console.log(`${colors.green}✓${colors.reset} All prerequisites met`);
}

/**
 * Load and parse .env.prod
 */
function loadEnvProd(): Partial<EnvSecrets> {
  console.log(`${colors.cyan}→${colors.reset} Loading secrets from .env.prod...`);

  const envPath = resolve(process.cwd(), '.env.prod');
  const content = readFileSync(envPath, 'utf-8');

  const secrets: Partial<EnvSecrets> = {};

  // Parse environment file
  content.split('\n').forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;

    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').replace(/^["']|["']$/g, '');
      (secrets as any)[key] = value;
    }
  });

  return secrets;
}

/**
 * Validate required secrets
 */
function validateSecrets(secrets: Partial<EnvSecrets>): EnvSecrets {
  const requiredVars: (keyof EnvSecrets)[] = [
    'DATABASE_URL',
    'RESEND_API_KEY',
    'WEBHOOK_SECRET',
    'CLICKHOUSE_PASSWORD',
    'CLICKHOUSE_USER',
    'CLICKHOUSE_DATABASE',
    'B2_KEY_ID',
    'B2_APP_KEY',
    'B2_BUCKET',
    'NEXTAUTH_SECRET',
    'GRAFANA_ADMIN_PASSWORD',
    'PROMETHEUS_ADMIN_PASSWORD',
  ];

  const missing: string[] = [];

  for (const varName of requiredVars) {
    if (!secrets[varName]) {
      console.error(`${colors.red}✗ Missing: ${varName}${colors.reset}`);
      missing.push(varName);
    }
  }

  if (missing.length > 0) {
    console.log('');
    console.error(`${colors.red}✗ Found ${missing.length} missing variables in .env.prod${colors.reset}`);
    process.exit(1);
  }

  console.log(`${colors.green}✓${colors.reset} All required variables present`);
  return secrets as EnvSecrets;
}

/**
 * Create kubernetes directories
 */
function createDirectories(): void {
  const dirs = [
    'k8s/base/worker',
    'k8s/base/clickhouse',
    'k8s/base/web',
    'k8s/monitoring',
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Generate htpasswd hash for basic auth
 */
async function generateHtpasswd(username: string, password: string): Promise<string> {
  // Use openssl to generate apr1 hash (compatible with nginx basic auth)
  const { stdout } = await execAsync(
    `openssl passwd -apr1 "${password.replace(/"/g, '\\"')}"`
  );
  return `${username}:${stdout.trim()}`;
}

/**
 * Seal a secret with kubeseal
 */
async function sealSecret(
  name: string,
  namespace: string,
  literals: Record<string, string>,
  outputPath: string
): Promise<void> {
  // Build kubectl command
  const literalArgs = Object.entries(literals)
    .map(([key, value]) => `--from-literal=${key}="${value.replace(/"/g, '\\"')}"`)
    .join(' ');

  const command = `kubectl create secret generic ${name} ${literalArgs} --namespace=${namespace} --dry-run=client -o yaml | kubeseal --cert=sealed-secrets-cert.pem -o yaml > ${outputPath}`;

  await execAsync(command);
}

/**
 * Encrypt all secrets
 */
async function sealSecrets(secrets: EnvSecrets): Promise<void> {
  console.log('');
  console.log(`${colors.cyan}→${colors.reset} Encrypting worker secrets...`);

  await sealSecret(
    'worker-secrets',
    'batchsender',
    {
      DATABASE_URL: secrets.DATABASE_URL,
      RESEND_API_KEY: secrets.RESEND_API_KEY,
      WEBHOOK_SECRET: secrets.WEBHOOK_SECRET,
      CLICKHOUSE_PASSWORD: secrets.CLICKHOUSE_PASSWORD,
    },
    'k8s/base/worker/sealed-secrets.yaml'
  );

  console.log(`${colors.green}✓${colors.reset} Created: k8s/base/worker/sealed-secrets.yaml`);

  console.log(`${colors.cyan}→${colors.reset} Encrypting ClickHouse secrets...`);

  await sealSecret(
    'clickhouse-secrets',
    'batchsender',
    {
      password: secrets.CLICKHOUSE_PASSWORD,
      user: secrets.CLICKHOUSE_USER,
      database: secrets.CLICKHOUSE_DATABASE,
    },
    'k8s/base/clickhouse/sealed-secrets.yaml'
  );

  console.log(`${colors.green}✓${colors.reset} Created: k8s/base/clickhouse/sealed-secrets.yaml`);

  console.log(`${colors.cyan}→${colors.reset} Encrypting Backblaze B2 secrets...`);

  await sealSecret(
    'clickhouse-b2-secret',
    'batchsender',
    {
      B2_KEY_ID: secrets.B2_KEY_ID,
      B2_APP_KEY: secrets.B2_APP_KEY,
      B2_BUCKET: secrets.B2_BUCKET,
    },
    'k8s/base/clickhouse/sealed-b2-secret.yaml'
  );

  console.log(`${colors.green}✓${colors.reset} Created: k8s/base/clickhouse/sealed-b2-secret.yaml`);

  console.log(`${colors.cyan}→${colors.reset} Encrypting Web App secrets...`);

  await sealSecret(
    'web-secrets',
    'batchsender',
    {
      DATABASE_URL: secrets.DATABASE_URL,
      NEXTAUTH_SECRET: secrets.NEXTAUTH_SECRET,
    },
    'k8s/base/web/sealed-secrets.yaml'
  );

  console.log(`${colors.green}✓${colors.reset} Created: k8s/base/web/sealed-secrets.yaml`);

  console.log(`${colors.cyan}→${colors.reset} Encrypting Grafana secrets...`);

  await sealSecret(
    'grafana-secret',
    'batchsender',
    {
      'admin-password': secrets.GRAFANA_ADMIN_PASSWORD,
    },
    'k8s/monitoring/sealed-grafana-secret.yaml'
  );

  console.log(`${colors.green}✓${colors.reset} Created: k8s/monitoring/sealed-grafana-secret.yaml`);

  console.log(`${colors.cyan}→${colors.reset} Encrypting Prometheus secrets...`);

  // Generate htpasswd format for Prometheus basic auth
  const prometheusAuth = await generateHtpasswd('admin', secrets.PROMETHEUS_ADMIN_PASSWORD);

  await sealSecret(
    'prometheus-basic-auth',
    'batchsender',
    {
      auth: prometheusAuth,
    },
    'k8s/monitoring/sealed-prometheus-auth.yaml'
  );

  console.log(`${colors.green}✓${colors.reset} Created: k8s/monitoring/sealed-prometheus-auth.yaml`);
}

/**
 * Show summary and next steps
 */
function showSummary(): void {
  console.log('');
  console.log(`${colors.bold}${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.green}✓ All secrets encrypted successfully!${colors.reset}`);
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');
  console.log(`${colors.bold}Generated files:${colors.reset}`);
  console.log('  • k8s/base/worker/sealed-secrets.yaml');
  console.log('  • k8s/base/clickhouse/sealed-secrets.yaml');
  console.log('  • k8s/base/clickhouse/sealed-b2-secret.yaml');
  console.log('  • k8s/base/web/sealed-secrets.yaml');
  console.log('  • k8s/monitoring/sealed-grafana-secret.yaml');
  console.log('  • k8s/monitoring/sealed-prometheus-auth.yaml');
  console.log('');
  console.log(`${colors.bold}${colors.cyan}Next steps:${colors.reset}`);
  console.log('  1. Review the generated files (they\'re encrypted and safe to commit)');
  console.log('  2. Commit to git:');
  console.log(`     ${colors.cyan}git add k8s/base/*/sealed-*.yaml${colors.reset}`);
  console.log(`     ${colors.cyan}git commit -m 'Add encrypted production secrets'${colors.reset}`);
  console.log('  3. Push to GitHub:');
  console.log(`     ${colors.cyan}git push origin main${colors.reset}`);
  console.log('  4. Deploy to production:');
  console.log(`     ${colors.cyan}kubectl apply -k k8s/overlays/production${colors.reset}`);
  console.log('');
  console.log(`${colors.yellow}⚠️  Important: Never commit .env.prod to git!${colors.reset}`);
  console.log('  Add it to .gitignore if not already present.');
  console.log('');
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('');
  console.log(`${colors.bold}${colors.cyan}🔒 BatchSender Sealed Secrets Generator${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  try {
    await checkPrerequisites();
    const secrets = loadEnvProd();
    const validatedSecrets = validateSecrets(secrets);
    console.log('');
    createDirectories();
    await sealSecrets(validatedSecrets);
    showSummary();
  } catch (error) {
    console.error('');
    console.error(`${colors.red}✗ Error:${colors.reset}`, error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
