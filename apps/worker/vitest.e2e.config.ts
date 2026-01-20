import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Only run E2E tests
    include: ["src/__tests__/e2e/**/*.test.ts"],
    // Exclude example files
    exclude: ["**/*.example.ts", "**/node_modules/**"],
    // Run tests serially to avoid conflicts
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Longer timeout for E2E tests (large batches can take time)
    testTimeout: 300000, // 5 minutes per test
    hookTimeout: 60000, // 1 minute for setup/teardown
    // Setup files run BEFORE test collection (sets env vars before imports)
    setupFiles: ["./test/setup-env.ts"],
    // Global setup and teardown (automatically manages Docker)
    globalSetup: "./test/setup.ts",
    // Don't bail on first failure - run all tests
    bail: 0,
    // Retry failed tests once (flaky network/timing issues)
    retry: 1,
  },
});
