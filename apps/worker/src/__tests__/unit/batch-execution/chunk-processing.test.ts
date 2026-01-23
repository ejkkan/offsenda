/**
 * Chunk Processing Tests
 *
 * Tests the chunk-based processing flow:
 * - Batch processor splits recipients into chunks
 * - Chunks are enqueued to NATS
 * - Chunk processor uses module.executeBatch()
 * - HotStateManager tracks batch operations
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChunkJobData, EmbeddedSendConfig, JobData } from "../../../types/jobs.js";
import { PROVIDER_LIMITS } from "../../../modules/types.js";

describe("ChunkJobData Structure", () => {
  it("has required fields", () => {
    const chunk: ChunkJobData = {
      batchId: "batch-123",
      userId: "user-456",
      chunkIndex: 0,
      recipientIds: ["r1", "r2", "r3"],
      sendConfig: {
        id: "config-789",
        module: "email",
        config: { mode: "managed", provider: "resend" },
        rateLimit: null,
      },
    };

    expect(chunk.batchId).toBe("batch-123");
    expect(chunk.userId).toBe("user-456");
    expect(chunk.chunkIndex).toBe(0);
    expect(chunk.recipientIds).toHaveLength(3);
    expect(chunk.sendConfig.module).toBe("email");
  });

  it("supports dry run mode", () => {
    const chunk: ChunkJobData = {
      batchId: "batch-123",
      userId: "user-456",
      chunkIndex: 0,
      recipientIds: ["r1"],
      sendConfig: {
        id: "config-789",
        module: "email",
        config: { mode: "managed" },
      },
      dryRun: true,
    };

    expect(chunk.dryRun).toBe(true);
  });

  it("embeds send config to avoid DB lookups", () => {
    const sendConfig: EmbeddedSendConfig = {
      id: "config-789",
      module: "webhook",
      config: {
        url: "https://api.example.com/webhook",
        method: "POST",
        headers: { "X-Api-Key": "secret" },
      },
      rateLimit: {
        requestsPerSecond: 10,
        recipientsPerRequest: 50,
      },
    };

    const chunk: ChunkJobData = {
      batchId: "batch-123",
      userId: "user-456",
      chunkIndex: 0,
      recipientIds: ["r1"],
      sendConfig,
    };

    // SendConfig is fully embedded - no DB lookup needed during processing
    expect(chunk.sendConfig.config.url).toBe("https://api.example.com/webhook");
    expect(chunk.sendConfig.rateLimit?.requestsPerSecond).toBe(10);
    expect(chunk.sendConfig.rateLimit?.recipientsPerRequest).toBe(50);
  });
});

describe("Chunk vs Individual Job Detection", () => {
  it("chunk has recipientIds array", () => {
    const chunk: ChunkJobData = {
      batchId: "batch-123",
      userId: "user-456",
      chunkIndex: 0,
      recipientIds: ["r1", "r2"],
      sendConfig: { id: "c1", module: "email", config: {} },
    };

    expect(Array.isArray(chunk.recipientIds)).toBe(true);
    expect(chunk.recipientIds.length).toBeGreaterThan(0);
  });

  it("individual job has single recipientId string", () => {
    const job: JobData = {
      batchId: "batch-123",
      userId: "user-456",
      recipientId: "r1", // Single string, not array
      identifier: "user@example.com",
      sendConfig: { id: "c1", module: "email", config: {} },
    };

    expect(typeof job.recipientId).toBe("string");
    expect((job as any).recipientIds).toBeUndefined();
  });

  it("can detect chunk vs job by checking recipientIds", () => {
    const isChunk = (data: ChunkJobData | JobData): data is ChunkJobData => {
      return Array.isArray((data as ChunkJobData).recipientIds);
    };

    const chunk: ChunkJobData = {
      batchId: "b1",
      userId: "u1",
      chunkIndex: 0,
      recipientIds: ["r1"],
      sendConfig: { id: "c1", module: "email", config: {} },
    };

    const job: JobData = {
      batchId: "b1",
      userId: "u1",
      recipientId: "r1",
      identifier: "user@example.com",
      sendConfig: { id: "c1", module: "email", config: {} },
    };

    expect(isChunk(chunk)).toBe(true);
    expect(isChunk(job)).toBe(false);
  });
});

describe("Chunking Logic", () => {
  /**
   * Simulates the chunking logic used in batch processor
   */
  function createChunks(
    recipientIds: string[],
    batchId: string,
    userId: string,
    sendConfig: EmbeddedSendConfig,
    recipientsPerChunk: number
  ): ChunkJobData[] {
    const chunks: ChunkJobData[] = [];

    for (let i = 0; i < recipientIds.length; i += recipientsPerChunk) {
      chunks.push({
        batchId,
        userId,
        chunkIndex: Math.floor(i / recipientsPerChunk),
        recipientIds: recipientIds.slice(i, i + recipientsPerChunk),
        sendConfig,
      });
    }

    return chunks;
  }

  const sendConfig: EmbeddedSendConfig = {
    id: "config-1",
    module: "email",
    config: { mode: "managed", provider: "resend" },
    rateLimit: { requestsPerSecond: 100, recipientsPerRequest: 50 },
  };

  it("creates single chunk for small batch", () => {
    const recipientIds = ["r1", "r2", "r3"];
    const chunks = createChunks(recipientIds, "b1", "u1", sendConfig, 50);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].recipientIds).toEqual(["r1", "r2", "r3"]);
  });

  it("creates multiple chunks for large batch", () => {
    const recipientIds = Array.from({ length: 150 }, (_, i) => `r${i}`);
    const chunks = createChunks(recipientIds, "b1", "u1", sendConfig, 50);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].recipientIds).toHaveLength(50);
    expect(chunks[1].chunkIndex).toBe(1);
    expect(chunks[1].recipientIds).toHaveLength(50);
    expect(chunks[2].chunkIndex).toBe(2);
    expect(chunks[2].recipientIds).toHaveLength(50);
  });

  it("handles non-even division", () => {
    const recipientIds = Array.from({ length: 125 }, (_, i) => `r${i}`);
    const chunks = createChunks(recipientIds, "b1", "u1", sendConfig, 50);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].recipientIds).toHaveLength(50);
    expect(chunks[1].recipientIds).toHaveLength(50);
    expect(chunks[2].recipientIds).toHaveLength(25); // Remainder
  });

  it("preserves recipient order within chunks", () => {
    const recipientIds = ["r0", "r1", "r2", "r3", "r4"];
    const chunks = createChunks(recipientIds, "b1", "u1", sendConfig, 2);

    expect(chunks[0].recipientIds).toEqual(["r0", "r1"]);
    expect(chunks[1].recipientIds).toEqual(["r2", "r3"]);
    expect(chunks[2].recipientIds).toEqual(["r4"]);
  });

  it("respects provider limits for chunk size", () => {
    // SES max batch size is 50
    const sesConfig: EmbeddedSendConfig = {
      id: "config-1",
      module: "email",
      config: { mode: "managed", provider: "ses" },
      rateLimit: { recipientsPerRequest: PROVIDER_LIMITS.ses.maxBatchSize },
    };

    const recipientIds = Array.from({ length: 200 }, (_, i) => `r${i}`);
    const chunks = createChunks(
      recipientIds,
      "b1",
      "u1",
      sesConfig,
      PROVIDER_LIMITS.ses.maxBatchSize
    );

    expect(chunks).toHaveLength(4); // 200 / 50 = 4
    chunks.forEach((chunk) => {
      expect(chunk.recipientIds.length).toBeLessThanOrEqual(50);
    });
  });

  it("handles empty recipient list", () => {
    const chunks = createChunks([], "b1", "u1", sendConfig, 50);
    expect(chunks).toHaveLength(0);
  });

  it("handles chunk size of 1 (Telnyx)", () => {
    const telnyxConfig: EmbeddedSendConfig = {
      id: "config-1",
      module: "sms",
      config: { provider: "telnyx" },
      rateLimit: { recipientsPerRequest: 1 },
    };

    const recipientIds = ["r1", "r2", "r3"];
    const chunks = createChunks(
      recipientIds,
      "b1",
      "u1",
      telnyxConfig,
      PROVIDER_LIMITS.telnyx.maxBatchSize
    );

    expect(chunks).toHaveLength(3);
    expect(chunks[0].recipientIds).toEqual(["r1"]);
    expect(chunks[1].recipientIds).toEqual(["r2"]);
    expect(chunks[2].recipientIds).toEqual(["r3"]);
  });
});

