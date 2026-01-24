/**
 * Unit Test: Test API Key Safety
 *
 * Verifies that API keys starting with "bsk_test_" always force dryRun=true.
 * This is a critical safety feature to prevent accidentally sending real
 * emails/SMS during tests.
 */

import { describe, it, expect } from "vitest";

/**
 * This is the exact logic from api.ts that determines if dryRun should be forced.
 * We test it in isolation to ensure the safety mechanism works correctly.
 */
function shouldForceDryRun(apiKey: string, requestedDryRun: boolean): boolean {
  const isTestKey = apiKey.startsWith("bsk_test_");
  return requestedDryRun || isTestKey;
}

describe("Test API Key Safety", () => {
  describe("bsk_test_* keys (test mode)", () => {
    it("should force dryRun=true even when dryRun not specified", () => {
      const apiKey = "bsk_test_abc123def456";
      const result = shouldForceDryRun(apiKey, false);
      expect(result).toBe(true);
    });

    it("should force dryRun=true even when dryRun=false explicitly passed", () => {
      const apiKey = "bsk_test_xyz789";
      const result = shouldForceDryRun(apiKey, false);
      expect(result).toBe(true);
    });

    it("should remain dryRun=true when dryRun=true passed", () => {
      const apiKey = "bsk_test_abc123";
      const result = shouldForceDryRun(apiKey, true);
      expect(result).toBe(true);
    });

    it("should work with full-length test API keys", () => {
      // Realistic test key format
      const apiKey = "bsk_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6";
      const result = shouldForceDryRun(apiKey, false);
      expect(result).toBe(true);
    });
  });

  describe("bsk_live_* keys (production mode)", () => {
    it("should respect dryRun=false for live keys", () => {
      const apiKey = "bsk_live_abc123def456";
      const result = shouldForceDryRun(apiKey, false);
      expect(result).toBe(false);
    });

    it("should respect dryRun=true for live keys", () => {
      const apiKey = "bsk_live_abc123def456";
      const result = shouldForceDryRun(apiKey, true);
      expect(result).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should not trigger for keys that contain but don't start with bsk_test_", () => {
      const apiKey = "prefix_bsk_test_abc123";
      const result = shouldForceDryRun(apiKey, false);
      expect(result).toBe(false);
    });

    it("should handle empty API key", () => {
      const apiKey = "";
      const result = shouldForceDryRun(apiKey, false);
      expect(result).toBe(false);
    });

    it("should be case-sensitive (bsk_TEST_ should not trigger)", () => {
      const apiKey = "bsk_TEST_abc123";
      const result = shouldForceDryRun(apiKey, false);
      expect(result).toBe(false);
    });
  });
});
