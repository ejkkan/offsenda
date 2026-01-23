import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockEmailProvider } from "../../../providers/mock-provider.js";
import type { SendEmailRequest } from "../../../providers/types.js";

describe("MockEmailProvider", () => {
  const testEmail: SendEmailRequest = {
    to: "test@example.com",
    from: "sender@example.com",
    subject: "Test Subject",
    text: "Test body",
  };

  describe("success mode", () => {
    it("should always succeed in success mode", async () => {
      const provider = new MockEmailProvider({ mode: "success", latencyMs: 0 });

      const results = await Promise.all([
        provider.send(testEmail),
        provider.send(testEmail),
        provider.send(testEmail),
      ]);

      expect(results.every((r) => r.success)).toBe(true);
      expect(results.every((r) => r.providerMessageId)).toBe(true);
    });

    it("should generate unique message IDs", async () => {
      const provider = new MockEmailProvider({ mode: "success", latencyMs: 0 });

      const results = await Promise.all([
        provider.send(testEmail),
        provider.send(testEmail),
        provider.send(testEmail),
      ]);

      const messageIds = results.map((r) => r.providerMessageId);
      const uniqueIds = new Set(messageIds);

      expect(uniqueIds.size).toBe(3);
    });
  });

  describe("fail mode", () => {
    it("should always fail in fail mode", async () => {
      const provider = new MockEmailProvider({ mode: "fail", latencyMs: 0 });

      const results = await Promise.all([
        provider.send(testEmail),
        provider.send(testEmail),
        provider.send(testEmail),
      ]);

      expect(results.every((r) => r.success === false)).toBe(true);
      expect(results.every((r) => r.error === "Simulated failure")).toBe(true);
    });
  });

  describe("random mode", () => {
    it("should respect failure rate in random mode", async () => {
      // Use a fixed seed for deterministic testing
      const mockRandom = vi.spyOn(Math, "random");

      const provider = new MockEmailProvider({
        mode: "random",
        failureRate: 0.5,
        latencyMs: 0,
      });

      // Test with controlled random values
      mockRandom.mockReturnValueOnce(0.3); // < 0.5, should fail
      mockRandom.mockReturnValueOnce(0.7); // > 0.5, should succeed
      mockRandom.mockReturnValueOnce(0.1); // < 0.5, should fail
      mockRandom.mockReturnValueOnce(0.9); // > 0.5, should succeed

      const results = await Promise.all([
        provider.send(testEmail),
        provider.send(testEmail),
        provider.send(testEmail),
        provider.send(testEmail),
      ]);

      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(false);
      expect(results[3].success).toBe(true);

      mockRandom.mockRestore();
    });
  });

  describe("latency simulation", () => {
    it("should simulate latency", async () => {
      const provider = new MockEmailProvider({ mode: "success", latencyMs: 100 });

      const start = Date.now();
      await provider.send(testEmail);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow some variance
    });

    it("should have no latency when set to 0", async () => {
      const provider = new MockEmailProvider({ mode: "success", latencyMs: 0 });

      const start = Date.now();
      await provider.send(testEmail);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });

  describe("sendBatch", () => {
    it("should send multiple emails", async () => {
      const provider = new MockEmailProvider({ mode: "success", latencyMs: 0 });

      const emails: SendEmailRequest[] = [
        { ...testEmail, to: "user1@example.com" },
        { ...testEmail, to: "user2@example.com" },
        { ...testEmail, to: "user3@example.com" },
      ];

      const results = await provider.sendBatch(emails);

      expect(results.length).toBe(3);
      expect(results.every((r) => r.success)).toBe(true);
    });
  });
});
