#!/usr/bin/env node

/**
 * ClickHouse Restore Script
 * Restores ClickHouse database from Backblaze B2
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
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

interface RestoreConfig {
  backupName: string;
  b2Endpoint: string;
  b2KeyId: string;
  b2AppKey: string;
}

/**
 * Load environment variables
 */
function loadEnv(): Record<string, string> {
  const envFile = existsSync('.env.prod') ? '.env.prod' : '.env';

  if (!existsSync(envFile)) {
    console.error(`${colors.red}✗ No .env file found${colors.reset}`);
    console.log(`  Create ${colors.cyan}.env.prod${colors.reset} or ${colors.cyan}.env${colors.reset} with required variables`);
    process.exit(1);
  }

  const content = readFileSync(envFile, 'utf-8');
  const env: Record<string, string> = {};

  content.split('\n').forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;

    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      env[key] = valueParts.join('=').replace(/^["']|["']$/g, '');
    }
  });

  return env;
}

/**
 * Get restore configuration
 */
function getRestoreConfig(backupName: string): RestoreConfig {
  const env = loadEnv();

  // Validate required variables
  const required = ['B2_KEY_ID', 'B2_APP_KEY'];
  const missing = required.filter(key => !env[key]);

  if (missing.length > 0) {
    console.error(`${colors.red}✗ Missing required environment variables:${colors.reset}`);
    missing.forEach(key => console.log(`  - ${key}`));
    process.exit(1);
  }

  return {
    backupName,
    b2Endpoint: 'https://s3.eu-central-003.backblazeb2.com/batchsender-clickhouse-cold/backups/',
    b2KeyId: env.B2_KEY_ID,
    b2AppKey: env.B2_APP_KEY,
  };
}

/**
 * Check if running in Docker or Kubernetes
 */
async function getClickHouseCommand(): Promise<string> {
  // Check if batchsender-clickhouse-1 container exists (Docker)
  try {
    await execAsync('docker ps --filter name=batchsender-clickhouse-1 --format "{{.Names}}"');
    return 'docker exec batchsender-clickhouse-1 clickhouse-client';
  } catch {
    // Check if in Kubernetes
    try {
      await execAsync('kubectl get pod -l app=clickhouse -n batchsender');
      const { stdout } = await execAsync('kubectl get pod -l app=clickhouse -n batchsender -o jsonpath=\'{.items[0].metadata.name}\'');
      const podName = stdout.trim();
      return `kubectl exec -n batchsender ${podName} -- clickhouse-client`;
    } catch {
      console.error(`${colors.red}✗ Cannot find ClickHouse container or pod${colors.reset}`);
      console.log('  Make sure ClickHouse is running in Docker or Kubernetes');
      process.exit(1);
    }
  }
}

/**
 * List available backups
 */
async function listBackups(chCommand: string): Promise<void> {
  console.log('');
  console.log(`${colors.bold}Available backups:${colors.reset}`);

  try {
    const query = `SELECT name, status, start_time, formatReadableSize(total_size) as size FROM system.backups ORDER BY start_time DESC LIMIT 10 FORMAT PrettyCompact`;

    const { stdout } = await execAsync(`${chCommand} --query "${query}"`);
    console.log(stdout);
  } catch {
    console.log(`${colors.yellow}No backup history in ClickHouse. Check B2 bucket manually.${colors.reset}`);
  }
  console.log('');
}

/**
 * Confirm restore operation
 */
async function confirmRestore(backupName: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });

  console.log('');
  console.log(`${colors.yellow}⚠️  WARNING: This will restore database from backup: ${backupName}${colors.reset}`);
  console.log(`${colors.yellow}   Existing data may be overwritten!${colors.reset}`);
  console.log('');

  const answer = await rl.question('Are you sure? Type "yes" to confirm: ');
  rl.close();

  return answer.trim().toLowerCase() === 'yes';
}

/**
 * Perform restore
 */
async function performRestore(config: RestoreConfig, chCommand: string): Promise<void> {
  console.log('');
  console.log(`${colors.yellow}Starting restore from: ${config.backupName}${colors.reset}`);
  console.log('');

  const query = `RESTORE DATABASE default FROM S3('${config.b2Endpoint}${config.backupName}/', '${config.b2KeyId}', '${config.b2AppKey}')`;

  await execAsync(`${chCommand} --query "${query}"`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const { positionals } = parseArgs({
    allowPositionals: true,
  });

  const backupName = positionals[0];

  console.log('');
  console.log(`${colors.bold}${colors.cyan}🗄️  ClickHouse Restore${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  try {
    const chCommand = await getClickHouseCommand();

    // If no backup name provided, list available backups and exit
    if (!backupName) {
      console.log('');
      console.log(`${colors.yellow}Usage: pnpm db:restore <backup_name>${colors.reset}`);
      console.log(`${colors.yellow}Example: pnpm db:restore backup_full_20260116_120000${colors.reset}`);

      await listBackups(chCommand);

      process.exit(1);
    }

    // Confirm restore
    const confirmed = await confirmRestore(backupName);

    if (!confirmed) {
      console.log('');
      console.log(`${colors.yellow}Restore cancelled.${colors.reset}`);
      console.log('');
      process.exit(0);
    }

    // Perform restore
    const config = getRestoreConfig(backupName);
    await performRestore(config, chCommand);

    console.log('');
    console.log(`${colors.green}✓ Restore completed from: ${backupName}${colors.reset}`);
    console.log('');
    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
  } catch (error) {
    console.error('');
    console.error(`${colors.red}✗ Restore failed:${colors.reset}`, error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
