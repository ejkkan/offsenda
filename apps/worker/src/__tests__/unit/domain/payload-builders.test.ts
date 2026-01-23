import { describe, it, expect } from "vitest";
import {
  buildEmailPayload,
  validateEmailPayload,
  buildSmsPayload,
  validateSmsPayload,
  buildPushPayload,
  validatePushPayload,
  buildWebhookPayload,
  validateWebhookPayload,
  buildJobPayload,
} from "../../../domain/payload-builders/index.js";

describe("buildEmailPayload", () => {
  const baseRecipient = {
    identifier: "user@example.com",
    name: "Test User",
    variables: { firstName: "Test" },
  };

  it("should build payload with recipient info", () => {
    const payload = buildEmailPayload({
      config: {},
      batchPayload: {},
      legacyFields: {},
      recipient: baseRecipient,
    });

    expect(payload.to).toBe("user@example.com");
    expect(payload.name).toBe("Test User");
    expect(payload.variables).toEqual({ firstName: "Test" });
  });

  it("should prioritize batchPayload over legacyFields", () => {
    const payload = buildEmailPayload({
      config: { fromEmail: "config@example.com" },
      batchPayload: { fromEmail: "batch@example.com", subject: "Batch Subject" },
      legacyFields: { fromEmail: "legacy@example.com", subject: "Legacy Subject" },
      recipient: baseRecipient,
    });

    expect(payload.fromEmail).toBe("batch@example.com");
    expect(payload.subject).toBe("Batch Subject");
  });

  it("should prioritize legacyFields over config", () => {
    const payload = buildEmailPayload({
      config: { fromEmail: "config@example.com", fromName: "Config Name" },
      batchPayload: {},
      legacyFields: { fromEmail: "legacy@example.com" },
      recipient: baseRecipient,
    });

    expect(payload.fromEmail).toBe("legacy@example.com");
    expect(payload.fromName).toBe("Config Name"); // falls back to config
  });

  it("should use config as fallback", () => {
    const payload = buildEmailPayload({
      config: { fromEmail: "config@example.com", fromName: "Config Name" },
      batchPayload: {},
      legacyFields: {},
      recipient: baseRecipient,
    });

    expect(payload.fromEmail).toBe("config@example.com");
    expect(payload.fromName).toBe("Config Name");
  });

  it("should include all content fields", () => {
    const payload = buildEmailPayload({
      config: {},
      batchPayload: {
        subject: "Test Subject",
        htmlContent: "<h1>Hello</h1>",
        textContent: "Hello",
      },
      legacyFields: {},
      recipient: baseRecipient,
    });

    expect(payload.subject).toBe("Test Subject");
    expect(payload.htmlContent).toBe("<h1>Hello</h1>");
    expect(payload.textContent).toBe("Hello");
  });
});

