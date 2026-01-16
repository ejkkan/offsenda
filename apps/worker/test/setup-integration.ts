/**
 * Integration Test Setup
 * Automatically starts required Docker infrastructure for integration tests
 */

import { execSync } from "child_process";
import { resolve } from "path";

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
 * Global setup - runs once before all integration tests
 */
export async function setup() {
  console.log("\n========================================");
  console.log("  Integration Test Setup");
  console.log("========================================\n");

  try {
    // Set environment variables
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/batchsender_test";
    process.env.CLICKHOUSE_URL = "http://localhost:8124";
    process.env.CLICKHOUSE_USER = "test";
    process.env.CLICKHOUSE_PASSWORD = "test";
    process.env.CLICKHOUSE_DATABASE = "batchsender_test";

    // IMPORTANT: Always use mock email provider in tests
    process.env.EMAIL_PROVIDER = "mock";
    process.env.NODE_ENV = "test";

    // Clean up any existing services
    console.log("  Cleaning up existing services...");
    exec(`docker compose -f ${DOCKER_COMPOSE_FILE} down -v`, true);

    // Start only required services (postgres, clickhouse)
    console.log("  Starting infrastructure...");
    exec(`docker compose -f ${DOCKER_COMPOSE_FILE} up -d postgres clickhouse`);

    // Wait for services
    await new Promise(resolve => setTimeout(resolve, 3000));

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
    }, 45000);

    await waitForService("ClickHouse", async () => {
      try {
        const response = await fetch("http://localhost:8124/ping");
        return response.ok;
      } catch {
        return false;
      }
    }, 45000);

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

    console.log("========================================");
    console.log("  ✓ Ready - Running Integration Tests");
    console.log("========================================\n");
  } catch (error) {
    console.error("\n✗ Setup failed:", error);
    await teardown();
    throw error;
  }
}

/**
 * Global teardown - runs once after all integration tests
 */
export async function teardown() {
  console.log("\n========================================");
  console.log("  Integration Test Cleanup");
  console.log("========================================\n");

  console.log("Stopping infrastructure...");
  exec(`docker compose -f ${DOCKER_COMPOSE_FILE} down -v`);
  console.log("✓ Infrastructure stopped\n");

  console.log("========================================");
  console.log("  ✓ Cleanup Complete");
  console.log("========================================\n");
}
