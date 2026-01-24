import { describe, it, expect } from "vitest";
import { EmailModule } from "../../../modules/email-module.js";
import { WebhookModule } from "../../../modules/webhook-module.js";

describe("EmailModule.validateConfig", () => {
  const module = new EmailModule();

  describe("service validation", () => {
    it("should fail when service is missing", () => {
      const result = module.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("service is required (ses or resend)");
    });

    it("should fail for invalid service", () => {
      const result = module.validateConfig({ service: "invalid" });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('service must be "ses" or "resend"');
    });

    it("should fail when fromEmail is missing", () => {
      const result = module.validateConfig({ service: "resend" });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("fromEmail is required");
    });

    it("should accept resend service with required fields", () => {
      const result = module.validateConfig({
        service: "resend",
        fromEmail: "sender@example.com",
      });
      expect(result.valid).toBe(true);
    });

    it("should accept ses service with required fields", () => {
      const result = module.validateConfig({
        service: "ses",
        fromEmail: "sender@example.com",
      });
      expect(result.valid).toBe(true);
    });

    it("should accept optional fromName", () => {
      const result = module.validateConfig({
        service: "resend",
        fromEmail: "sender@example.com",
        fromName: "Sender Name",
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("multiple errors", () => {
    it("should collect all errors", () => {
      const result = module.validateConfig({
        // missing service and fromEmail
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("EmailModule.validatePayload", () => {
  const module = new EmailModule();

  it("should validate complete payload", () => {
    const result = module.validatePayload({
      to: "user@example.com",
      subject: "Test Subject",
      htmlContent: "<p>Hello</p>",
    });
    expect(result.valid).toBe(true);
  });

  it("should fail for missing to", () => {
    const result = module.validatePayload({
      subject: "Test",
      htmlContent: "<p>Hello</p>",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("to (email address) is required");
  });

  it("should fail for invalid email", () => {
    const result = module.validatePayload({
      to: "not-an-email",
      subject: "Test",
      htmlContent: "<p>Hello</p>",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("to must be a valid email address");
  });

  it("should fail for missing subject", () => {
    const result = module.validatePayload({
      to: "user@example.com",
      htmlContent: "<p>Hello</p>",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("subject is required");
  });

  it("should fail for missing content", () => {
    const result = module.validatePayload({
      to: "user@example.com",
      subject: "Test",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("htmlContent or textContent is required");
  });

  it("should accept textContent without htmlContent", () => {
    const result = module.validatePayload({
      to: "user@example.com",
      subject: "Test",
      textContent: "Hello plain text",
    });
    expect(result.valid).toBe(true);
  });
});

describe("WebhookModule.validateConfig", () => {
  const module = new WebhookModule();

  describe("url validation", () => {
    it("should fail when url is missing", () => {
      const result = module.validateConfig({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("url is required");
    });

    it("should fail for invalid url", () => {
      const result = module.validateConfig({ url: "not-a-url" });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("url must be a valid URL");
    });

    it("should fail for non-http protocol", () => {
      const result = module.validateConfig({ url: "ftp://example.com/webhook" });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("url must use http or https protocol");
    });

    it("should accept https url", () => {
      const result = module.validateConfig({ url: "https://example.com/webhook" });
      expect(result.valid).toBe(true);
    });

    it("should accept http url", () => {
      const result = module.validateConfig({ url: "http://localhost:3000/webhook" });
      expect(result.valid).toBe(true);
    });
  });

  describe("method validation", () => {
    it("should accept POST method", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        method: "POST",
      });
      expect(result.valid).toBe(true);
    });

    it("should accept PUT method", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        method: "PUT",
      });
      expect(result.valid).toBe(true);
    });

    it("should fail for invalid method", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        method: "GET",
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('method must be "POST" or "PUT"');
    });
  });

  describe("timeout validation", () => {
    it("should accept valid timeout", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        timeout: 5000,
      });
      expect(result.valid).toBe(true);
    });

    it("should fail for timeout below minimum", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        timeout: 500,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("timeout must be between 1000 and 60000 milliseconds");
    });

    it("should fail for timeout above maximum", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        timeout: 120000,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("timeout must be between 1000 and 60000 milliseconds");
    });

    it("should fail for non-number timeout", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        timeout: "5000" as unknown,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("timeout must be between 1000 and 60000 milliseconds");
    });
  });

  describe("retries validation", () => {
    it("should accept valid retries", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        retries: 5,
      });
      expect(result.valid).toBe(true);
    });

    it("should accept zero retries", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        retries: 0,
      });
      expect(result.valid).toBe(true);
    });

    it("should fail for negative retries", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        retries: -1,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("retries must be between 0 and 10");
    });

    it("should fail for retries above maximum", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        retries: 15,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("retries must be between 0 and 10");
    });
  });

  describe("successStatusCodes validation", () => {
    it("should accept valid status codes array", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        successStatusCodes: [200, 201, 204],
      });
      expect(result.valid).toBe(true);
    });

    it("should fail for non-array successStatusCodes", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        successStatusCodes: "200" as unknown,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("successStatusCodes must be an array");
    });

    it("should fail for non-number status codes", () => {
      const result = module.validateConfig({
        url: "https://example.com/webhook",
        successStatusCodes: [200, "201"] as unknown as number[],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("successStatusCodes must contain only numbers");
    });
  });

  describe("complete config", () => {
    it("should accept fully configured webhook", () => {
      const result = module.validateConfig({
        url: "https://api.example.com/webhooks/email",
        method: "POST",
        timeout: 15000,
        retries: 3,
        successStatusCodes: [200, 201, 202],
        headers: {
          "X-API-Key": "secret-key",
          "X-Custom-Header": "custom-value",
        },
      });
      expect(result.valid).toBe(true);
    });
  });
});

describe("WebhookModule.validatePayload", () => {
  const module = new WebhookModule();

  it("should accept any payload", () => {
    const result = module.validatePayload({});
    expect(result.valid).toBe(true);
  });

  it("should accept payload with data", () => {
    const result = module.validatePayload({
      data: { customField: "value" },
    });
    expect(result.valid).toBe(true);
  });

  it("should accept payload with email fields", () => {
    const result = module.validatePayload({
      to: "user@example.com",
      name: "Test User",
      subject: "Hello",
    });
    expect(result.valid).toBe(true);
  });
});
