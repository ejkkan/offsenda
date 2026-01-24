import { describe, it, expect } from "vitest";
import {
  buildManagedContext,
  buildManagedEmailContext,
  buildManagedSmsContext,
  isEmailManagedMode,
  isSmsManagedMode,
} from "../../../rate-limiting/managed-flow.js";
import {
  buildByokContext,
  buildByokEmailContext,
  buildByokSmsContext,
  buildByokWebhookContext,
} from "../../../rate-limiting/byok-flow.js";
import type { EmailModuleConfig, SmsModuleConfig } from "@batchsender/db";

describe("Managed Flow Builder", () => {
  describe("buildManagedEmailContext", () => {
    it("should create context with managed mode for Resend", () => {
      const config: EmailModuleConfig = {
        service: "resend",
        fromEmail: "sender@example.com",
      };

      const context = buildManagedEmailContext(config, "cfg_123", "user_456");

      expect(context.mode).toBe("managed");
      expect(context.module).toBe("email");
      expect(context.provider).toBe("resend");
      expect(context.sendConfigId).toBe("cfg_123");
      expect(context.userId).toBe("user_456");
    });

    it("should create context with managed mode for SES", () => {
      const config: EmailModuleConfig = {
        service: "ses",
        fromEmail: "sender@example.com",
      };

      const context = buildManagedEmailContext(config, "cfg_123", "user_456");

      expect(context.mode).toBe("managed");
      expect(context.provider).toBe("ses");
    });
  });

  describe("buildManagedSmsContext", () => {
    it("should create context with managed mode for Telnyx", () => {
      const config: SmsModuleConfig = {
        service: "telnyx",
        fromNumber: "+1234567890",
      };

      const context = buildManagedSmsContext(config, "cfg_789", "user_012");

      expect(context.mode).toBe("managed");
      expect(context.module).toBe("sms");
      expect(context.provider).toBe("telnyx");
      expect(context.sendConfigId).toBe("cfg_789");
      expect(context.userId).toBe("user_012");
    });
  });

  describe("buildManagedContext", () => {
    it("should route to email context for email module", () => {
      const config: EmailModuleConfig = {
        service: "resend",
        fromEmail: "sender@example.com",
      };

      const context = buildManagedContext("email", config, "cfg_email", "user_email");

      expect(context.mode).toBe("managed");
      expect(context.module).toBe("email");
      expect(context.provider).toBe("resend");
    });

    it("should route to SMS context for sms module", () => {
      const config: SmsModuleConfig = {
        service: "telnyx",
        fromNumber: "+1234567890",
      };

      const context = buildManagedContext("sms", config, "cfg_sms", "user_sms");

      expect(context.mode).toBe("managed");
      expect(context.module).toBe("sms");
      expect(context.provider).toBe("telnyx");
    });
  });

  describe("isEmailManagedMode", () => {
    it("should always return true (platform service only)", () => {
      const config: EmailModuleConfig = {
        service: "resend",
        fromEmail: "sender@example.com",
      };
      expect(isEmailManagedMode(config)).toBe(true);
    });

    it("should return true for SES as well", () => {
      const config: EmailModuleConfig = {
        service: "ses",
        fromEmail: "sender@example.com",
      };
      expect(isEmailManagedMode(config)).toBe(true);
    });
  });

  describe("isSmsManagedMode", () => {
    it("should always return true (platform service only)", () => {
      const config: SmsModuleConfig = {
        service: "telnyx",
        fromNumber: "+1234567890",
      };
      expect(isSmsManagedMode(config)).toBe(true);
    });
  });
});

describe("BYOK Flow Builder", () => {
  describe("buildByokWebhookContext", () => {
    it("should create context with byok mode for webhook", () => {
      const context = buildByokWebhookContext("cfg_webhook", "user_webhook");

      expect(context.mode).toBe("byok");
      expect(context.provider).toBe("webhook");
      expect(context.sendConfigId).toBe("cfg_webhook");
      expect(context.userId).toBe("user_webhook");
    });
  });

  describe("buildByokContext", () => {
    it("should return webhook context for any module type", () => {
      const config = { url: "https://example.com/webhook" };

      const context = buildByokContext("email", config, "cfg_e", "user_e");

      expect(context.mode).toBe("byok");
      expect(context.provider).toBe("webhook");
    });
  });

  describe("legacy buildByokEmailContext (deprecated)", () => {
    it("should return webhook context (email BYOK no longer supported)", () => {
      const context = buildByokEmailContext({}, "cfg_byok", "user_byok");

      expect(context.mode).toBe("byok");
      expect(context.provider).toBe("webhook");
    });
  });

  describe("legacy buildByokSmsContext (deprecated)", () => {
    it("should return webhook context (SMS BYOK no longer supported)", () => {
      const context = buildByokSmsContext({}, "cfg_sms_byok", "user_sms_byok");

      expect(context.mode).toBe("byok");
      expect(context.provider).toBe("webhook");
    });
  });
});