describe("validateEmailPayload", () => {
  it("should validate complete payload", () => {
    const result = validateEmailPayload({
      to: "user@example.com",
      fromEmail: "sender@example.com",
      subject: "Test",
      htmlContent: "<p>Hello</p>",
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should fail for missing to", () => {
    const result = validateEmailPayload({
      to: "",
      fromEmail: "sender@example.com",
      subject: "Test",
      htmlContent: "<p>Hello</p>",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing recipient email address (to)");
  });

  it("should fail for missing fromEmail", () => {
    const result = validateEmailPayload({
      to: "user@example.com",
      subject: "Test",
      htmlContent: "<p>Hello</p>",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing sender email address (fromEmail)");
  });

  it("should fail for missing subject", () => {
    const result = validateEmailPayload({
      to: "user@example.com",
      fromEmail: "sender@example.com",
      htmlContent: "<p>Hello</p>",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing email subject");
  });

  it("should fail for missing content", () => {
    const result = validateEmailPayload({
      to: "user@example.com",
      fromEmail: "sender@example.com",
      subject: "Test",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing email content (htmlContent or textContent required)");
  });

  it("should accept textContent only", () => {
    const result = validateEmailPayload({
      to: "user@example.com",
      fromEmail: "sender@example.com",
      subject: "Test",
      textContent: "Hello",
    });

    expect(result.valid).toBe(true);
  });

  it("should collect all errors", () => {
    const result = validateEmailPayload({
      to: "",
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe("buildSmsPayload", () => {
  const baseRecipient = {
    identifier: "+1234567890",
    name: "Test User",
  };

  it("should build payload with recipient info", () => {
    const payload = buildSmsPayload({
      config: {},
      batchPayload: { message: "Hello!" },
      recipient: baseRecipient,
    });

    expect(payload.to).toBe("+1234567890");
    expect(payload.name).toBe("Test User");
    expect(payload.message).toBe("Hello!");
  });

  it("should prioritize batchPayload over config", () => {
    const payload = buildSmsPayload({
      config: { fromNumber: "+1111111111" },
      batchPayload: { fromNumber: "+2222222222" },
      recipient: baseRecipient,
    });

    expect(payload.fromNumber).toBe("+2222222222");
  });
});

describe("validateSmsPayload", () => {
  it("should validate complete payload", () => {
    const result = validateSmsPayload({
      to: "+1234567890",
      message: "Hello!",
    });

    expect(result.valid).toBe(true);
  });

  it("should fail for missing to", () => {
    const result = validateSmsPayload({
      to: "",
      message: "Hello!",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing recipient phone number (to)");
  });

  it("should fail for missing message", () => {
    const result = validateSmsPayload({
      to: "+1234567890",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing SMS message");
  });
});

describe("buildPushPayload", () => {
  const baseRecipient = {
    identifier: "device-token-123",
    name: "Test User",
  };

  it("should build payload with recipient info", () => {
    const payload = buildPushPayload({
      config: {},
      batchPayload: { title: "Hello", body: "World" },
      recipient: baseRecipient,
    });

    expect(payload.to).toBe("device-token-123");
    expect(payload.title).toBe("Hello");
    expect(payload.body).toBe("World");
  });

  it("should include data payload", () => {
    const payload = buildPushPayload({
      config: {},
      batchPayload: { title: "Hello", data: { key: "value" } },
      recipient: baseRecipient,
    });

    expect(payload.data).toEqual({ key: "value" });
  });
});

describe("validatePushPayload", () => {
  it("should validate complete payload", () => {
    const result = validatePushPayload({
      to: "device-token",
      title: "Hello",
    });

    expect(result.valid).toBe(true);
  });

  it("should accept body without title", () => {
    const result = validatePushPayload({
      to: "device-token",
      body: "Message body",
    });

    expect(result.valid).toBe(true);
  });

  it("should fail for missing content", () => {
    const result = validatePushPayload({
      to: "device-token",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing push notification content (title or body required)");
  });
});

describe("buildWebhookPayload", () => {
  const baseRecipient = {
    identifier: "https://webhook.example.com",
  };

  it("should build payload with recipient info", () => {
    const payload = buildWebhookPayload({
      config: {},
      batchPayload: { body: { key: "value" } },
      recipient: baseRecipient,
    });

    expect(payload.to).toBe("https://webhook.example.com");
    expect(payload.data).toEqual({ key: "value" });
  });

  it("should use webhookData if no batchPayload body", () => {
    const payload = buildWebhookPayload({
      config: {},
      batchPayload: {},
      recipient: baseRecipient,
      webhookData: { webhook: "data" },
    });

    expect(payload.data).toEqual({ webhook: "data" });
  });

  it("should prioritize batchPayload body over webhookData", () => {
    const payload = buildWebhookPayload({
      config: {},
      batchPayload: { body: { batch: "body" } },
      recipient: baseRecipient,
      webhookData: { webhook: "data" },
    });

    expect(payload.data).toEqual({ batch: "body" });
  });
});

describe("validateWebhookPayload", () => {
  it("should validate complete payload", () => {
    const result = validateWebhookPayload({
      to: "https://webhook.example.com",
    });

    expect(result.valid).toBe(true);
  });

  it("should fail for missing to", () => {
    const result = validateWebhookPayload({
      to: "",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing webhook target (to)");
  });
});

describe("buildJobPayload", () => {
  const baseRecipient = {
    identifier: "test@example.com",
  };

  it("should route to email builder", () => {
    const payload = buildJobPayload({
      sendConfig: { id: "1", module: "email", config: {} },
      batchPayload: { subject: "Test" },
      legacyFields: {},
      recipient: baseRecipient,
    });

    expect(payload.to).toBe("test@example.com");
    expect((payload as any).subject).toBe("Test");
  });

  it("should route to sms builder", () => {
    const payload = buildJobPayload({
      sendConfig: { id: "1", module: "sms", config: {} },
      batchPayload: { message: "Hello" },
      legacyFields: {},
      recipient: { identifier: "+1234567890" },
    });

    expect(payload.to).toBe("+1234567890");
    expect((payload as any).message).toBe("Hello");
  });

  it("should route to push builder", () => {
    const payload = buildJobPayload({
      sendConfig: { id: "1", module: "push", config: {} },
      batchPayload: { title: "Alert" },
      legacyFields: {},
      recipient: { identifier: "device-token" },
    });

    expect(payload.to).toBe("device-token");
    expect((payload as any).title).toBe("Alert");
  });

  it("should route to webhook builder", () => {
    const payload = buildJobPayload({
      sendConfig: { id: "1", module: "webhook", config: {} },
      batchPayload: {},
      legacyFields: {},
      recipient: { identifier: "https://example.com" },
      webhookData: { key: "value" },
    });

    expect(payload.to).toBe("https://example.com");
    expect((payload as any).data).toEqual({ key: "value" });
  });

  it("should throw for unknown module type", () => {
    expect(() =>
      buildJobPayload({
        sendConfig: { id: "1", module: "unknown" as any, config: {} },
        batchPayload: {},
        legacyFields: {},
        recipient: baseRecipient,
      })
    ).toThrow("Unknown module type: unknown");
  });
});
