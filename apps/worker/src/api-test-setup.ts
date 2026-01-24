/**
 * Test Setup API Endpoints
 *
 * Admin-only endpoints for k6 and integration tests to create test users,
 * API keys, and other resources programmatically.
 *
 * Key Features:
 * - Create test users with API keys
 * - Batch create multiple test assets at once
 * - Mass cleanup of test resources
 * - Protected by X-Admin-Secret header
 *
 * Usage from k6:
 *   const response = http.post(`${BASE_URL}/api/test-setup/user`, payload, {
 *     headers: { 'X-Admin-Secret': ADMIN_SECRET }
 *   });
 */

import { FastifyInstance } from "fastify";
import { eq, inArray, sql, and, like } from "drizzle-orm";
import { users, apiKeys, sendConfigs, batches, recipients } from "@batchsender/db";
import type { EmailModuleConfig } from "@batchsender/db";
import { db } from "./db.js";
import { config } from "./config.js";
import crypto from "crypto";
import { log } from "./logger.js";

// Admin secret for test endpoints
const ADMIN_SECRET = config.TEST_ADMIN_SECRET;
const IS_PRODUCTION = config.NODE_ENV === "production";

/**
 * Verify admin secret header
 */
function verifyAdminSecret(headers: Record<string, string | string[] | undefined>): boolean {
  const secret = headers["x-admin-secret"];
  return secret === ADMIN_SECRET;
}

/**
 * Generate a random API key
 */
function generateApiKey(): string {
  return `bs_test_${crypto.randomBytes(24).toString("base64url")}`;
}

