import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for NatsClient configuration.
 *
 * These tests verify that the NATS client is configured correctly,
 * particularly for failover scenarios (jitter, replicas, etc.).
 *
 * Note: We can't easily test the actual NATS connection behavior,
 * but we can verify the configuration is built correctly.
 */

// Store the connection options passed to connect()
let capturedConnectionOptions: any = null;

// Mock nats module
vi.mock("nats", () => ({
  connect: vi.fn().mockImplementation((options) => {
    capturedConnectionOptions = options;
    return Promise.resolve({
      jetstream: vi.fn().mockReturnValue({}),
      jetstreamManager: vi.fn().mockResolvedValue({
        streams: {
          info: vi.fn().mockResolvedValue({}),
          add: vi.fn().mockResolvedValue({}),
        },
        consumers: {
          info: vi.fn().mockResolvedValue({}),
          add: vi.fn().mockResolvedValue({}),
        },
      }),
      closed: vi.fn().mockReturnValue(new Promise(() => {})),
      status: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
        }),
      }),
      drain: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
    });
  }),
  RetentionPolicy: { Workqueue: "workqueue" },
  StorageType: { File: "file" },
  DiscardPolicy: { Old: "old" },
  AckPolicy: { Explicit: "explicit" },
  DeliverPolicy: { All: "all" },
  ReplayPolicy: { Instant: "instant" },
  StringCodec: vi.fn().mockReturnValue({
    encode: vi.fn(),
    decode: vi.fn(),
  }),
}));

// Mock config
vi.mock("../../../config.js", () => ({
  config: {
    NATS_CLUSTER: "nats://localhost:4222,nats://localhost:4223",
    NATS_REPLICAS: 3,
    NATS_MAX_MSGS_PER_SUBJECT: 1000000,
    NATS_TLS_ENABLED: false,
    WORKER_ID: "test-worker",
  },
}));

// Mock logger
vi.mock("../../../logger.js", () => ({
  log: {
    system: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    queue: {
      info: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

// Mock backoff
vi.mock("../../../domain/utils/backoff.js", () => ({
  calculateBackoff: vi.fn().mockReturnValue(1000),
}));

import { NatsClient } from "../../../nats/client.js";

describe("NatsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedConnectionOptions = null;
  });

  describe("connection options", () => {
    it("should configure reconnect jitter to prevent thundering herd", async () => {
      const client = new NatsClient();
      await client.connect();

      expect(capturedConnectionOptions).toMatchObject({
        reconnectJitter: 1000,
        reconnectJitterTLS: 2000,
      });
    });

    it("should set base reconnect time wait to 1000ms", async () => {
      const client = new NatsClient();
      await client.connect();

      expect(capturedConnectionOptions.reconnectTimeWait).toBe(1000);
    });

    it("should enable unlimited reconnect attempts", async () => {
      const client = new NatsClient();
      await client.connect();

      expect(capturedConnectionOptions.maxReconnectAttempts).toBe(-1);
    });

    it("should enable reconnect", async () => {
      const client = new NatsClient();
      await client.connect();

      expect(capturedConnectionOptions.reconnect).toBe(true);
    });

    it("should parse comma-separated server list", async () => {
      const client = new NatsClient();
      await client.connect();

      expect(capturedConnectionOptions.servers).toEqual([
        "nats://localhost:4222",
        "nats://localhost:4223",
      ]);
    });

    it("should set worker name from config", async () => {
      const client = new NatsClient();
      await client.connect();

      expect(capturedConnectionOptions.name).toBe("worker-test-worker");
    });

    it("should configure ping settings", async () => {
      const client = new NatsClient();
      await client.connect();

      expect(capturedConnectionOptions).toMatchObject({
        pingInterval: 30000,
        maxPingOut: 3,
      });
    });
  });

  describe("TLS configuration", () => {
    it("should not include TLS options when disabled", async () => {
      const client = new NatsClient();
      await client.connect();

      expect(capturedConnectionOptions.tls).toBeUndefined();
    });
  });

  describe("health check", () => {
    it("should return false when not connected", async () => {
      const client = new NatsClient();
      const healthy = await client.healthCheck();
      expect(healthy).toBe(false);
    });

    it("should return true when connected and flush succeeds", async () => {
      const client = new NatsClient();
      await client.connect();
      const healthy = await client.healthCheck();
      expect(healthy).toBe(true);
    });
  });

  describe("close", () => {
    it("should drain and close connection", async () => {
      const client = new NatsClient();
      await client.connect();

      const nc = client.getConnection();
      await client.close();

      expect(nc.drain).toHaveBeenCalled();
      expect(nc.close).toHaveBeenCalled();
    });
  });
});

describe("NatsClient with TLS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedConnectionOptions = null;
  });

  it("should include TLS options when enabled", async () => {
    // Reset modules to test with TLS enabled
    vi.resetModules();

    vi.doMock("nats", () => ({
      connect: vi.fn().mockImplementation((options) => {
        capturedConnectionOptions = options;
        return Promise.resolve({
          jetstream: vi.fn().mockReturnValue({}),
          jetstreamManager: vi.fn().mockResolvedValue({
            streams: {
              info: vi.fn().mockResolvedValue({}),
              add: vi.fn().mockResolvedValue({}),
            },
            consumers: {
              info: vi.fn().mockResolvedValue({}),
              add: vi.fn().mockResolvedValue({}),
            },
          }),
          closed: vi.fn().mockReturnValue(new Promise(() => {})),
          status: vi.fn().mockReturnValue({
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise(() => {}),
            }),
          }),
          drain: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          flush: vi.fn().mockResolvedValue(undefined),
        });
      }),
      RetentionPolicy: { Workqueue: "workqueue" },
      StorageType: { File: "file" },
      DiscardPolicy: { Old: "old" },
      AckPolicy: { Explicit: "explicit" },
      DeliverPolicy: { All: "all" },
      ReplayPolicy: { Instant: "instant" },
      StringCodec: vi.fn().mockReturnValue({
        encode: vi.fn(),
        decode: vi.fn(),
      }),
    }));

    vi.doMock("../../../config.js", () => ({
      config: {
        NATS_CLUSTER: "nats://localhost:4222",
        NATS_REPLICAS: 3,
        NATS_MAX_MSGS_PER_SUBJECT: 1000000,
        NATS_TLS_ENABLED: true,
        NATS_TLS_CA_FILE: undefined,
        NATS_TLS_CERT_FILE: undefined,
        NATS_TLS_KEY_FILE: undefined,
        WORKER_ID: "test-worker",
      },
    }));

    vi.doMock("../../../logger.js", () => ({
      log: {
        system: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        queue: {
          info: vi.fn(),
          debug: vi.fn(),
        },
      },
    }));

    vi.doMock("../../../domain/utils/backoff.js", () => ({
      calculateBackoff: vi.fn().mockReturnValue(1000),
    }));

    const { NatsClient: NatsClientWithTLS } = await import(
      "../../../nats/client.js"
    );

    const client = new NatsClientWithTLS();
    await client.connect();

    expect(capturedConnectionOptions.tls).toBeDefined();
  });
});
