import { describe, it, expect, vi } from "vitest";
import {
  buildManagedContext,
  buildManagedEmailContext,
  buildManagedSmsContext,
  isEmailManagedMode,
  isSmsManagedMode,
} from "../../rate-limiting/managed-flow.js";
import {
  buildByokContext,
  buildByokEmailContext,
  buildByokSmsContext,
} from "../../rate-limiting/byok-flow.js";
import type { EmailModuleConfig, SmsModuleConfig } from "@batchsender/db";

describe("Managed Flow Builder", () => {
  describe("buildManagedEmailContext", () => {
    it("should create context with managed mode", () => {
      const context = buildManagedEmailContext("cfg_123", "user_456");

      expect(context.mode).toBe("managed");
      expect(context.module).toBe("email");
      expect(context.sendConfigId).toBe("cfg_123");
      expect(context.userId).toBe("user_456");
    });

    it("should use EMAIL_PROVIDER from config", () => {
      // Default is resend
      const context = buildManagedEmailContext("cfg_123", "user_456");
      expect(["ses", "resend", "mock"]).toContain(context.provider);
    });
  });

  describe("buildManagedSmsContext", () => {
    it("should create context with managed mode", () => {
      const context = buildManagedSmsContext("cfg_789", "user_012");

      expect(context.mode).toBe("managed");
      expect(context.module).toBe("sms");
      expect(context.sendConfigId).toBe("cfg_789");
      expect(context.userId).toBe("user_012");
    });

    it("should use SMS_PROVIDER from config", () => {
      const context = buildManagedSmsContext("cfg_789", "user_012");
      expect(["telnyx", "mock"]).toContain(context.provider);
    });
  });

  describe("buildManagedContext", () => {
    it("should route to email context for email module", () => {
      const context = buildManagedContext("email", "cfg_email", "user_email");

      expect(context.mode).toBe("managed");
      expect(context.module).toBe("email");
    });

    it("should route to SMS context for sms module", () => {
      const context = buildManagedContext("sms", "cfg_sms", "user_sms");

      expect(context.mode).toBe("managed");
      expect(context.module).toBe("sms");
    });
  });

  describe("isEmailManagedMode", () => {
    it("should return true for managed mode", () => {
      const config: EmailModuleConfig = { mode: "managed" };
      expect(isEmailManagedMode(config)).toBe(true);
    });

    it("should return false for byok mode", () => {
      const config: EmailModuleConfig = {
        mode: "byok",
        provider: "resend",
        apiKey: "test_key",
      };
      expect(isEmailManagedMode(config)).toBe(false);
    });
  });

  describe("isSmsManagedMode", () => {
    it("should return true for managed mode", () => {
      const config: SmsModuleConfig = {
        mode: "managed",
        provider: "telnyx",
      };
      expect(isSmsManagedMode(config)).toBe(true);
    });

    it("should return false for byok mode", () => {
      const config: SmsModuleConfig = {
        mode: "byok",
        provider: "telnyx",
        apiKey: "test_key",
        fromNumber: "+1234567890",
      };
      expect(isSmsManagedMode(config)).toBe(false);
    });

    it("should return false when mode is not specified (backwards compat)", () => {
      const config: SmsModuleConfig = {
        provider: "telnyx",
        apiKey: "test_key",
        fromNumber: "+1234567890",
      };
      expect(isSmsManagedMode(config)).toBe(false);
    });
  });
});

describe("BYOK Flow Builder", () => {
  describe("buildByokEmailContext", () => {
    it("should create context with byok mode", () => {
      const config: EmailModuleConfig = {
        mode: "byok",
        provider: "resend",
        apiKey: "test_key",
      };

      const context = buildByokEmailContext(config, "cfg_byok", "user_byok");

      expect(context.mode).toBe("byok");
      expect(context.module).toBe("email");
      expect(context.provider).toBe("resend");
      expect(context.sendConfigId).toBe("cfg_byok");
      expect(context.userId).toBe("user_byok");
    });

    it("should extract provider from config", () => {
      const sesConfig: EmailModuleConfig = {
        mode: "byok",
        provider: "ses",
        apiKey: "access:secret",
      };

      const context = buildByokEmailContext(sesConfig, "cfg_ses", "user_ses");
      expect(context.provider).toBe("ses");
    });
  });

  describe("buildByokSmsContext", () => {
    it("should create context with byok mode", () => {
      const config: SmsModuleConfig = {
        provider: "telnyx",
        apiKey: "test_key",
        fromNumber: "+1234567890",
      };

      const context = buildByokSmsContext(config, "cfg_sms_byok", "user_sms_byok");

      expect(context.mode).toBe("byok");
      expect(context.module).toBe("sms");
      expect(context.provider).toBe("telnyx");
      expect(context.sendConfigId).toBe("cfg_sms_byok");
      expect(context.userId).toBe("user_sms_byok");
    });

    it("should extract provider from config", () => {
      const twilioConfig: SmsModuleConfig = {
        provider: "twilio",
        accountSid: "test_sid",
        authToken: "test_token",
        fromNumber: "+1234567890",
      };

      const context = buildByokSmsContext(twilioConfig, "cfg_twilio", "user_twilio");
      expect(context.provider).toBe("twilio");
    });
  });

  describe("buildByokContext", () => {
    it("should route to email context for email module", () => {
      const config: EmailModuleConfig = {
        mode: "byok",
        provider: "resend",
        apiKey: "test_key",
      };

      const context = buildByokContext("email", config, "cfg_e", "user_e");

      expect(context.mode).toBe("byok");
      expect(context.module).toBe("email");
    });

    it("should route to SMS context for sms module", () => {
      const config: SmsModuleConfig = {
        provider: "telnyx",
        apiKey: "test_key",
        fromNumber: "+1234567890",
      };

      const context = buildByokContext("sms", config, "cfg_s", "user_s");

      expect(context.mode).toBe("byok");
      expect(context.module).toBe("sms");
    });
  });
});
