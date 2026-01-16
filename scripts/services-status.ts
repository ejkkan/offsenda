#!/usr/bin/env node

import { getBatchSenderContainers, getK8sPods, canConnectToK8s } from './lib/service-manager.js';
import { isHealthy } from './lib/health-checker.js';

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

interface ServiceStatus {
  name: string;
  url: string;
  status: 'up' | 'down' | 'unknown';
  mode?: 'Docker' | 'K8s';
}

async function checkServices(): Promise<ServiceStatus[]> {
  const services: ServiceStatus[] = [];

  // Check Docker containers
  const containers = await getBatchSenderContainers();

  // Map containers to services
  const containerServiceMap: Record<string, string> = {
    'batchsender-nats': 'http://localhost:8222/healthz',
    'batchsender-clickhouse': 'http://localhost:8123/ping',
    'batchsender-postgres': 'localhost:5455',
    'batchsender-dragonfly': 'localhost:6379',
    'batchsender-worker': 'http://localhost:6001/health',
    'prometheus': 'http://localhost:9095/-/healthy',
    'grafana': 'http://localhost:3003/api/health',
  };

  // Check common services
  const commonServices = [
    { name: '🌐 Web App', url: 'http://localhost:5001', checkHealth: true },
    { name: '⚙️  Worker API', url: 'http://localhost:6001', checkHealth: true },
    { name: '📨 NATS', url: 'http://localhost:8222', checkHealth: true },
    { name: '📊 ClickHouse', url: 'http://localhost:8123', checkHealth: true },
    { name: '🗄️  PostgreSQL', url: 'localhost:5455', checkHealth: false },
    { name: '🔴 Dragonfly', url: 'localhost:6379', checkHealth: false },
  ];

  for (const service of commonServices) {
    let status: 'up' | 'down' | 'unknown' = 'unknown';

    if (service.checkHealth && service.url.startsWith('http')) {
      const healthy = await isHealthy(service.url);
      status = healthy ? 'up' : 'down';
    } else {
      // For non-HTTP services, check if container exists
      const containerName = service.name.toLowerCase().replace(/[^\w]/g, '');
      const container = containers.find((c) => c.name.includes(containerName) || c.name.includes(service.name.toLowerCase().split(' ')[1]));
      status = container ? 'up' : 'down';
    }

    services.push({
      name: service.name,
      url: service.url,
      status,
      mode: 'Docker',
    });
  }

  // Check K8s services if cluster is available
  const k8sAvailable = await canConnectToK8s();
  if (k8sAvailable) {
    const pods = await getK8sPods();
    if (pods.length > 0) {
      // Update worker status to K8s if pod exists
      const workerPod = pods.find((p) => p.name.includes('worker'));
      if (workerPod) {
        const workerService = services.find((s) => s.name.includes('Worker'));
        if (workerService) {
          workerService.mode = 'K8s';
          workerService.status = workerPod.status === 'Running' ? 'up' : 'down';
        }
      }
    }
  }

  return services;
}

async function main() {
  console.log('');
  console.log(`${colors.bold}╔══════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bold}║           BatchSender Service Status                     ║${colors.reset}`);
  console.log(`${colors.bold}╚══════════════════════════════════════════════════════════╝${colors.reset}`);
  console.log('');

  const services = await checkServices();

  console.log(`${colors.bold}Core Services:${colors.reset}`);
  console.log('┌────────────────────┬──────────────────────────┬─────────┬──────────┐');
  console.log('│ Service            │ URL/Host                 │ Status  │ Mode     │');
  console.log('├────────────────────┼──────────────────────────┼─────────┼──────────┤');

  for (const service of services) {
    const statusIcon = service.status === 'up' ? `${colors.green}✓ UP${colors.reset}` :
                       service.status === 'down' ? `${colors.red}✗ DOWN${colors.reset}` :
                       `${colors.yellow}? UNKNOWN${colors.reset}`;

    const mode = service.mode || '-';

    // Pad strings to align columns
    const namePad = service.name.padEnd(18);
    const urlPad = service.url.padEnd(24);
    const modePad = mode.padEnd(8);

    // Remove ANSI codes for length calculation
    const statusPad = statusIcon;

    console.log(`│ ${namePad} │ ${urlPad} │ ${statusPad} │ ${modePad} │`);
  }

  console.log('└────────────────────┴──────────────────────────┴─────────┴──────────┘');
  console.log('');

  // Check for monitoring stack
  const containers = await getBatchSenderContainers();
  const prometheusRunning = containers.some((c) => c.name.includes('prometheus'));
  const grafanaRunning = containers.some((c) => c.name.includes('grafana'));

  if (prometheusRunning || grafanaRunning) {
    console.log(`${colors.bold}Monitoring Stack:${colors.reset}`);
    console.log('┌────────────────────┬──────────────────────────────────┐');
    if (prometheusRunning) {
      console.log(`│ ${colors.cyan}📈 Prometheus${colors.reset}      │ http://localhost:9095            │`);
    }
    if (grafanaRunning) {
      console.log(`│ ${colors.cyan}📊 Grafana${colors.reset}         │ http://localhost:3003            │`);
    }
    console.log('└────────────────────┴──────────────────────────────────┘');
    console.log('');
  } else {
    console.log(`${colors.yellow}Monitoring: [Not started]${colors.reset}`);
    console.log(`  → ${colors.cyan}pnpm monitoring:start${colors.reset} to enable`);
    console.log('');
  }

  // Show quick actions
  console.log(`${colors.bold}Quick Actions:${colors.reset}`);
  console.log(`  • ${colors.cyan}pnpm dev${colors.reset}              - Start development server`);
  console.log(`  • ${colors.cyan}pnpm services:stop${colors.reset}    - Stop all services`);
  console.log(`  • ${colors.cyan}pnpm monitoring:start${colors.reset} - Start monitoring stack`);
  console.log('');
}

main().catch((error) => {
  console.error('Error checking service status:', error);
  process.exit(1);
});
