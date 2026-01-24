import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getModule, hasModule, listModules, getAllModules } from "../../../modules/index.js";
import { SmsModule } from "../../../modules/sms-module.js";

// Mock fetch for Telnyx API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Module Registry", () => {
  describe("getModule", () => {
    it("returns correct module for email type", () => {
      const module = getModule("email");
      expect(module.type).toBe("email");
      expect(module.name).toBe("Email");
    });

    it("returns correct module for webhook type", () => {
      const module = getModule("webhook");
      expect(module.type).toBe("webhook");
      expect(module.name).toBe("Webhook");
    });

    it("returns correct module for sms type", () => {
      const module = getModule("sms");
      expect(module.type).toBe("sms");
      expect(module.name).toBe("SMS");
    });

    it("throws for unknown module type", () => {
      expect(() => getModule("unknown")).toThrow("Unknown module type: unknown");
    });
  });

  describe("hasModule", () => {
    it("returns true for registered modules", () => {
      expect(hasModule("email")).toBe(true);
      expect(hasModule("webhook")).toBe(true);
      expect(hasModule("sms")).toBe(true);
    });

    it("returns false for unknown modules", () => {
      expect(hasModule("unknown")).toBe(false);
      expect(hasModule("push")).toBe(false); // push not implemented yet
    });
  });

  describe("listModules", () => {
    it("returns all registered module types", () => {
      const types = listModules();
      expect(types).toContain("email");
      expect(types).toContain("webhook");
      expect(types).toContain("sms");
    });

    it("returns array of strings", () => {
      const types = listModules();
      expect(Array.isArray(types)).toBe(true);
      types.forEach((t) => expect(typeof t).toBe("string"));
    });
  });

  describe("getAllModules", () => {
    it("returns all registered modules", () => {
      const modules = getAllModules();
      expect(modules.email).toBeDefined();
      expect(modules.webhook).toBeDefined();
      expect(modules.sms).toBeDefined();
    });

    it("returns a copy (not the original registry)", () => {
      const modules = getAllModules();
      (modules as Record<string, unknown>).fake = {};
      expect(hasModule("fake")).toBe(false);
    });
  });
});

describe("SmsModule", () => {
  const module = new SmsModule();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv("TELNYX_API_KEY", "KEY_test123");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("validateConfig", () => {
    it("fails when service is missing", () => {
      const result = module.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("service is required (telnyx)");
    });

    it("fails for invalid service", () => {
      const result = module.validateConfig({ service: "unknown", fromNumber: "+1234567890" });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('service must be "telnyx"');
    });

    it("fails when fromNumber is missing", () => {
      const result = module.validateConfig({ service: "telnyx" });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("fromNumber is required");
    });

    it("accepts valid Telnyx config", () => {
      const result = module.validateConfig({
        service: "telnyx",
        fromNumber: "+1234567890",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts Telnyx config with messaging profile", () => {
      const result = module.validateConfig({
        service: "telnyx",
        fromNumber: "+1234567890",
        messagingProfileId: "profile_123",
      });
      expect(result.valid).toBe(true);
    });

    it("collects all validation errors", () => {
      const result = module.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("validatePayload", () => {
    it("fails when phone number is missing", () => {
      const result = module.validatePayload({ message: "Hello" });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("to (phone number) is required");
    });

    it("fails for invalid phone format", () => {
      const result = module.validatePayload({
        to: "1234567890", // missing +
        message: "Hello",
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("to must be a valid phone number (E.164 format: +1234567890)");
    });

    it("fails for phone number starting with +0", () => {
      const result = module.validatePayload({
        to: "+0123456789",
        message: "Hello",
      });
      expect(result.valid).toBe(false);
    });

    it("fails when message is missing", () => {
      const result = module.validatePayload({
        to: "+1234567890",
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("message is required");
    });

    it("accepts valid E.164 phone number", () => {
      const result = module.validatePayload({
        to: "+1234567890",
        message: "Hello!",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts valid international phone number", () => {
      const result = module.validatePayload({
        to: "+46701234567",
        message: "Hej!",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts valid long phone number", () => {
      const result = module.validatePayload({
        to: "+123456789012345", // 15 digits
        message: "Hello",
      });
      expect(result.valid).toBe(true);
    });

    it("collects all validation errors", () => {
      const result = module.validatePayload({});
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(1);
    });
  });

  describe("execute", () => {
    const telnyxConfig = {
      id: "test-config",
      userId: "user-123",
      name: "Test SMS Config",
      module: "sms" as const,
      config: {
        service: "telnyx" as const,
        fromNumber: "+1234567890",
      },
      rateLimit: null,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("returns success with Telnyx provider", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "msg-12345" } }),
      });

      const result = await module.execute(
        { to: "+1987654321", message: "Hello!" },
        telnyxConfig
      );
      expect(result.success).toBe(true);
    });

    it("returns providerMessageId", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "msg-12345" } }),
      });

      const result = await module.execute(
        { to: "+1987654321", message: "Hello!" },
        telnyxConfig
      );
      expect(result.providerMessageId).toBe("msg-12345");
    });

    it("includes latencyMs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "msg-12345" } }),
      });

      const result = await module.execute(
        { to: "+1987654321", message: "Hello!" },
        telnyxConfig
      );
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("handles Telnyx API errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ errors: [{ detail: "Invalid phone number format" }] }),
      });

      const result = await module.execute(
        { to: "+1987654321", message: "Hello!" },
        telnyxConfig
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid phone number format");
    });

    it("handles missing API key", async () => {
      vi.stubEnv("TELNYX_API_KEY", "");

      const result = await module.execute(
        { to: "+1987654321", message: "Hello!" },
        telnyxConfig
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("TELNYX_API_KEY");
    });
  });
});
