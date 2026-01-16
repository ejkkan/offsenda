#!/usr/bin/env node

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { isHealthy } from './lib/health-checker.js';

const execAsync = promisify(exec);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const GRAFANA_URL = 'http://localhost:3003';

async function main() {
  console.log('');
  console.log(`  ${colors.cyan}→${colors.reset} Checking if Grafana is running...`);

  const grafanaRunning = await isHealthy(`${GRAFANA_URL}/api/health`);

  if (!grafanaRunning) {
    console.log('');
    console.log(`  ${colors.red}✗ Grafana is not running${colors.reset}`);
    console.log('');
    console.log(`  Start monitoring with: ${colors.cyan}pnpm monitoring:start${colors.reset}`);
    console.log('');
    process.exit(1);
  }

  console.log(`  ${colors.green}✓${colors.reset} Grafana is running`);
  console.log(`  ${colors.cyan}→${colors.reset} Opening ${GRAFANA_URL} in your browser...`);
  console.log('');

  try {
    // Open in default browser (works on macOS, Linux, and Windows)
    const platform = process.platform;
    let command: string;

    if (platform === 'darwin') {
      command = `open ${GRAFANA_URL}`;
    } else if (platform === 'win32') {
      command = `start ${GRAFANA_URL}`;
    } else {
      // Linux
      command = `xdg-open ${GRAFANA_URL}`;
    }

    await execAsync(command);

    console.log(`  ${colors.bold}Login Credentials:${colors.reset}`);
    console.log(`    Username: admin`);
    console.log(`    Password: admin`);
    console.log('');
    console.log(`  ${colors.yellow}Note:${colors.reset} You may be prompted to change the password on first login.`);
    console.log('');
  } catch (error) {
    console.log(`  ${colors.yellow}⚠ Could not open browser automatically${colors.reset}`);
    console.log(`  ${colors.cyan}→${colors.reset} Please visit: ${colors.bold}${GRAFANA_URL}${colors.reset}`);
    console.log('');
  }
}

main().catch((error) => {
  console.error('Error opening Grafana:', error);
  process.exit(1);
});
