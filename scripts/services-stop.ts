#!/usr/bin/env node

import { stopAllServices, getBatchSenderContainers } from './lib/service-manager.js';

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
  console.log(`${colors.yellow}  Stopping BatchSender Services...${colors.reset}`);
  console.log(`${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  // Get list of running containers before stopping
  const containersBefore = await getBatchSenderContainers();

  if (containersBefore.length === 0) {
    console.log(`${colors.yellow}  No BatchSender services are currently running.${colors.reset}`);
    console.log('');
    return;
  }

  console.log(`  ${colors.cyan}→${colors.reset} Found ${containersBefore.length} running container(s)...`);
  for (const container of containersBefore) {
    console.log(`    - ${container.name} (${container.status})`);
  }
  console.log('');

  // Stop all services
  console.log(`  ${colors.cyan}→${colors.reset} Stopping Docker Compose services...`);
  await stopAllServices();

  // Also kill any Node.js processes for web/worker
  console.log(`  ${colors.cyan}→${colors.reset} Stopping Node.js processes...`);
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    // Kill web app processes
    await execAsync('pkill -f "pnpm dev" || true').catch(() => {});
    await execAsync('pkill -f "apps/web.*dev" || true').catch(() => {});
    await execAsync('pkill -f "next dev" || true').catch(() => {});

    // Kill worker processes
    await execAsync('pkill -f "tsx.*worker" || true').catch(() => {});
    await execAsync('pkill -f "apps/worker" || true').catch(() => {});
  } catch (error) {
    // Ignore errors - processes might not exist
  }

  // Verify containers stopped
  const containersAfter = await getBatchSenderContainers();

  console.log('');
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}${colors.green}  ✓ All services stopped${colors.reset}`);
  console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  if (containersAfter.length > 0) {
    console.log(`${colors.yellow}  Note: ${containersAfter.length} container(s) still running (may be non-BatchSender):${colors.reset}`);
    for (const container of containersAfter) {
      console.log(`    - ${container.name}`);
    }
    console.log('');
  }

  console.log(`  ${colors.bold}Next steps:${colors.reset}`);
  console.log(`    • ${colors.cyan}pnpm dev${colors.reset}      - Start development server`);
  console.log(`    • ${colors.cyan}pnpm services${colors.reset} - Check service status`);
  console.log('');
}

main().catch((error) => {
  console.error('Error stopping services:', error);
  process.exit(1);
});