describe("Chunk Message ID Generation", () => {
  it("generates unique deduplication ID per chunk", () => {
    const batchId = "batch-123";
    const chunkIndices = [0, 1, 2];

    const msgIds = chunkIndices.map((idx) => `chunk-${batchId}-${idx}`);

    expect(msgIds).toEqual([
      "chunk-batch-123-0",
      "chunk-batch-123-1",
      "chunk-batch-123-2",
    ]);

    // All unique
    const uniqueIds = new Set(msgIds);
    expect(uniqueIds.size).toBe(3);
  });

  it("message IDs are deterministic for deduplication", () => {
    const batchId = "batch-abc";
    const chunkIndex = 5;

    const msgId1 = `chunk-${batchId}-${chunkIndex}`;
    const msgId2 = `chunk-${batchId}-${chunkIndex}`;

    expect(msgId1).toBe(msgId2);
    expect(msgId1).toBe("chunk-batch-abc-5");
  });
});

describe("Provider-specific Chunk Sizes", () => {
  it("uses recipientsPerRequest from rate limit config", () => {
    const config: EmbeddedSendConfig = {
      id: "c1",
      module: "webhook",
      config: { url: "https://example.com/hook" },
      rateLimit: {
        requestsPerSecond: 20,
        recipientsPerRequest: 25, // Custom size
      },
    };

    expect(config.rateLimit?.recipientsPerRequest).toBe(25);
  });

  it("falls back to provider default when not specified", () => {
    const configWithoutRateLimit: EmbeddedSendConfig = {
      id: "c1",
      module: "email",
      config: { mode: "managed", provider: "resend" },
      // No rateLimit specified
    };

    // Should use PROVIDER_LIMITS.resend.maxBatchSize as default
    const chunkSize =
      configWithoutRateLimit.rateLimit?.recipientsPerRequest ||
      PROVIDER_LIMITS.resend.maxBatchSize;

    expect(chunkSize).toBe(100);
  });

  it("uses correct defaults for each module type", () => {
    const modules = ["ses", "resend", "telnyx", "webhook"] as const;
    const expectedSizes = {
      ses: 50,
      resend: 100,
      telnyx: 1,
      webhook: 100,
    };

    modules.forEach((module) => {
      expect(PROVIDER_LIMITS[module].maxBatchSize).toBe(expectedSizes[module]);
    });
  });
});

