import { describe, it, expect, vi, beforeEach } from "vitest";
import { RetentionPolicy, StorageType, DiscardPolicy } from "nats";

// Mock config before importing the module under test
vi.mock("../../../config.js", () => ({
  config: {
    NATS_REPLICAS: 3,
  },
}));

// Mock logger to avoid console noise
vi.mock("../../../logger.js", () => ({
  log: {
    nats: {
      info: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { setupWebhookStream } from "../../../nats/webhook-stream.js";

describe("setupWebhookStream", () => {
  let mockJsm: {
    streams: {
      info: ReturnType<typeof vi.fn>;
      add: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockJsm = {
      streams: {
        info: vi.fn(),
        add: vi.fn().mockResolvedValue({}),
      },
    };
  });

  describe("stream creation", () => {
    it("should use config.NATS_REPLICAS for num_replicas", async () => {
      // Stream doesn't exist, will be created
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));

      await setupWebhookStream(mockJsm as any);

      expect(mockJsm.streams.add).toHaveBeenCalledWith(
        expect.objectContaining({
          num_replicas: 3,
        })
      );
    });

    it("should create stream with correct name and subjects", async () => {
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));

      await setupWebhookStream(mockJsm as any);

      expect(mockJsm.streams.add).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "webhooks",
          subjects: ["webhook.>"],
        })
      );
    });

    it("should use workqueue retention policy", async () => {
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));

      await setupWebhookStream(mockJsm as any);

      expect(mockJsm.streams.add).toHaveBeenCalledWith(
        expect.objectContaining({
          retention: RetentionPolicy.Workqueue,
        })
      );
    });

    it("should use file storage", async () => {
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));

      await setupWebhookStream(mockJsm as any);

      expect(mockJsm.streams.add).toHaveBeenCalledWith(
        expect.objectContaining({
          storage: StorageType.File,
        })
      );
    });

    it("should set discard policy to Old", async () => {
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));

      await setupWebhookStream(mockJsm as any);

      expect(mockJsm.streams.add).toHaveBeenCalledWith(
        expect.objectContaining({
          discard: DiscardPolicy.Old,
        })
      );
    });

    it("should set 24 hour max age", async () => {
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));

      await setupWebhookStream(mockJsm as any);

      const expectedMaxAge = 24 * 60 * 60 * 1e9; // 24 hours in nanoseconds
      expect(mockJsm.streams.add).toHaveBeenCalledWith(
        expect.objectContaining({
          max_age: expectedMaxAge,
        })
      );
    });

    it("should set 1GB max bytes", async () => {
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));

      await setupWebhookStream(mockJsm as any);

      expect(mockJsm.streams.add).toHaveBeenCalledWith(
        expect.objectContaining({
          max_bytes: 1024 * 1024 * 1024,
        })
      );
    });

    it("should set 10000 max messages per subject", async () => {
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));

      await setupWebhookStream(mockJsm as any);

      expect(mockJsm.streams.add).toHaveBeenCalledWith(
        expect.objectContaining({
          max_msgs_per_subject: 10_000,
        })
      );
    });

    it("should set 60 second duplicate window", async () => {
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));

      await setupWebhookStream(mockJsm as any);

      expect(mockJsm.streams.add).toHaveBeenCalledWith(
        expect.objectContaining({
          duplicate_window: 60 * 1e9,
        })
      );
    });
  });

  describe("existing stream", () => {
    it("should not create stream if it already exists", async () => {
      // Stream exists
      mockJsm.streams.info.mockResolvedValue({ config: { name: "webhooks" } });

      await setupWebhookStream(mockJsm as any);

      expect(mockJsm.streams.add).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should throw on stream creation failure", async () => {
      mockJsm.streams.info.mockRejectedValue(new Error("stream not found"));
      mockJsm.streams.add.mockRejectedValue(new Error("connection failed"));

      await expect(setupWebhookStream(mockJsm as any)).rejects.toThrow(
        "connection failed"
      );
    });
  });
});

describe("setupWebhookStream with different replica counts", () => {
  it("should respect different NATS_REPLICAS values", async () => {
    // Reset modules to test with different config
    vi.resetModules();

    // Mock with different replica count
    vi.doMock("../../../config.js", () => ({
      config: {
        NATS_REPLICAS: 5,
      },
    }));

    vi.doMock("../../../logger.js", () => ({
      log: {
        nats: {
          info: vi.fn(),
          error: vi.fn(),
        },
      },
    }));

    const { setupWebhookStream: setupWithReplicas } = await import(
      "../../../nats/webhook-stream.js"
    );

    const mockJsm = {
      streams: {
        info: vi.fn().mockRejectedValue(new Error("not found")),
        add: vi.fn().mockResolvedValue({}),
      },
    };

    await setupWithReplicas(mockJsm as any);

    expect(mockJsm.streams.add).toHaveBeenCalledWith(
      expect.objectContaining({
        num_replicas: 5,
      })
    );
  });
});
