import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SmsModule } from "../../../modules/sms-module.js";
import type { SendConfig } from "@batchsender/db";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("Telnyx SMS Integration", () => {
  let smsModule: SmsModule;
  let mockSendConfig: SendConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    smsModule = new SmsModule();

    // Set TELNYX_API_KEY env var (platform-managed)
    vi.stubEnv("TELNYX_API_KEY", "KEY01234567890ABCDEF");

    mockSendConfig = {
      id: "test-config",
      userId: "user-123",
      name: "Telnyx SMS",
      module: "sms",
      config: {
        service: "telnyx",
        fromNumber: "+15551234567",
        messagingProfileId: "profile-123",
      },
      rateLimit: null,
      isDefault: true,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Set up default fetch mock
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: "telnyx-msg-123456",
          status: "sent",
        },
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("Configuration Validation", () => {
    it("validates valid Telnyx config", () => {
      const result = smsModule.validateConfig({
        service: "telnyx",
        fromNumber: "+15551234567",
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("validates Telnyx config with messaging profile", () => {
      const result = smsModule.validateConfig({
        service: "telnyx",
        fromNumber: "+15551234567",
        messagingProfileId: "profile-123",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects config without service", () => {
      const result = smsModule.validateConfig({
        fromNumber: "+15551234567",
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("service is required (telnyx)");
    });

    it("rejects config without fromNumber", () => {
      const result = smsModule.validateConfig({
        service: "telnyx",
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("fromNumber is required");
    });
  });

  describe("SMS Sending", () => {
    it("sends SMS successfully via Telnyx", async () => {
      const payload = {
        to: "+15559876543",
        message: "Hello from Telnyx!",
        variables: { name: "John" },
      };

      const result = await smsModule.execute(payload, mockSendConfig);

      expect(result.success).toBe(true);
      expect(result.providerMessageId).toBe("telnyx-msg-123456");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      // Verify API call
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.telnyx.com/v2/messages",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer KEY01234567890ABCDEF",
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: expect.stringContaining('"from":"+15551234567"'),
        })
      );
    });

    it("includes messaging profile when configured", async () => {
      const payload = {
        to: "+15559876543",
        message: "Test message",
      };

      await smsModule.execute(payload, mockSendConfig);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.messaging_profile_id).toBe("profile-123");
    });

    it("interpolates variables in message", async () => {
      const payload = {
        to: "+15559876543",
        message: "Hello {{name}}, your code is {{code}}",
        variables: { name: "Alice", code: "ABC123" },
      };

      await smsModule.execute(payload, mockSendConfig);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.text).toBe("Hello Alice, your code is ABC123");
    });

    it("handles Telnyx API errors properly", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({
          errors: [{
            detail: "Invalid phone number format",
          }],
        }),
      });

      const payload = {
        to: "+15559876543",
        message: "Test message",
      };

      const result = await smsModule.execute(payload, mockSendConfig);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid phone number format");
    });

    it("handles network errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const payload = {
        to: "+15559876543",
        message: "Test message",
      };

      const result = await smsModule.execute(payload, mockSendConfig);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });

    it("validates phone numbers before sending", async () => {
      const payload = {
        to: "not-a-phone-number",
        message: "Test message",
      };

      const validation = smsModule.validatePayload(payload);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("to must be a valid phone number (E.164 format: +1234567890)");
    });
  });

  describe("Webhook URL Configuration", () => {
    it("includes webhook URLs when environment variable is set", async () => {
      vi.stubEnv("WEBHOOK_BASE_URL", "https://example.com");

      const payload = {
        to: "+15559876543",
        message: "Test message",
      };

      await smsModule.execute(payload, mockSendConfig);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.webhook_url).toBe("https://example.com/api/webhooks/telnyx");
      expect(body.webhook_failover_url).toBe("https://example.com/api/webhooks/telnyx-failover");
    });

    it("omits webhook URLs when not configured", async () => {
      // Ensure webhook vars are not set
      vi.stubEnv("WEBHOOK_BASE_URL", "");
      vi.stubEnv("TELNYX_WEBHOOK_URL", "");

      const payload = {
        to: "+15559876543",
        message: "Test message",
      };

      await smsModule.execute(payload, mockSendConfig);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.webhook_url).toBeUndefined();
      expect(body.webhook_failover_url).toBeUndefined();
    });
  });
});
