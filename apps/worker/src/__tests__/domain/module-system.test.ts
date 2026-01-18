import { describe, it, expect } from "vitest";
import { getModule, hasModule, listModules, getAllModules } from "../../modules/index.js";
import { SmsModule } from "../../modules/sms-module.js";

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
      modules.fake = {} as any;
      expect(hasModule("fake")).toBe(false);
    });
  });
});

describe("SmsModule", () => {
  const module = new SmsModule();

  describe("validateConfig", () => {
    it("fails when provider is missing", () => {
      const result = module.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("provider is required (twilio, aws-sns, or mock)");
    });

    it("fails for invalid provider", () => {
      const result = module.validateConfig({ provider: "unknown", fromNumber: "+1234567890" });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('provider must be "twilio", "aws-sns", or "mock"');
    });

    it("fails when fromNumber is missing", () => {
      const result = module.validateConfig({ provider: "mock" });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("fromNumber is required");
    });

    it("fails when Twilio accountSid is missing", () => {
      const result = module.validateConfig({
        provider: "twilio",
        fromNumber: "+1234567890",
        authToken: "token123",
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("accountSid is required for Twilio");
    });

    it("fails when Twilio authToken is missing", () => {
      const result = module.validateConfig({
        provider: "twilio",
        fromNumber: "+1234567890",
        accountSid: "AC123",
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("authToken is required for Twilio");
    });

    it("fails when AWS SNS region is missing", () => {
      const result = module.validateConfig({
        provider: "aws-sns",
        fromNumber: "+1234567890",
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("region is required for AWS SNS");
    });

    it("accepts valid mock config", () => {
      const result = module.validateConfig({
        provider: "mock",
        fromNumber: "+1234567890",
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts valid Twilio config", () => {
      const result = module.validateConfig({
        provider: "twilio",
        fromNumber: "+1234567890",
        accountSid: "AC1234567890",
        authToken: "auth_token_here",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts valid AWS SNS config", () => {
      const result = module.validateConfig({
        provider: "aws-sns",
        fromNumber: "+1234567890",
        region: "us-east-1",
      });
      expect(result.valid).toBe(true);
    });

    it("collects all validation errors", () => {
      const result = module.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(1);
    });
  });

  describe("validatePayload", () => {
    it("fails when phone number is missing", () => {
      const result = module.validatePayload({ message: "Hello" } as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("to (phone number) is required");
    });

    it("fails for invalid phone format", () => {
      const result = module.validatePayload({
        to: "1234567890", // missing +
        message: "Hello",
      } as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("to must be a valid phone number (E.164 format: +1234567890)");
    });

    it("fails for phone number starting with +0", () => {
      const result = module.validatePayload({
        to: "+0123456789",
        message: "Hello",
      } as any);
      expect(result.valid).toBe(false);
    });

    it("fails when message is missing", () => {
      const result = module.validatePayload({
        to: "+1234567890",
      } as any);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("message is required");
    });

    it("accepts valid E.164 phone number", () => {
      const result = module.validatePayload({
        to: "+1234567890",
        message: "Hello!",
      } as any);
      expect(result.valid).toBe(true);
    });

    it("accepts valid international phone number", () => {
      const result = module.validatePayload({
        to: "+46701234567",
        message: "Hej!",
      } as any);
      expect(result.valid).toBe(true);
    });

    it("accepts valid long phone number", () => {
      const result = module.validatePayload({
        to: "+123456789012345", // 15 digits
        message: "Hello",
      } as any);
      expect(result.valid).toBe(true);
    });

    it("collects all validation errors", () => {
      const result = module.validatePayload({} as any);
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(1);
    });
  });

  describe("execute", () => {
    const mockConfig = {
      id: "test-config",
      userId: "user-123",
      name: "Test SMS Config",
      module: "sms" as const,
      config: {
        provider: "mock" as const,
        fromNumber: "+1234567890",
      },
      rateLimit: null,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("returns success with mock provider", async () => {
      const result = await module.execute(
        { to: "+1987654321", message: "Hello!" } as any,
        mockConfig
      );
      expect(result.success).toBe(true);
    });

    it("returns providerMessageId", async () => {
      const result = await module.execute(
        { to: "+1987654321", message: "Hello!" } as any,
        mockConfig
      );
      expect(result.providerMessageId).toBeDefined();
      expect(result.providerMessageId).toMatch(/^mock-sms-\d+-[a-z0-9]+$/);
    });

    it("includes latencyMs", async () => {
      const result = await module.execute(
        { to: "+1987654321", message: "Hello!" } as any,
        mockConfig
      );
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("generates unique message IDs", async () => {
      const results = await Promise.all([
        module.execute({ to: "+1987654321", message: "1" } as any, mockConfig),
        module.execute({ to: "+1987654321", message: "2" } as any, mockConfig),
        module.execute({ to: "+1987654321", message: "3" } as any, mockConfig),
      ]);

      const ids = results.map((r) => r.providerMessageId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });

    it("handles unknown provider gracefully", async () => {
      const badConfig = {
        ...mockConfig,
        config: { provider: "unknown" as any, fromNumber: "+1234567890" },
      };
      const result = await module.execute(
        { to: "+1987654321", message: "Hello!" } as any,
        badConfig
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown SMS provider");
    });
  });
});
