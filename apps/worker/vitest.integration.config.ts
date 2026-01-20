import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Only run integration tests
    include: ["src/__tests__/integration/**/*.test.ts"],
    // Exclude E2E tests
    exclude: ["src/__tests__/e2e/**/*.test.ts", "**/*.example.ts", "**/node_modules/**"],
    // Run tests serially to avoid database conflicts
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Reasonable timeout for integration tests
    testTimeout: 30000, // 30 seconds per test
    hookTimeout: 60000, // 1 minute for setup/teardown
    // Setup files run BEFORE test collection (sets env vars before imports)
    setupFiles: ["./test/setup-env.ts"],
    // Global setup and teardown (automatically manages Docker)
    globalSetup: "./test/setup-integration.ts",
    // Don't bail on first failure
    bail: 0,
  },
});
