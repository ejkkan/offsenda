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
  cyan: '\x1b[36m',
};

async function main() {
  console.log('');
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.cyan}  Starting Monitoring Stack...${colors.reset}`);
  console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  // Start monitoring stack
  console.log(`  ${colors.cyan}→${colors.reset} Starting Prometheus and Grafana...`);

  try {
    await execAsync('docker compose -f docker-compose.monitoring.yml up -d');
  } catch (error) {
    console.log(`${colors.yellow}  ✗ Failed to start monitoring stack${colors.reset}`);
    if (error instanceof Error) {
      console.log(`    ${error.message}`);
    }
    process.exit(1);
  }

  // Wait for services to be ready
  console.log(`  ${colors.cyan}→${colors.reset} Waiting for services to be ready...`);

  let prometheusReady = false;
  let grafanaReady = false;

  for (let i = 0; i < 30; i++) {
    if (!prometheusReady) {
      prometheusReady = await isHealthy('http://localhost:9095/-/healthy');
    }
    if (!grafanaReady) {
      grafanaReady = await isHealthy('http://localhost:3003/api/health');
    }

    if (prometheusReady && grafanaReady) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log('');
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.green}  ✓ Monitoring stack started!${colors.reset}`);
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  if (prometheusReady) {
    console.log(`  ${colors.cyan}📈 Prometheus:${colors.reset}  http://localhost:9095`);
  } else {
    console.log(`  ${colors.yellow}📈 Prometheus:${colors.reset}  Starting... (may take a moment)`);
  }

  if (grafanaReady) {
    console.log(`  ${colors.cyan}📊 Grafana:${colors.reset}     http://localhost:3003`);
    console.log(`    Login: admin / admin`);
  } else {
    console.log(`  ${colors.yellow}📊 Grafana:${colors.reset}     Starting... (may take a moment)`);
  }

  console.log('');
  console.log(`  ${colors.bold}Quick Actions:${colors.reset}`);
  console.log(`    • ${colors.cyan}pnpm monitoring:open${colors.reset}  - Open Grafana in browser`);
  console.log(`    • ${colors.cyan}pnpm monitoring:stop${colors.reset}  - Stop monitoring stack`);
  console.log(`    • ${colors.cyan}pnpm services${colors.reset}         - Check service status`);
  console.log('');
}

main().catch((error) => {
  console.error('Error starting monitoring:', error);
  process.exit(1);
});
