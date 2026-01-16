#!/usr/bin/env node

/**
 * ClickHouse Backup Script
 * Backs up ClickHouse database to Backblaze B2
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

const execAsync = promisify(exec);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

type BackupType = 'full' | 'incremental';

interface BackupConfig {
  type: BackupType;
  b2Endpoint: string;
  b2KeyId: string;
  b2AppKey: string;
  chHost: string;
  chPort: string;
  chUser: string;
  chPassword: string;
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
 * Get backup configuration
 */
function getBackupConfig(type: BackupType): BackupConfig {
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
    type,
    b2Endpoint: 'https://s3.eu-central-003.backblazeb2.com/batchsender-clickhouse-cold/backups/',
    b2KeyId: env.B2_KEY_ID,
    b2AppKey: env.B2_APP_KEY,
    chHost: env.CLICKHOUSE_HOST || 'localhost',
    chPort: env.CLICKHOUSE_PORT || '8123',
    chUser: env.CLICKHOUSE_USER || 'default',
    chPassword: env.CLICKHOUSE_PASSWORD || 'clickhouse',
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
 * Get last full backup name
 */
async function getLastFullBackup(chCommand: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`${chCommand} --query "SELECT name FROM system.backups WHERE name LIKE 'backup_full_%' ORDER BY start_time DESC LIMIT 1"`);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Perform backup
 */
async function performBackup(config: BackupConfig): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + new Date().toISOString().replace(/[:.]/g, '-').split('T')[1].split('.')[0].replace(/-/g, '');
  let backupName = `backup_${config.type}_${timestamp}`;

  const chCommand = await getClickHouseCommand();

  console.log('');
  console.log(`${colors.cyan}→${colors.reset} Backup type: ${config.type}`);
  console.log(`${colors.cyan}→${colors.reset} Destination: B2 (batchsender-clickhouse-cold/backups/)`);
  console.log(`${colors.cyan}→${colors.reset} Backup name: ${backupName}`);
  console.log('');

  if (config.type === 'full') {
    // Full backup
    console.log(`${colors.yellow}Starting full backup...${colors.reset}`);

    const query = `BACKUP DATABASE default TO S3('${config.b2Endpoint}${backupName}/', '${config.b2KeyId}', '${config.b2AppKey}') SETTINGS compression_level=3`;

    await execAsync(`${chCommand} --query "${query}"`);
  } else {
    // Incremental backup
    console.log(`${colors.yellow}Checking for last full backup...${colors.reset}`);
    const lastFull = await getLastFullBackup(chCommand);

    if (!lastFull) {
      console.log(`${colors.yellow}No previous full backup found. Running full backup instead.${colors.reset}`);
      backupName = `backup_full_${timestamp}`;

      const query = `BACKUP DATABASE default TO S3('${config.b2Endpoint}${backupName}/', '${config.b2KeyId}', '${config.b2AppKey}') SETTINGS compression_level=3`;

      await execAsync(`${chCommand} --query "${query}"`);
    } else {
      console.log(`${colors.green}✓${colors.reset} Found base backup: ${lastFull}`);
      console.log(`${colors.yellow}Starting incremental backup...${colors.reset}`);

      const query = `BACKUP DATABASE default TO S3('${config.b2Endpoint}${backupName}/', '${config.b2KeyId}', '${config.b2AppKey}') SETTINGS base_backup = S3('${config.b2Endpoint}${lastFull}/', '${config.b2KeyId}', '${config.b2AppKey}'), compression_level=3`;

      await execAsync(`${chCommand} --query "${query}"`);
    }
  }

  return backupName;
}

/**
 * Show recent backups
 */
async function showRecentBackups(chCommand: string): Promise<void> {
  try {
    console.log('');
    console.log(`${colors.bold}Recent backups:${colors.reset}`);

    const query = `SELECT name, status, start_time, end_time, formatReadableSize(total_size) as size FROM system.backups ORDER BY start_time DESC LIMIT 5 FORMAT PrettyCompact`;

    const { stdout } = await execAsync(`${chCommand} --query "${query}"`);
    console.log(stdout);
  } catch {
    console.log(`${colors.yellow}No backup history available${colors.reset}`);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      type: { type: 'string', default: 'full' },
    },
    allowPositionals: false,
  });

  const backupType = (values.type as BackupType) || 'full';

  if (backupType !== 'full' && backupType !== 'incremental') {
    console.error(`${colors.red}✗ Invalid backup type: ${backupType}${colors.reset}`);
    console.log(`  Valid types: ${colors.cyan}full${colors.reset} or ${colors.cyan}incremental${colors.reset}`);
    process.exit(1);
  }

  console.log('');
  console.log(`${colors.bold}${colors.cyan}🗄️  ClickHouse Backup${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

  try {
    const config = getBackupConfig(backupType);
    const chCommand = await getClickHouseCommand();
    const backupName = await performBackup(config);

    console.log('');
    console.log(`${colors.green}✓ Backup completed: ${backupName}${colors.reset}`);

    await showRecentBackups(chCommand);

    console.log('');
    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
  } catch (error) {
    console.error('');
    console.error(`${colors.red}✗ Backup failed:${colors.reset}`, error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
