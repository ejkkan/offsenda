/**
 * Integration test: SMS Module Flow
 *
 * Tests the SMS module integration:
 * - Module registration and lookup
 * - Config validation
 * - Payload building
 * - Mock execution
 *
 * Does not require external services (uses mock provider)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "@batchsender/db";
import type { SmsModuleConfig, SmsBatchPayload } from "@batchsender/db";
import { getModule, hasModule } from "../../modules/index.js";
import { buildJobPayload } from "../../domain/payload-builders/index.js";
import { createTestUser, sleep } from "../helpers/fixtures.js";
import { randomUUID } from "crypto";

// Skip tests if DATABASE_URL is not set
const DATABASE_URL = process.env.DATABASE_URL;
const SKIP_INTEGRATION = !DATABASE_URL;

/**
 * Create a test SMS batch with recipients using phone numbers
 */
function createSmsBatch(userId: string, sendConfigId: string) {
  return {
    id: randomUUID(),
    userId,
    sendConfigId,
    name: `Test SMS Batch ${Date.now()}`,
    payload: {
      message: "Hello {{name}}! Your code is {{code}}.",
    } as SmsBatchPayload,
    status: "queued" as const,
    totalRecipients: 3,
    sentCount: 0,
    deliveredCount: 0,
    bouncedCount: 0,
    failedCount: 0,
    dryRun: false,
  };
}

/**
 * Create SMS recipients with phone numbers
 */
function createSmsRecipients(batchId: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    batchId,
    identifier: `+1555000${String(i).padStart(4, "0")}`,
    name: `User ${i}`,
    variables: { code: `ABC${i}` },
    status: "pending" as const,
  }));
}

/**
 * Create test SMS send config
 */
function createSmsSendConfig(userId: string) {
  return {
    id: randomUUID(),
    userId,
    name: "Test SMS Config",
    module: "sms" as const,
    config: {
      provider: "mock",
      fromNumber: "+15551234567",
    } as SmsModuleConfig,
    rateLimit: { perSecond: 10 },
    isDefault: true,
    isActive: true,
  };
}

