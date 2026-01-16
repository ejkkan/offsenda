import { readFile, access } from 'node:fs/promises';
import { exec, spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectK8sTools,
  detectMode,
  startDockerCompose,
  stopAllServices,
  type DevMode,
} from './service-manager.js';
import { areRequiredPortsAvailable } from './port-checker.js';
import { waitForAllHealthy, HEALTH_CHECKS } from './health-checker.js';

const execAsync = promisify(exec);

export interface DevConfig {
  mode?: 'auto' | 'k8s' | 'docker' | 'simple';
  monitoring?: boolean;
  dryRun?: boolean;
  clean?: boolean;
  verbose?: boolean;
}

interface Colors {
  reset: string;
  bold: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  cyan: string;
}

const colors: Colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

export class DevEnvironment {
  private config: DevConfig;
  private mode: DevMode = 'docker';
  private webProcess?: ChildProcess;
  private workerProcess?: ChildProcess;
  private skaffoldProcess?: ChildProcess;
  private projectRoot: string;

  constructor(config: DevConfig) {
    this.config = config;
    this.projectRoot = process.cwd();

    // Set up cleanup handlers
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }

  async start(): Promise<void> {
    this.showHeader();
    await this.checkPrerequisites();
    await this.selectMode();
    await this.checkPorts();
    await this.startInfrastructure();
    await this.startApplications();
    this.showServiceDashboard();
    await this.streamLogs();
  }

  private showHeader(): void {
    console.clear();
    console.log(`${colors.bold}${colors.blue}`);
    console.log('  ╔══════════════════════════════════════════════════════════╗');
    console.log('  ║                                                          ║');
    console.log('  ║              🚀 BatchSender Development Server           ║');
    console.log('  ║                                                          ║');
    console.log('  ╚══════════════════════════════════════════════════════════╝');
    console.log(colors.reset);
  }

