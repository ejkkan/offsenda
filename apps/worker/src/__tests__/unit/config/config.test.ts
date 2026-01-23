import { describe, it, expect } from "vitest";
import { configSchema } from "@batchsender/config";

/**
 * Tests for critical config defaults.
 * These ensure production-safe defaults are maintained.
 */
describe("configSchema defaults", () => {
  // Minimum required env vars to parse config
  const requiredEnv = {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    WEBHOOK_SECRET: "test-secret",
  };

  describe("NATS configuration", () => {
    it("should default NATS_REPLICAS to 3 for high availability", () => {
      const config = configSchema.parse(requiredEnv);
      expect(config.NATS_REPLICAS).toBe(3);
    });

    it("should allow NATS_REPLICAS to be overridden", () => {
      const config = configSchema.parse({
        ...requiredEnv,
        NATS_REPLICAS: "5",
      });
      expect(config.NATS_REPLICAS).toBe(5);
    });

    it("should reject NATS_REPLICAS below 1", () => {
      expect(() =>
        configSchema.parse({
          ...requiredEnv,
          NATS_REPLICAS: "0",
        })
      ).toThrow();
    });

    it("should reject NATS_REPLICAS above 5", () => {
      expect(() =>
        configSchema.parse({
          ...requiredEnv,
          NATS_REPLICAS: "7",
        })
      ).toThrow();
    });

    it("should default NATS_CLUSTER to localhost", () => {
      const config = configSchema.parse(requiredEnv);
      expect(config.NATS_CLUSTER).toBe("nats://localhost:4222");
    });

    it("should default NATS_TLS_ENABLED to false", () => {
      const config = configSchema.parse(requiredEnv);
      expect(config.NATS_TLS_ENABLED).toBe(false);
    });
  });

  describe("environment defaults", () => {
    it("should default NODE_ENV to development", () => {
      const config = configSchema.parse(requiredEnv);
      expect(config.NODE_ENV).toBe("development");
    });

    it("should default WORKER_ID to worker-1", () => {
      const config = configSchema.parse(requiredEnv);
      expect(config.WORKER_ID).toBe("worker-1");
    });
  });

  describe("rate limiting defaults", () => {
    it("should default SYSTEM_RATE_LIMIT to 10000", () => {
      const config = configSchema.parse(requiredEnv);
      expect(config.SYSTEM_RATE_LIMIT).toBe(10000);
    });

    it("should default RATE_LIMIT_PER_SECOND to 1000", () => {
      const config = configSchema.parse(requiredEnv);
      expect(config.RATE_LIMIT_PER_SECOND).toBe(1000);
    });
  });

  describe("webhook defaults", () => {
    it("should default WEBHOOK_QUEUE_ENABLED to true", () => {
      const config = configSchema.parse(requiredEnv);
      expect(config.WEBHOOK_QUEUE_ENABLED).toBe(true);
    });

    it("should default WEBHOOK_MAX_RETRIES to 3", () => {
      const config = configSchema.parse(requiredEnv);
      expect(config.WEBHOOK_MAX_RETRIES).toBe(3);
    });
  });

  describe("boolean coercion", () => {
    it("should parse string 'true' as boolean true", () => {
      const config = configSchema.parse({
        ...requiredEnv,
        NATS_TLS_ENABLED: "true",
      });
      expect(config.NATS_TLS_ENABLED).toBe(true);
    });

    it("should parse string 'false' as boolean false", () => {
      const config = configSchema.parse({
        ...requiredEnv,
        NATS_TLS_ENABLED: "false",
      });
      expect(config.NATS_TLS_ENABLED).toBe(false);
    });

    it("should parse boolean true as true", () => {
      const config = configSchema.parse({
        ...requiredEnv,
        NATS_TLS_ENABLED: true,
      });
      expect(config.NATS_TLS_ENABLED).toBe(true);
    });
  });

  describe("required fields", () => {
    it("should require DATABASE_URL", () => {
      expect(() =>
        configSchema.parse({
          WEBHOOK_SECRET: "test-secret",
        })
      ).toThrow();
    });

    it("should require WEBHOOK_SECRET", () => {
      expect(() =>
        configSchema.parse({
          DATABASE_URL: "postgresql://test:test@localhost:5432/test",
        })
      ).toThrow();
    });

    it("should require WEBHOOK_SECRET to be non-empty", () => {
      expect(() =>
        configSchema.parse({
          DATABASE_URL: "postgresql://test:test@localhost:5432/test",
          WEBHOOK_SECRET: "",
        })
      ).toThrow();
    });
  });
});
