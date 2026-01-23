import { defineConfig } from "vitest/config";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.test before config is processed
const envPath = resolve(__dirname, ".env.test");
const envContent = readFileSync(envPath, "utf-8");
envContent.split("\n").forEach((line) => {
  const [key, ...valueParts] = line.split("=");
  if (key && !key.startsWith("#")) {
    const value = valueParts.join("=").replace(/^["']|["']$/g, "");
    process.env[key] = value;
  }
});

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Only run unit tests (fast, no external dependencies)
    include: ["src/__tests__/unit/**/*.test.ts"],
    exclude: [
      "src/__tests__/integration/**",
      "src/__tests__/e2e/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
    },
  },
});