  private async checkPrerequisites(): Promise<void> {
    console.log(`${colors.cyan}  [1/6]${colors.reset} Checking prerequisites...`);

    // Check for .env.dev file
    const envPath = path.join(this.projectRoot, '.env.dev');
    try {
      await access(envPath);
    } catch {
      console.log(`${colors.red}  ✗ .env.dev file not found${colors.reset}`);
      console.log(`    Run: ${colors.cyan}cp .env.example .env.dev${colors.reset} and configure it`);
      process.exit(1);
    }

    // Load environment variables
    const envContent = await readFile(envPath, 'utf-8');
    envContent.split('\n').forEach((line) => {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (match) {
        const [, key, value] = match;
        process.env[key] = value.replace(/^["']|["']$/g, '');
      }
    });

    // Validate required env vars
    if (!process.env.DATABASE_URL) {
      console.log(`${colors.red}  ✗ DATABASE_URL not set in .env.dev${colors.reset}`);
      process.exit(1);
    }

    if (this.config.dryRun) {
      process.env.EMAIL_PROVIDER = 'mock';
      console.log(`${colors.yellow}  ⚡ Mock email provider enabled (dry-run mode)${colors.reset}`);
    }

    console.log(`${colors.green}  ✓${colors.reset} Environment loaded`);
  }

  private async selectMode(): Promise<void> {
    console.log(`${colors.cyan}  [2/6]${colors.reset} Selecting development mode...`);

    if (this.config.mode && this.config.mode !== 'auto') {
      this.mode = this.config.mode as DevMode;
      console.log(`${colors.green}  ✓${colors.reset} Using ${this.mode} mode (forced)`);
      return;
    }

    // Auto-detect mode
    const detectedMode = await detectMode();
    this.mode = detectedMode;

    // Show K8s tools status if in simple/docker mode
    if (this.mode !== 'k8s') {
      const { available, missing } = await detectK8sTools();
      if (!available) {
        console.log(`${colors.yellow}  ℹ K8s tools not installed - using ${this.mode} mode${colors.reset}`);
        if (missing.length > 0 && this.config.verbose) {
          console.log(`    Missing: ${missing.map((t) => t.name).join(', ')}`);
        }
      }
    }

    console.log(`${colors.green}  ✓${colors.reset} Using ${this.mode} mode`);
  }

  private async checkPorts(): Promise<void> {
    console.log(`${colors.cyan}  [3/6]${colors.reset} Checking port availability...`);

    const { available, conflicts } = await areRequiredPortsAvailable();

    if (!available) {
      console.log(`${colors.red}  ✗ Port conflicts detected:${colors.reset}`);
      for (const conflict of conflicts) {
        console.log(`    Port ${conflict.port} (${conflict.service}) is in use`);
        if (conflict.processInfo) {
          console.log(`      ${conflict.processInfo}`);
        }
      }
      console.log('\n  Fix conflicts and try again.');
      process.exit(1);
    }

    console.log(`${colors.green}  ✓${colors.reset} All required ports available`);
  }

  private async startInfrastructure(): Promise<void> {
    console.log(`${colors.cyan}  [4/6]${colors.reset} Starting infrastructure...`);

    if (this.mode === 'k8s') {
      await this.startK8sInfrastructure();
    } else {
      await this.startDockerInfrastructure();
    }

    // Wait for services to be ready
    console.log(`${colors.yellow}  Waiting for services...${colors.reset}`);

    const healthChecks = [HEALTH_CHECKS.nats, HEALTH_CHECKS.clickhouse];

    // PostgreSQL and Dragonfly will retry connection internally, so we don't need to health check them

    const results = await waitForAllHealthy(healthChecks);

    for (const result of results) {
      if (result.healthy) {
        console.log(`${colors.green}  ✓${colors.reset} ${result.service} ready (${result.attempts} attempts)`);
      } else {
        console.log(`${colors.red}  ✗${colors.reset} ${result.service} failed: ${result.error}`);
        process.exit(1);
      }
    }

    // Initialize ClickHouse tables
    await this.initializeClickHouse();

    console.log(`${colors.green}  ✓${colors.reset} Infrastructure ready`);
  }

  private async startDockerInfrastructure(): Promise<void> {
    // Start core infrastructure services (excluding worker/web - we run those locally)
    await startDockerCompose('docker-compose.local.yml', [
      'postgres',
      'nats',
      'clickhouse',
      'dragonfly'
    ]);

    if (this.config.monitoring) {
      await startDockerCompose('docker-compose.monitoring.yml');
    }
  }

  private async startK8sInfrastructure(): Promise<void> {
    // K8s infrastructure startup logic
    // Check if cluster exists, create if needed, install KEDA, etc.
    console.log(`${colors.yellow}  K8s mode infrastructure startup...${colors.reset}`);
    // TODO: Implement K8s cluster setup
  }

  private async initializeClickHouse(): Promise<void> {
    try {
      await execAsync(`docker exec -i batchsender-clickhouse-1 clickhouse-client --password clickhouse <<'EOF'
CREATE DATABASE IF NOT EXISTS batchsender;

CREATE TABLE IF NOT EXISTS batchsender.email_events
(
    event_id UUID DEFAULT generateUUIDv4(),
    event_type Enum8('queued' = 1, 'sent' = 2, 'delivered' = 3, 'opened' = 4, 'clicked' = 5, 'bounced' = 6, 'complained' = 7, 'failed' = 8),
    batch_id UUID,
    recipient_id UUID,
    user_id UUID,
    email String,
    provider_message_id String,
    metadata String DEFAULT '{}',
    error_message String DEFAULT '',
    created_at DateTime DEFAULT now(),
    event_date Date DEFAULT toDate(created_at)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (user_id, batch_id, created_at)
TTL event_date + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS batchsender.email_message_index
(
    provider_message_id String,
    recipient_id UUID,
    batch_id UUID,
    user_id UUID,
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
ORDER BY provider_message_id
TTL created_at + INTERVAL 30 DAY;
EOF`);
    } catch (error) {
      if (this.config.verbose) {
        console.log(`${colors.yellow}  ⚠ ClickHouse initialization: ${error}${colors.reset}`);
      }
    }
  }

  private async startApplications(): Promise<void> {
    console.log(`${colors.cyan}  [5/6]${colors.reset} Starting applications...`);

    // Build db package if needed
    await this.buildDbPackage();

    // Start web app
    const webDir = path.join(this.projectRoot, 'apps/web');
    this.webProcess = spawn('pnpm', ['dev'], {
      cwd: webDir,
      stdio: 'pipe',
      env: process.env,
    });

    // Start worker (mode-dependent)
    if (this.mode === 'k8s') {
      // Use Skaffold
      this.skaffoldProcess = spawn('skaffold', ['dev', '--port-forward'], {
        cwd: this.projectRoot,
        stdio: 'pipe',
        env: process.env,
      });
    } else {
      // Run worker locally
      const workerDir = path.join(this.projectRoot, 'apps/worker');
      this.workerProcess = spawn('npx', ['tsx', 'watch', 'src/index.ts'], {
        cwd: workerDir,
        stdio: 'pipe',
        env: process.env,
      });
    }

    // Wait for apps to be ready
    const appHealthChecks = [HEALTH_CHECKS.web];
    if (this.mode !== 'k8s') {
      appHealthChecks.push(HEALTH_CHECKS.worker);
    }

    const results = await waitForAllHealthy(appHealthChecks);
    for (const result of results) {
      if (result.healthy) {
        console.log(`${colors.green}  ✓${colors.reset} ${result.service} ready`);
      }
    }

    console.log(`${colors.green}  ✓${colors.reset} Applications started`);
  }

  private async buildDbPackage(): Promise<void> {
    const dbDist = path.join(this.projectRoot, 'packages/db/dist');
    try {
      await access(dbDist);
    } catch {
      console.log(`${colors.cyan}  Building @batchsender/db package...${colors.reset}`);
      await execAsync('pnpm --filter=@batchsender/db build', {
        cwd: this.projectRoot,
      });
    }
  }

  private showServiceDashboard(): void {
    console.log('');
    console.log(`${colors.bold}${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}${colors.green}  ✓ All services running!${colors.reset}`);
    console.log(`${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
    console.log(`  ${colors.bold}Services:${colors.reset}`);
    console.log('  ┌────────────────────┬─────────────────────────────────┐');
    console.log(`  │ ${colors.cyan}🌐 Web App${colors.reset}         │ http://localhost:5001           │`);
    console.log(`  │ ${colors.cyan}⚙️  Worker API${colors.reset}      │ http://localhost:6001           │`);
    console.log(`  │ ${colors.cyan}📨 NATS Monitor${colors.reset}    │ http://localhost:8222           │`);
    console.log(`  │ ${colors.cyan}📊 ClickHouse${colors.reset}      │ http://localhost:8123           │`);
    console.log('  └────────────────────┴─────────────────────────────────┘');
    console.log('');
    console.log(`  ${colors.bold}Press Ctrl+C to stop all services${colors.reset}`);
    console.log('');
    console.log(`${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
    console.log(`  ${colors.bold}Live logs:${colors.reset}`);
    console.log('');
  }

  private async streamLogs(): Promise<void> {
    // Stream logs from web and worker processes
    if (this.webProcess?.stdout) {
      this.webProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach((line: string) => {
          if (line.trim()) {
            console.log(`${colors.cyan}[web]${colors.reset} ${line}`);
          }
        });
      });
    }

    if (this.workerProcess?.stdout) {
      this.workerProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach((line: string) => {
          if (line.trim()) {
            console.log(`${colors.green}[worker]${colors.reset} ${line}`);
          }
        });
      });
    }

    if (this.skaffoldProcess?.stdout) {
      this.skaffoldProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach((line: string) => {
          if (line.trim()) {
            console.log(`${colors.green}[k8s]${colors.reset} ${line}`);
          }
        });
      });
    }

    // Keep process alive
    await new Promise(() => {});
  }

  private async cleanup(): Promise<void> {
    console.log('');
    console.log(`${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.yellow}  Shutting down...${colors.reset}`);
    console.log(`${colors.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);

    // Kill application processes
    if (this.webProcess) {
      console.log(`  ${colors.cyan}→${colors.reset} Stopping web app...`);
      this.webProcess.kill('SIGTERM');
    }

    if (this.workerProcess) {
      console.log(`  ${colors.cyan}→${colors.reset} Stopping worker...`);
      this.workerProcess.kill('SIGTERM');
    }

    if (this.skaffoldProcess) {
      console.log(`  ${colors.cyan}→${colors.reset} Stopping skaffold...`);
      this.skaffoldProcess.kill('SIGTERM');
    }

    // Stop Docker services
    console.log(`  ${colors.cyan}→${colors.reset} Stopping Docker services...`);
    await stopAllServices();

    console.log('');
    console.log(`${colors.green}  ✓ All services stopped${colors.reset}`);
    console.log('');

    process.exit(0);
  }
}
