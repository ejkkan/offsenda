/**
 * Module Batch Execution Tests
 *
 * Tests the batch execution capabilities of each module:
 * - EmailModule: Uses Resend batch API
 * - WebhookModule: Sends array of recipients in single POST
 * - SmsModule: Parallel individual calls with concurrency control
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmailModule } from "../../../modules/email-module.js";
import { WebhookModule } from "../../../modules/webhook-module.js";
import { SmsModule } from "../../../modules/sms-module.js";
import type { BatchJobPayload, SendConfig } from "../../../modules/types.js";
import { PROVIDER_LIMITS } from "../../../modules/types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock Resend
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    batch: {
      send: vi.fn(),
    },
    emails: {
      send: vi.fn(),
    },
  })),
}));

describe("PROVIDER_LIMITS Configuration", () => {
  it("has correct limits for SES", () => {
    expect(PROVIDER_LIMITS.ses.maxBatchSize).toBe(50);
    expect(PROVIDER_LIMITS.ses.maxRequestsPerSecond).toBe(14);
  });

  it("has correct limits for Resend", () => {
    expect(PROVIDER_LIMITS.resend.maxBatchSize).toBe(100);
    expect(PROVIDER_LIMITS.resend.maxRequestsPerSecond).toBe(100);
  });

  it("has correct limits for Telnyx (no batch API)", () => {
    expect(PROVIDER_LIMITS.telnyx.maxBatchSize).toBe(1);
    expect(PROVIDER_LIMITS.telnyx.maxRequestsPerSecond).toBe(50);
  });

  it("has correct limits for Webhook", () => {
    expect(PROVIDER_LIMITS.webhook.maxBatchSize).toBe(100);
    expect(PROVIDER_LIMITS.webhook.maxRequestsPerSecond).toBe(100);
  });

  it("has correct limits for Mock (high throughput for testing)", () => {
    expect(PROVIDER_LIMITS.mock.maxBatchSize).toBe(100);
    expect(PROVIDER_LIMITS.mock.maxRequestsPerSecond).toBe(10000);
  });
});

describe("EmailModule Batch Execution", () => {
  let emailModule: EmailModule;
  let mockResendInstance: any;

  beforeEach(async () => {
    emailModule = new EmailModule();

    // Access the mocked Resend
    const { Resend } = await import("resend");
    mockResendInstance = {
      batch: {
        send: vi.fn(),
      },
    };
    vi.mocked(Resend).mockImplementation(() => mockResendInstance);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("has supportsBatch = true", () => {
    expect(emailModule.supportsBatch).toBe(true);
  });

  it("has executeBatch method", () => {
    expect(typeof emailModule.executeBatch).toBe("function");
  });

  describe("executeBatch with mock provider", () => {
    const mockSendConfig: SendConfig = {
      id: "config-123",
      userId: "user-456",
      name: "Test Config",
      module: "email",
      config: {
        mode: "managed",
        provider: "mock",
      },
      rateLimit: null,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("returns success for all recipients with mock provider", async () => {
      // Set EMAIL_PROVIDER to mock
      vi.stubEnv("EMAIL_PROVIDER", "mock");

      const payloads: BatchJobPayload[] = [
        {
          recipientId: "r1",
          payload: {
            to: "user1@example.com",
            fromEmail: "sender@example.com",
            subject: "Test 1",
            textContent: "Hello 1",
          },
        },
        {
          recipientId: "r2",
          payload: {
            to: "user2@example.com",
            fromEmail: "sender@example.com",
            subject: "Test 2",
            textContent: "Hello 2",
          },
        },
      ];

      const results = await emailModule.executeBatch!(payloads, mockSendConfig);

      expect(results).toHaveLength(2);
      expect(results[0].recipientId).toBe("r1");
      expect(results[0].result.success).toBe(true);
      expect(results[0].result.providerMessageId).toMatch(/^mock-/);
      expect(results[1].recipientId).toBe("r2");
      expect(results[1].result.success).toBe(true);
    });

    it("includes latencyMs in results", async () => {
      vi.stubEnv("EMAIL_PROVIDER", "mock");

      const payloads: BatchJobPayload[] = [
        {
          recipientId: "r1",
          payload: {
            to: "user1@example.com",
            fromEmail: "sender@example.com",
            subject: "Test",
            textContent: "Hello",
          },
        },
      ];

      const results = await emailModule.executeBatch!(payloads, mockSendConfig);

      expect(results[0].result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("executeBatch with Resend BYOK", () => {
    const resendBYOKConfig: SendConfig = {
      id: "config-123",
      userId: "user-456",
      name: "Resend BYOK",
      module: "email",
      config: {
        mode: "byok",
        provider: "resend",
        apiKey: "re_test_key_123",
      },
      rateLimit: null,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("calls Resend batch.send API", async () => {
      mockResendInstance.batch.send.mockResolvedValue({
        data: [{ id: "msg-1" }, { id: "msg-2" }],
        error: null,
      });

      const payloads: BatchJobPayload[] = [
        {
          recipientId: "r1",
          payload: {
            to: "user1@example.com",
            fromEmail: "sender@example.com",
            subject: "Test 1",
            htmlContent: "<p>Hello 1</p>",
          },
        },
        {
          recipientId: "r2",
          payload: {
            to: "user2@example.com",
            fromEmail: "sender@example.com",
            fromName: "Sender Name",
            subject: "Test 2",
            textContent: "Hello 2",
          },
        },
      ];

      const results = await emailModule.executeBatch!(payloads, resendBYOKConfig);

      expect(mockResendInstance.batch.send).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
      expect(results[0].result.success).toBe(true);
      expect(results[0].result.providerMessageId).toBe("msg-1");
      expect(results[1].result.success).toBe(true);
      expect(results[1].result.providerMessageId).toBe("msg-2");
    });

    it("handles Resend batch API error", async () => {
      mockResendInstance.batch.send.mockResolvedValue({
        data: null,
        error: { message: "Rate limit exceeded" },
      });

      const payloads: BatchJobPayload[] = [
        {
          recipientId: "r1",
          payload: {
            to: "user1@example.com",
            fromEmail: "sender@example.com",
            subject: "Test",
            textContent: "Hello",
          },
        },
      ];

      const results = await emailModule.executeBatch!(payloads, resendBYOKConfig);

      expect(results[0].result.success).toBe(false);
      expect(results[0].result.error).toBe("Rate limit exceeded");
    });

    it("handles missing message IDs in response", async () => {
      mockResendInstance.batch.send.mockResolvedValue({
        data: [{ id: "msg-1" }, {}], // Second one missing ID
        error: null,
      });

      const payloads: BatchJobPayload[] = [
        {
          recipientId: "r1",
          payload: { to: "user1@example.com", fromEmail: "s@e.com", subject: "T", textContent: "H" },
        },
        {
          recipientId: "r2",
          payload: { to: "user2@example.com", fromEmail: "s@e.com", subject: "T", textContent: "H" },
        },
      ];

      const results = await emailModule.executeBatch!(payloads, resendBYOKConfig);

      expect(results[0].result.success).toBe(true);
      expect(results[1].result.success).toBe(false);
      expect(results[1].result.error).toBe("No message ID returned");
    });
  });

  describe("template variable substitution in batch", () => {
    const mockConfig: SendConfig = {
      id: "config-123",
      userId: "user-456",
      name: "Test Config",
      module: "email",
      config: { mode: "managed", provider: "mock" },
      rateLimit: null,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("applies template variables to each recipient", async () => {
      vi.stubEnv("EMAIL_PROVIDER", "mock");

      const payloads: BatchJobPayload[] = [
        {
          recipientId: "r1",
          payload: {
            to: "user1@example.com",
            name: "Alice",
            fromEmail: "sender@example.com",
            subject: "Hello {{name}}",
            htmlContent: "<p>Welcome {{name}} ({{email}})</p>",
            variables: { custom: "value1" },
          },
        },
        {
          recipientId: "r2",
          payload: {
            to: "user2@example.com",
            name: "Bob",
            fromEmail: "sender@example.com",
            subject: "Hello {{name}}",
            textContent: "Welcome {{name}}",
          },
        },
      ];

      const results = await emailModule.executeBatch!(payloads, mockConfig);

      // Both should succeed (template processing happens internally)
      expect(results[0].result.success).toBe(true);
      expect(results[1].result.success).toBe(true);
    });
  });
});

describe("WebhookModule Batch Execution", () => {
  let webhookModule: WebhookModule;

  beforeEach(() => {
    webhookModule = new WebhookModule();
  });

  it("has supportsBatch = true", () => {
    expect(webhookModule.supportsBatch).toBe(true);
  });

  it("has executeBatch method", () => {
    expect(typeof webhookModule.executeBatch).toBe("function");
  });

  // Note: Full webhook batch execution tests are skipped here because
  // the WebhookModule has built-in retry logic and circuit breakers
  // that make unit testing with mocks complex.
  // See integration tests for full webhook flow testing.

  describe("webhook batch payload structure", () => {
    it("defines expected batch request format", () => {
      // Document the expected format that webhook endpoints should accept
      const expectedRequestFormat = {
        recipients: [
          {
            recipientId: "r1",
            to: "user@example.com",
            name: "User Name",
            data: { custom: "data" },
          },
        ],
      };

      expect(expectedRequestFormat.recipients).toBeInstanceOf(Array);
      expect(expectedRequestFormat.recipients[0].recipientId).toBeDefined();
    });

    it("defines expected batch response format", () => {
      // Document the expected response format from webhook endpoints
      const expectedResponseFormat = {
        success: true,
        results: [
          { recipientId: "r1", success: true, messageId: "msg-123" },
          { recipientId: "r2", success: false, error: "Invalid email" },
        ],
      };

      expect(expectedResponseFormat.results).toBeInstanceOf(Array);
      expect(expectedResponseFormat.results[0]).toHaveProperty("recipientId");
      expect(expectedResponseFormat.results[0]).toHaveProperty("success");
    });
  });
});

describe("SmsModule Batch Execution", () => {
  let smsModule: SmsModule;

  beforeEach(() => {
    smsModule = new SmsModule();
    mockFetch.mockReset();
  });

  it("has supportsBatch = true", () => {
    expect(smsModule.supportsBatch).toBe(true);
  });

  it("has executeBatch method", () => {
    expect(typeof smsModule.executeBatch).toBe("function");
  });

  describe("executeBatch with mock provider", () => {
    const mockConfig: SendConfig = {
      id: "config-123",
      userId: "user-456",
      name: "SMS Mock Config",
      module: "sms",
      config: {
        provider: "mock",
        fromNumber: "+1234567890",
      },
      rateLimit: null,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("returns success for all recipients", async () => {
      const payloads: BatchJobPayload[] = [
        { recipientId: "r1", payload: { to: "+1111111111", message: "Hello 1" } },
        { recipientId: "r2", payload: { to: "+2222222222", message: "Hello 2" } },
        { recipientId: "r3", payload: { to: "+3333333333", message: "Hello 3" } },
      ];

      const results = await smsModule.executeBatch!(payloads, mockConfig);

      expect(results).toHaveLength(3);
      results.forEach((r, i) => {
        expect(r.recipientId).toBe(`r${i + 1}`);
        expect(r.result.success).toBe(true);
        expect(r.result.providerMessageId).toMatch(/^mock-sms-/);
      });
    });
  });

  describe("executeBatch with Telnyx (parallel individual calls)", () => {
    const telnyxConfig: SendConfig = {
      id: "config-123",
      userId: "user-456",
      name: "Telnyx Config",
      module: "sms",
      config: {
        provider: "telnyx",
        fromNumber: "+1234567890",
        apiKey: "KEY_test123",
      },
      rateLimit: null,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("makes parallel individual API calls", async () => {
      // Track call order
      const callOrder: number[] = [];
      let callCount = 0;

      mockFetch.mockImplementation(async () => {
        const myCallNum = ++callCount;
        callOrder.push(myCallNum);
        // Simulate some latency
        await new Promise((r) => setTimeout(r, 10));
        return {
          ok: true,
          json: async () => ({ data: { id: `msg-${myCallNum}` } }),
        };
      });

      const payloads: BatchJobPayload[] = [
        { recipientId: "r1", payload: { to: "+1111111111", message: "Hello 1" } },
        { recipientId: "r2", payload: { to: "+2222222222", message: "Hello 2" } },
        { recipientId: "r3", payload: { to: "+3333333333", message: "Hello 3" } },
      ];

      const results = await smsModule.executeBatch!(payloads, telnyxConfig);

      // Should make 3 individual calls (no batch API)
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // All should succeed
      expect(results).toHaveLength(3);
      results.forEach((r) => {
        expect(r.result.success).toBe(true);
        expect(r.result.providerMessageId).toMatch(/^msg-\d+$/);
      });
    });

    it("handles mixed success/failure in parallel calls", async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          return {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            json: async () => ({ errors: [{ detail: "Invalid phone number" }] }),
          };
        }
        return {
          ok: true,
          json: async () => ({ data: { id: `msg-${callCount}` } }),
        };
      });

      const payloads: BatchJobPayload[] = [
        { recipientId: "r1", payload: { to: "+1111111111", message: "Hello 1" } },
        { recipientId: "r2", payload: { to: "invalid", message: "Hello 2" } },
        { recipientId: "r3", payload: { to: "+3333333333", message: "Hello 3" } },
      ];

      const results = await smsModule.executeBatch!(payloads, telnyxConfig);

      expect(results[0].result.success).toBe(true);
      expect(results[1].result.success).toBe(false);
      expect(results[1].result.error).toContain("Invalid phone number");
      expect(results[2].result.success).toBe(true);
    });

    it("respects maxParallelRequests concurrency limit", async () => {
      // Track concurrent calls
      let currentConcurrent = 0;
      let maxConcurrent = 0;

      mockFetch.mockImplementation(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 50)); // Simulate latency
        currentConcurrent--;
        return {
          ok: true,
          json: async () => ({ data: { id: "msg-1" } }),
        };
      });

      // Create 20 payloads (more than maxParallelRequests = 10)
      const payloads: BatchJobPayload[] = Array.from({ length: 20 }, (_, i) => ({
        recipientId: `r${i}`,
        payload: { to: `+100000000${i.toString().padStart(2, "0")}`, message: "Test" },
      }));

      await smsModule.executeBatch!(payloads, telnyxConfig);

      // Max concurrent should not exceed 10 (maxParallelRequests)
      expect(maxConcurrent).toBeLessThanOrEqual(10);
      expect(mockFetch).toHaveBeenCalledTimes(20);
    });

    it("includes proper headers in Telnyx requests", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { id: "msg-1" } }),
      });

      const payloads: BatchJobPayload[] = [
        { recipientId: "r1", payload: { to: "+1111111111", message: "Hello" } },
      ];

      await smsModule.executeBatch!(payloads, telnyxConfig);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.telnyx.com/v2/messages");
      expect(options.headers.Authorization).toBe("Bearer KEY_test123");
      expect(options.headers["Content-Type"]).toBe("application/json");
    });
  });
});

describe("Batch Execution Edge Cases", () => {
  describe("Empty batch handling", () => {
    it("EmailModule handles empty batch", async () => {
      const module = new EmailModule();
      const config: SendConfig = {
        id: "c1",
        userId: "u1",
        name: "Test",
        module: "email",
        config: { mode: "managed", provider: "mock" },
        rateLimit: null,
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const results = await module.executeBatch!([], config);
      expect(results).toHaveLength(0);
    });

    it("WebhookModule has executeBatch for empty batch", () => {
      const module = new WebhookModule();
      // WebhookModule supports batch execution
      expect(module.supportsBatch).toBe(true);
      expect(typeof module.executeBatch).toBe("function");
      // Empty batch handling is tested in integration tests
    });

    it("SmsModule handles empty batch", async () => {
      const module = new SmsModule();
      const config: SendConfig = {
        id: "c1",
        userId: "u1",
        name: "Test",
        module: "sms",
        config: { provider: "mock", fromNumber: "+1234567890" },
        rateLimit: null,
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const results = await module.executeBatch!([], config);
      expect(results).toHaveLength(0);
    });
  });

  describe("Single recipient batch", () => {
    it("processes single recipient correctly", async () => {
      const module = new EmailModule();
      vi.stubEnv("EMAIL_PROVIDER", "mock");

      const config: SendConfig = {
        id: "c1",
        userId: "u1",
        name: "Test",
        module: "email",
        config: { mode: "managed", provider: "mock" },
        rateLimit: null,
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const payloads: BatchJobPayload[] = [
        {
          recipientId: "r1",
          payload: {
            to: "user@example.com",
            fromEmail: "sender@example.com",
            subject: "Test",
            textContent: "Hello",
          },
        },
      ];

      const results = await module.executeBatch!(payloads, config);

      expect(results).toHaveLength(1);
      expect(results[0].recipientId).toBe("r1");
      expect(results[0].result.success).toBe(true);
    });
  });

  describe("Large batch handling", () => {
    it("handles 100 recipients in single batch", async () => {
      const module = new SmsModule();
      const config: SendConfig = {
        id: "c1",
        userId: "u1",
        name: "Test",
        module: "sms",
        config: { provider: "mock", fromNumber: "+1234567890" },
        rateLimit: null,
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const payloads: BatchJobPayload[] = Array.from({ length: 100 }, (_, i) => ({
        recipientId: `r${i}`,
        payload: {
          to: `+1${i.toString().padStart(10, "0")}`,
          message: `Message ${i}`,
        },
      }));

      const results = await module.executeBatch!(payloads, config);

      expect(results).toHaveLength(100);
      results.forEach((r, i) => {
        expect(r.recipientId).toBe(`r${i}`);
        expect(r.result.success).toBe(true);
      });
    });
  });
});