export async function registerTestSetupApi(app: FastifyInstance): Promise<void> {
  // Block in production unless explicitly enabled
  if (IS_PRODUCTION && process.env.ENABLE_TEST_SETUP_API !== "true") {
    log.system.info({}, "Test setup API disabled in production");
    return;
  }

  log.system.info({}, "Test setup API enabled");

  // ═══════════════════════════════════════════════════════════════════════════
  // Middleware: Admin Secret Verification
  // ═══════════════════════════════════════════════════════════════════════════

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/test-setup")) {
      return;
    }

    if (!verifyAdminSecret(request.headers as Record<string, string | string[] | undefined>)) {
      return reply.status(401).send({ error: "Invalid admin secret" });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/test-setup/user - Create test user with API key
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/api/test-setup/user", async (request, reply) => {
    const { email, name } = request.body as { email?: string; name?: string };

    if (!email) {
      return reply.status(400).send({ error: "email is required" });
    }

    // Check if user already exists
    let user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (!user) {
      // Create new user with a random password hash (test users don't use password auth)
      const randomPasswordHash = crypto.randomBytes(32).toString("hex");
      const [newUser] = await db
        .insert(users)
        .values({
          email,
          name: name || email.split("@")[0],
          passwordHash: randomPasswordHash,
        })
        .returning();
      user = newUser;
      log.system.info({ userId: user.id, email }, "Created test user");
    }

    // Generate API key
    const rawKey = generateApiKey();
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.slice(0, 10);

    const [apiKey] = await db
      .insert(apiKeys)
      .values({
        userId: user.id,
        keyHash,
        keyPrefix,
        name: `Test API Key - ${new Date().toISOString()}`,
      })
      .returning();

    log.system.info({ userId: user.id, apiKeyId: apiKey.id }, "Created test API key");

    return reply.status(201).send({
      userId: user.id,
      email: user.email,
      apiKey: rawKey, // Only time the raw key is exposed
      apiKeyId: apiKey.id,
      apiKeyPrefix: keyPrefix,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE /api/test-setup/user/:userId - Delete test user and all resources
  // ═══════════════════════════════════════════════════════════════════════════

  app.delete("/api/test-setup/user/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Verify it's a test user (email ends with @test.batchsender.com)
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      return reply.status(404).send({ error: "User not found" });
    }

    // Safety check: only delete test users
    if (!user.email.endsWith("@test.batchsender.com") && !user.email.includes("loadtest")) {
      return reply.status(403).send({ error: "Can only delete test users" });
    }

    // Delete in order: recipients -> batches -> sendConfigs -> apiKeys -> user
    const userBatches = await db.query.batches.findMany({
      where: eq(batches.userId, userId),
      columns: { id: true },
    });

    for (const batch of userBatches) {
      await db.delete(recipients).where(eq(recipients.batchId, batch.id));
    }

    await db.delete(batches).where(eq(batches.userId, userId));
    await db.delete(sendConfigs).where(eq(sendConfigs.userId, userId));
    await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
    await db.delete(users).where(eq(users.id, userId));

    log.system.info({ userId }, "Deleted test user and all resources");

    return reply.send({ success: true, deletedUserId: userId });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/test-setup/api-key - Create additional API key for user
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/api/test-setup/api-key", async (request, reply) => {
    const { userId, name } = request.body as { userId?: string; name?: string };

    if (!userId) {
      return reply.status(400).send({ error: "userId is required" });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      return reply.status(404).send({ error: "User not found" });
    }

    const rawKey = generateApiKey();
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.slice(0, 10);

    const [apiKey] = await db
      .insert(apiKeys)
      .values({
        userId,
        keyHash,
        keyPrefix,
        name: name || `Test API Key - ${new Date().toISOString()}`,
      })
      .returning();

    return reply.status(201).send({
      apiKey: rawKey,
      apiKeyId: apiKey.id,
      apiKeyPrefix: keyPrefix,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/test-setup/status - Health check for test setup API
  // ═══════════════════════════════════════════════════════════════════════════

  app.get("/api/test-setup/status", async (request, reply) => {
    return reply.send({
      enabled: true,
      environment: config.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/test-setup/cleanup - Clean up old test resources
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/api/test-setup/cleanup", async (request, reply) => {
    const { olderThanHours = 24 } = request.body as { olderThanHours?: number };

    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

    // Find test users (using SQL LIKE for pattern matching)
    const testUsers = await db
      .select()
      .from(users)
      .where(
        sql`(${users.email} LIKE '%@test.batchsender.com' OR ${users.email} LIKE '%loadtest%') AND ${users.createdAt} < ${cutoff}`
      );

    let deletedCount = 0;

    for (const user of testUsers) {
      try {
        // Delete resources
        const userBatches = await db.query.batches.findMany({
          where: eq(batches.userId, user.id),
          columns: { id: true },
        });

        for (const batch of userBatches) {
          await db.delete(recipients).where(eq(recipients.batchId, batch.id));
        }

        await db.delete(batches).where(eq(batches.userId, user.id));
        await db.delete(sendConfigs).where(eq(sendConfigs.userId, user.id));
        await db.delete(apiKeys).where(eq(apiKeys.userId, user.id));
        await db.delete(users).where(eq(users.id, user.id));

        deletedCount++;
      } catch (error) {
        log.system.error({ error, userId: user.id }, "Failed to clean up test user");
      }
    }

    log.system.info({ deletedCount, olderThanHours }, "Cleaned up old test resources");

    return reply.send({
      success: true,
      deletedUsers: deletedCount,
      cutoffDate: cutoff.toISOString(),
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/test-setup/batch-create - Create multiple test users at once
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/api/test-setup/batch-create", async (request, reply) => {
    const {
      count = 1,
      prefix = "k6-test",
      withSendConfig = true,
    } = request.body as {
      count?: number;
      prefix?: string;
      withSendConfig?: boolean;
    };

    if (count > 100) {
      return reply.status(400).send({ error: "Maximum 100 users per batch" });
    }

    const timestamp = Date.now();
    const results: Array<{
      userId: string;
      email: string;
      apiKey: string;
      apiKeyId: string;
      sendConfigId?: string;
    }> = [];

    for (let i = 0; i < count; i++) {
      const email = `${prefix}-${timestamp}-${i}@test.batchsender.com`;
      const randomPasswordHash = crypto.randomBytes(32).toString("hex");

      // Create user
      const [user] = await db
        .insert(users)
        .values({
          email,
          name: `${prefix} User ${i}`,
          passwordHash: randomPasswordHash,
        })
        .returning();

      // Create API key
      const rawKey = generateApiKey();
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.slice(0, 10);

      const [apiKey] = await db
        .insert(apiKeys)
        .values({
          userId: user.id,
          keyHash,
          keyPrefix,
          name: `Test Key ${i}`,
        })
        .returning();

      const result: (typeof results)[number] = {
        userId: user.id,
        email: user.email,
        apiKey: rawKey,
        apiKeyId: apiKey.id,
      };

      // Optionally create send config
      if (withSendConfig) {
        const [sendConfig] = await db
          .insert(sendConfigs)
          .values({
            userId: user.id,
            name: `${prefix}-test-config`,
            module: "email",
            config: { service: "resend", fromEmail: "test@example.com" } as EmailModuleConfig,
            rateLimit: { perSecond: 5000 },
            isDefault: true,
            isActive: true,
          })
          .returning();
        result.sendConfigId = sendConfig.id;
      }

      results.push(result);
    }

    log.system.info({ count, prefix }, "Batch created test users");

    return reply.status(201).send({
      success: true,
      created: results.length,
      users: results,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE /api/test-setup/batch-delete - Mass delete test users
  // ═══════════════════════════════════════════════════════════════════════════

  app.delete("/api/test-setup/batch-delete", async (request, reply) => {
    const {
      userIds,
      prefix,
      olderThanMinutes,
    } = request.body as {
      userIds?: string[];
      prefix?: string;
      olderThanMinutes?: number;
    };

    let usersToDelete: { id: string; email: string }[] = [];

    if (userIds && userIds.length > 0) {
      // Delete specific users
      usersToDelete = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, userIds));
    } else if (prefix) {
      // Delete by prefix
      usersToDelete = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(sql`${users.email} LIKE ${prefix + '%@test.batchsender.com'}`);
    } else if (olderThanMinutes) {
      // Delete by age
      const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
      usersToDelete = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          sql`(${users.email} LIKE '%@test.batchsender.com' OR ${users.email} LIKE '%loadtest%') AND ${users.createdAt} < ${cutoff}`
        );
    } else {
      return reply.status(400).send({
        error: "Must specify userIds, prefix, or olderThanMinutes",
      });
    }

    // Safety check: only delete test users
    const safeUsers = usersToDelete.filter(
      (u) => u.email.endsWith("@test.batchsender.com") || u.email.includes("loadtest")
    );

    if (safeUsers.length === 0) {
      return reply.send({ success: true, deleted: 0 });
    }

    const userIdsToDelete = safeUsers.map((u) => u.id);

    // Bulk delete in order: recipients -> batches -> sendConfigs -> apiKeys -> users
    // Get all batch IDs for these users
    const userBatches = await db
      .select({ id: batches.id })
      .from(batches)
      .where(inArray(batches.userId, userIdsToDelete));

    const batchIds = userBatches.map((b: { id: string }) => b.id);

    if (batchIds.length > 0) {
      await db.delete(recipients).where(inArray(recipients.batchId, batchIds));
      await db.delete(batches).where(inArray(batches.id, batchIds));
    }

    await db.delete(sendConfigs).where(inArray(sendConfigs.userId, userIdsToDelete));
    await db.delete(apiKeys).where(inArray(apiKeys.userId, userIdsToDelete));
    await db.delete(users).where(inArray(users.id, userIdsToDelete));

    log.system.info({ deleted: safeUsers.length }, "Batch deleted test users");

    return reply.send({
      success: true,
      deleted: safeUsers.length,
      deletedUserIds: userIdsToDelete,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /api/test-setup/list - List all test users
  // ═══════════════════════════════════════════════════════════════════════════

  app.get("/api/test-setup/list", async (request, reply) => {
    const testUsers = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        sql`${users.email} LIKE '%@test.batchsender.com' OR ${users.email} LIKE '%loadtest%'`
      )
      .orderBy(sql`${users.createdAt} DESC`)
      .limit(100);

    return reply.send({
      count: testUsers.length,
      users: testUsers,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // POST /api/test-setup/reset - Nuclear option: delete ALL test resources
  // ═══════════════════════════════════════════════════════════════════════════

  app.post("/api/test-setup/reset", async (request, reply) => {
    const { confirm } = request.body as { confirm?: boolean };

    if (!confirm) {
      return reply.status(400).send({
        error: "Must set confirm: true to delete all test resources",
      });
    }

    // Find all test users
    const testUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(
        sql`${users.email} LIKE '%@test.batchsender.com' OR ${users.email} LIKE '%loadtest%'`
      );

    if (testUsers.length === 0) {
      return reply.send({ success: true, deleted: 0 });
    }

    const userIds = testUsers.map((u: { id: string }) => u.id);

    // Get all batches
    const allBatches = await db
      .select({ id: batches.id })
      .from(batches)
      .where(inArray(batches.userId, userIds));

    const batchIds = allBatches.map((b: { id: string }) => b.id);

    // Delete everything
    if (batchIds.length > 0) {
      await db.delete(recipients).where(inArray(recipients.batchId, batchIds));
      await db.delete(batches).where(inArray(batches.id, batchIds));
    }

    await db.delete(sendConfigs).where(inArray(sendConfigs.userId, userIds));
    await db.delete(apiKeys).where(inArray(apiKeys.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));

    log.system.warn(
      { deletedUsers: userIds.length, deletedBatches: batchIds.length },
      "Reset: deleted all test resources"
    );

    return reply.send({
      success: true,
      deletedUsers: userIds.length,
      deletedBatches: batchIds.length,
    });
  });
}