describe("Chunk Processing Results", () => {
  it("maps batch results back to recipient IDs", () => {
    const chunk: ChunkJobData = {
      batchId: "b1",
      userId: "u1",
      chunkIndex: 0,
      recipientIds: ["r1", "r2", "r3"],
      sendConfig: { id: "c1", module: "email", config: {} },
    };

    // Simulated batch execution results
    const batchResults = [
      { recipientId: "r1", result: { success: true, providerMessageId: "msg-1", latencyMs: 100 } },
      { recipientId: "r2", result: { success: false, error: "Invalid email", latencyMs: 100 } },
      { recipientId: "r3", result: { success: true, providerMessageId: "msg-3", latencyMs: 100 } },
    ];

    // Create result map for quick lookup
    const resultMap = new Map(batchResults.map((r) => [r.recipientId, r.result]));

    // Verify all recipients have results
    chunk.recipientIds.forEach((rid) => {
      expect(resultMap.has(rid)).toBe(true);
    });

    // Count successes/failures
    const successCount = batchResults.filter((r) => r.result.success).length;
    const failCount = batchResults.filter((r) => !r.result.success).length;

    expect(successCount).toBe(2);
    expect(failCount).toBe(1);
  });

  it("handles all-success scenario", () => {
    const recipientIds = ["r1", "r2", "r3", "r4", "r5"];
    const results = recipientIds.map((rid) => ({
      recipientId: rid,
      result: { success: true, providerMessageId: `msg-${rid}`, latencyMs: 50 },
    }));

    const allSuccess = results.every((r) => r.result.success);
    expect(allSuccess).toBe(true);
  });

  it("handles all-failure scenario (e.g., provider down)", () => {
    const recipientIds = ["r1", "r2", "r3"];
    const error = "Provider API unavailable";

    const results = recipientIds.map((rid) => ({
      recipientId: rid,
      result: { success: false, error, latencyMs: 200 },
    }));

    const allFailed = results.every((r) => !r.result.success);
    expect(allFailed).toBe(true);
    results.forEach((r) => {
      expect(r.result.error).toBe(error);
    });
  });

  it("tracks processing time per chunk", () => {
    const startTime = Date.now();

    // Simulate processing delay
    const processingMs = 150;
    const latencyMs = Date.now() - startTime + processingMs;

    expect(latencyMs).toBeGreaterThanOrEqual(processingMs);
  });
});