describe("SMS Module Flow", () => {
  // These tests don't require database
  describe("Module System Integration", () => {
    it("SMS module is registered and accessible", () => {
      expect(hasModule("sms")).toBe(true);
      const module = getModule("sms");
      expect(module.type).toBe("sms");
      expect(module.name).toBe("SMS");
    });

    it("validates mock SMS config correctly", () => {
      const module = getModule("sms");
      const result = module.validateConfig({
        provider: "mock",
        fromNumber: "+15551234567",
      });
      expect(result.valid).toBe(true);
    });

    it("validates Telnyx SMS config correctly", () => {
      const module = getModule("sms");

      // Valid config with required fields
      const validResult = module.validateConfig({
        provider: "telnyx",
        fromNumber: "+15551234567",
        apiKey: "KEY01234567890ABCDEF",
      });
      expect(validResult.valid).toBe(true);

      // Valid config with optional messaging profile
      const validWithProfileResult = module.validateConfig({
        provider: "telnyx",
        fromNumber: "+15551234567",
        apiKey: "KEY01234567890ABCDEF",
        messagingProfileId: "12345678-1234-1234-1234-123456789012",
      });
      expect(validWithProfileResult.valid).toBe(true);

      // Invalid config - missing API key
      const invalidResult = module.validateConfig({
        provider: "telnyx",
        fromNumber: "+15551234567",
      });
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors).toContain("apiKey is required for Telnyx");
    });

    it("validates SMS payload correctly", () => {
      const module = getModule("sms");
      const result = module.validatePayload({
        to: "+15559876543",
        message: "Hello!",
      } as any);
      expect(result.valid).toBe(true);
    });

    it("buildJobPayload routes to SMS builder", () => {
      const payload = buildJobPayload({
        sendConfig: {
          id: "test",
          module: "sms",
          config: { fromNumber: "+15551234567" },
        },
        batchPayload: { message: "Hello!" },
        legacyFields: {},
        recipient: { identifier: "+15559876543", name: "Test" },
      });

      expect(payload.to).toBe("+15559876543");
      expect((payload as any).message).toBe("Hello!");
      expect((payload as any).fromNumber).toBe("+15551234567");
    });

    it("executes SMS with mock provider", async () => {
      const module = getModule("sms");
      const result = await module.execute(
        { to: "+15559876543", message: "Hello!" } as any,
        {
          id: "test",
          userId: "user-1",
          name: "Test",
          module: "sms",
          config: { provider: "mock", fromNumber: "+15551234567" },
          rateLimit: null,
          isDefault: true,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      );

      expect(result.success).toBe(true);
      expect(result.providerMessageId).toMatch(/^mock-sms-/);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("handles multiple SMS executions concurrently", async () => {
      const module = getModule("sms");
      const config = {
        id: "test",
        userId: "user-1",
        name: "Test",
        module: "sms" as const,
        config: { provider: "mock" as const, fromNumber: "+15551234567" },
        rateLimit: null,
        isDefault: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          module.execute({ to: `+1555${String(i).padStart(7, "0")}`, message: `Message ${i}` } as any, config)
        )
      );

      expect(results.every((r) => r.success)).toBe(true);
      const messageIds = results.map((r) => r.providerMessageId);
      expect(new Set(messageIds).size).toBe(10); // All unique
    });
  });

  // Database integration tests
  describe.skipIf(SKIP_INTEGRATION)("Database Integration", () => {
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let sql_client: ReturnType<typeof postgres>;
    let testUserId: string;
    let testConfigId: string;

    beforeAll(async () => {
      if (SKIP_INTEGRATION) return;

      sql_client = postgres(DATABASE_URL!);
      db = drizzle(sql_client, { schema });

      // Create test user
      const testUser = createTestUser();
      await db.insert(schema.users).values(testUser);
      testUserId = testUser.id;

      // Create SMS send config
      const smsConfig = createSmsSendConfig(testUserId);
      await db.insert(schema.sendConfigs).values(smsConfig);
      testConfigId = smsConfig.id;
    });

    afterAll(async () => {
      if (SKIP_INTEGRATION) return;

      // Clean up test user (cascades to configs, batches, and recipients)
      await db.delete(schema.users).where(eq(schema.users.id, testUserId));
      await sql_client.end();
    });

    beforeEach(async () => {
      if (SKIP_INTEGRATION) return;

      // Clean up any existing batches for test user
      await db.delete(schema.batches).where(eq(schema.batches.userId, testUserId));
    });

    it("creates SMS batch with phone number recipients", async () => {
      const batchData = createSmsBatch(testUserId, testConfigId);
      await db.insert(schema.batches).values(batchData);

      const recipients = createSmsRecipients(batchData.id, 3);
      await db.insert(schema.recipients).values(recipients);

      // Verify batch
      const batch = await db.query.batches.findFirst({
        where: eq(schema.batches.id, batchData.id),
        with: { sendConfig: true },
      });

      expect(batch).toBeDefined();
      expect(batch?.sendConfig?.module).toBe("sms");
      expect((batch?.sendConfig?.config as SmsModuleConfig).provider).toBe("mock");

      // Verify recipients have phone numbers
      const savedRecipients = await db.query.recipients.findMany({
        where: eq(schema.recipients.batchId, batchData.id),
      });

      expect(savedRecipients).toHaveLength(3);
      expect(savedRecipients.every((r) => r.identifier?.startsWith("+1555"))).toBe(true);
    });

    it("retrieves SMS config and validates", async () => {
      const config = await db.query.sendConfigs.findFirst({
        where: eq(schema.sendConfigs.id, testConfigId),
      });

      expect(config).toBeDefined();
      expect(config?.module).toBe("sms");

      const module = getModule("sms");
      const validationResult = module.validateConfig(config?.config);
      expect(validationResult.valid).toBe(true);
    });

    it("simulates full SMS batch processing flow", async () => {
      // Create batch with recipients
      const batchData = createSmsBatch(testUserId, testConfigId);
      await db.insert(schema.batches).values(batchData);

      const recipients = createSmsRecipients(batchData.id, 3);
      await db.insert(schema.recipients).values(recipients);

      // Get SMS module and config
      const module = getModule("sms");
      const sendConfig = await db.query.sendConfigs.findFirst({
        where: eq(schema.sendConfigs.id, testConfigId),
      });

      // Process each recipient
      for (const recipient of recipients) {
        const payload = buildJobPayload({
          sendConfig: {
            id: sendConfig!.id,
            module: "sms",
            config: sendConfig!.config as Record<string, unknown>,
          },
          batchPayload: (batchData.payload as SmsBatchPayload) || {},
          legacyFields: {},
          recipient: {
            identifier: recipient.identifier!,
            name: recipient.name || undefined,
            variables: recipient.variables || undefined,
          },
        });

        // Execute
        const result = await module.execute(payload, sendConfig as any);
        expect(result.success).toBe(true);

        // Update recipient status
        await db
          .update(schema.recipients)
          .set({
            status: "sent",
            providerMessageId: result.providerMessageId,
            sentAt: new Date(),
          })
          .where(eq(schema.recipients.id, recipient.id));
      }

      // Update batch status
      await db
        .update(schema.batches)
        .set({
          status: "completed",
          sentCount: 3,
          completedAt: new Date(),
        })
        .where(eq(schema.batches.id, batchData.id));

      // Verify final state
      const finalBatch = await db.query.batches.findFirst({
        where: eq(schema.batches.id, batchData.id),
      });

      expect(finalBatch?.status).toBe("completed");
      expect(finalBatch?.sentCount).toBe(3);

      const sentRecipients = await db.query.recipients.findMany({
        where: eq(schema.recipients.batchId, batchData.id),
      });

      expect(sentRecipients.every((r) => r.status === "sent")).toBe(true);
      expect(sentRecipients.every((r) => r.providerMessageId?.startsWith("mock-sms-"))).toBe(true);
    });
  });
});
