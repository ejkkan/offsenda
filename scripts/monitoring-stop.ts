#!/usr/bin/env node

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

async function main() {
  console.log('');
  console.log(`${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.yellow}  Stopping Monitoring Stack...${colors.reset}`);
  console.log(`${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  console.log(`  ${colors.cyan}→${colors.reset} Stopping Prometheus and Grafana...`);

  try {
    await execAsync('docker compose -f docker-compose.monitoring.yml down');
  } catch (error) {
    console.log(`${colors.yellow}  ⚠ Error stopping monitoring stack${colors.reset}`);
    if (error instanceof Error) {
      console.log(`    ${error.message}`);
    }
  }

  console.log('');
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.green}  ✓ Monitoring stack stopped${colors.reset}`);
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');
}

main().catch((error) => {
  console.error('Error stopping monitoring:', error);
  process.exit(1);
});