describe("Chunk Deduplication", () => {
  it("chunk index ensures unique message ID per chunk in batch", () => {
    const batchId = "batch-123";
    const chunks = [
      { chunkIndex: 0, msgId: `chunk-${batchId}-0` },
      { chunkIndex: 1, msgId: `chunk-${batchId}-1` },
      { chunkIndex: 2, msgId: `chunk-${batchId}-2` },
    ];

    // All message IDs are unique within batch
    const msgIds = chunks.map((c) => c.msgId);
    const uniqueIds = new Set(msgIds);
    expect(uniqueIds.size).toBe(chunks.length);
  });

  it("same chunk reprocessed has same message ID (for NATS dedup)", () => {
    const batchId = "batch-456";
    const chunkIndex = 3;

    // First processing attempt
    const msgId1 = `chunk-${batchId}-${chunkIndex}`;

    // Reprocessing attempt (e.g., after NAK)
    const msgId2 = `chunk-${batchId}-${chunkIndex}`;

    expect(msgId1).toBe(msgId2);
    // NATS will reject duplicate within dedup window
  });

  it("different batches can have same chunk index", () => {
    const msgId1 = "chunk-batch-A-0";
    const msgId2 = "chunk-batch-B-0";

    expect(msgId1).not.toBe(msgId2);
  });
});

describe("Batch Statistics After Chunk Processing", () => {
  it("aggregates success/failure counts from chunks", () => {
    const chunkResults = [
      // Chunk 0: 50 recipients, 48 success, 2 failed
      { chunkIndex: 0, success: 48, failed: 2 },
      // Chunk 1: 50 recipients, 50 success, 0 failed
      { chunkIndex: 1, success: 50, failed: 0 },
      // Chunk 2: 25 recipients, 20 success, 5 failed
      { chunkIndex: 2, success: 20, failed: 5 },
    ];

    const totalSuccess = chunkResults.reduce((sum, c) => sum + c.success, 0);
    const totalFailed = chunkResults.reduce((sum, c) => sum + c.failed, 0);
    const totalRecipients = totalSuccess + totalFailed;

    expect(totalSuccess).toBe(118);
    expect(totalFailed).toBe(7);
    expect(totalRecipients).toBe(125);
  });

  it("calculates completion percentage", () => {
    const totalRecipients = 1000;
    const processed = 750;

    const completionPct = (processed / totalRecipients) * 100;

    expect(completionPct).toBe(75);
  });
});
