/**
 * Global test setup
 * Automatically starts Docker infrastructure, runs tests, then cleans up
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { resolve } from "path";

let workerProcess: ChildProcess | null = null;
const WORKER_PORT = process.env.TEST_WORKER_PORT || "3001";
const WORKER_URL = `http://localhost:${WORKER_PORT}`;

// Get the worker directory path
const WORKER_DIR = resolve(import.meta.dirname, "..");
const DOCKER_COMPOSE_FILE = resolve(WORKER_DIR, "docker-compose.test.yml");

/**
 * Execute shell command synchronously
 */
function exec(command: string, silent = false): void {
  if (!silent) {
    console.log(`  $ ${command}`);
  }
  try {
    execSync(command, {
      stdio: silent ? "pipe" : "inherit",
      cwd: WORKER_DIR,
    });
  } catch (error) {
    if (!silent) {
      throw error;
    }
  }
}

/**
 * Wait for a service to be available
 */
async function waitForService(
  name: string,
  checkFn: () => Promise<boolean>,
  timeout = 30000
): Promise<void> {
  const start = Date.now();
  process.stdout.write(`  Waiting for ${name}...`);

  while (Date.now() - start < timeout) {
    try {
      const ready = await checkFn();
      if (ready) {
        console.log(" ✓");
        return;
      }
    } catch (error) {
      // Service not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log(" ✗");
  throw new Error(`${name} failed to start within ${timeout}ms`);
}

/**
 * Start Docker infrastructure
 */
async function startInfrastructure(): Promise<void> {
  console.log("Starting Docker infrastructure...");

  // Set environment variables for database connection
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/batchsender_test";
  process.env.NATS_CLUSTER = "localhost:4222";
  process.env.CLICKHOUSE_URL = "http://localhost:8124";
  process.env.CLICKHOUSE_USER = "test";
  process.env.CLICKHOUSE_PASSWORD = "test";
  process.env.CLICKHOUSE_DATABASE = "batchsender_test";
  process.env.DRAGONFLY_URL = "localhost:6380"; // Test Dragonfly instance
  process.env.DRAGONFLY_CRITICAL_URL = "localhost:6380"; // Use same test instance
  process.env.DRAGONFLY_AUXILIARY_URL = "localhost:6380"; // Use same test instance
  process.env.WEBHOOK_SECRET = "test-webhook-secret";
  process.env.DISABLE_RATE_LIMIT = "true"; // Disable rate limiting for E2E tests

  // Stop any existing services
  console.log("  Cleaning up existing services...");
  exec(`docker compose -f ${DOCKER_COMPOSE_FILE} down -v`, true);

  // Start services
  console.log("  Starting services...");
  exec(`docker compose -f ${DOCKER_COMPOSE_FILE} up -d`);

  // Wait a bit for containers to initialize
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Wait for services to be ready
  await waitForService("NATS", async () => {
    try {
      const response = await fetch("http://localhost:8223/healthz");
      return response.ok;
    } catch {
      return false;
    }
  }, 45000); // 45 seconds timeout

  await waitForService("PostgreSQL", async () => {
    try {
      execSync(
        `docker exec batchsender-test-postgres pg_isready -U test`,
        { stdio: "pipe" }
      );
      return true;
    } catch {
      return false;
    }
  }, 45000); // 45 seconds timeout

  await waitForService("ClickHouse", async () => {
    try {
      const response = await fetch("http://localhost:8124/ping");
      return response.ok;
    } catch {
      return false;
    }
  }, 45000); // 45 seconds timeout

  await waitForService("Dragonfly", async () => {
    try {
      execSync(
        `docker exec batchsender-test-dragonfly redis-cli ping`,
        { stdio: "pipe" }
      );
      return true;
    } catch {
      return false;
    }
  }, 45000); // 45 seconds timeout

  console.log("✓ Infrastructure ready\n");

  // Initialize database schema
  console.log("Initializing database schema...");
  exec(`cd ${resolve(WORKER_DIR, "..", "..", "packages", "db")} && pnpm db:push`);
  console.log("✓ Database schema ready\n");

  // Initialize ClickHouse schema
  console.log("Initializing ClickHouse schema...");
  const clickhouseSchemaFile = resolve(WORKER_DIR, "test", "clickhouse-schema.sql");
  exec(`cat ${clickhouseSchemaFile} | docker exec -i batchsender-test-clickhouse clickhouse-client --user test --password test --database batchsender_test`);
  console.log("✓ ClickHouse schema ready\n");
}

/**
 * Stop Docker infrastructure
 */
async function stopInfrastructure(): Promise<void> {
  console.log("Stopping Docker infrastructure...");
  exec(`docker compose -f ${DOCKER_COMPOSE_FILE} down -v`);
  console.log("✓ Infrastructure stopped\n");
}

/**
 * Start the worker process
 */
async function startWorker(): Promise<void> {
  console.log("Starting worker process...");

  workerProcess = spawn("tsx", ["src/index.ts"], {
    env: {
      ...process.env,
      // IMPORTANT: Always use mock email provider in tests
      EMAIL_PROVIDER: "mock",
      NODE_ENV: "test",
      PORT: WORKER_PORT,
      LOG_LEVEL: "error",
      DATABASE_URL: process.env.DATABASE_URL,
      NATS_CLUSTER: "localhost:4222",
      CLICKHOUSE_URL: "http://localhost:8124",
      CLICKHOUSE_USER: "test",
      CLICKHOUSE_PASSWORD: "test",
      CLICKHOUSE_DATABASE: "batchsender_test",
      CLICKHOUSE_FLUSH_INTERVAL_MS: "500", // Fast flush for tests (default is 5000ms)
      DRAGONFLY_URL: "localhost:6380", // Test Dragonfly instance
      DRAGONFLY_CRITICAL_URL: "localhost:6380", // Use same test instance
      DRAGONFLY_AUXILIARY_URL: "localhost:6380", // Use same test instance
      WEBHOOK_SECRET: "test-webhook-secret",
      DISABLE_RATE_LIMIT: "true", // Disable rate limiting for E2E tests
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: WORKER_DIR,
  });

  // Capture worker output for debugging
  workerProcess.stdout?.on("data", (data) => {
    if (process.env.DEBUG_WORKER) {
      console.log(`[Worker]: ${data}`);
    }
  });

  workerProcess.stderr?.on("data", (data) => {
    if (process.env.DEBUG_WORKER) {
      console.error(`[Worker Error]: ${data}`);
    }
  });

  workerProcess.on("error", (error) => {
    console.error("Worker process error:", error);
  });

  // Wait for worker to be ready
  await waitForService("Worker", async () => {
    try {
      const response = await fetch(`${WORKER_URL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  });

  console.log("✓ Worker ready\n");
}

/**
 * Stop the worker process
 */
async function stopWorker(): Promise<void> {
  if (workerProcess) {
    console.log("Stopping worker...");
    workerProcess.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        workerProcess?.kill("SIGKILL");
        resolve();
      }, 5000);

      workerProcess?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    workerProcess = null;
    console.log("✓ Worker stopped\n");
  }
}

/**
 * Global setup - runs once before all tests
 */
export async function setup() {
  console.log("\n========================================");
  console.log("  E2E Test Environment Setup");
  console.log("========================================\n");

  try {
    // Start Docker infrastructure
    await startInfrastructure();

    // Start worker
    await startWorker();

    console.log("========================================");
    console.log("  ✓ Environment Ready - Running Tests");
    console.log("========================================\n");
  } catch (error) {
    console.error("\n✗ Setup failed:", error);
    await teardown();
    throw error;
  }
}

/**
 * Global teardown - runs once after all tests
 */
export async function teardown() {
  console.log("\n========================================");
  console.log("  E2E Test Environment Cleanup");
  console.log("========================================\n");

  // Stop worker
  await stopWorker();

  // Stop infrastructure
  await stopInfrastructure();

  console.log("========================================");
  console.log("  ✓ Cleanup Complete");
  console.log("========================================\n");
}
