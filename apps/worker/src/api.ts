import { FastifyInstance } from "fastify";
import { eq, and, sql, inArray, count } from "drizzle-orm";
import { z } from "zod";
import { batches, recipients, users, apiKeys, sendConfigs } from "@batchsender/db";
import type { EmailModuleConfig, WebhookModuleConfig } from "@batchsender/db";
import { db } from "./db.js";
import { queueService, natsClient } from "./index.js";
import { getBatchStats, getUserDailyStats } from "./clickhouse.js";
import { collectNatsMetrics } from "./nats/monitoring.js";
import { getModule, hasModule } from "./modules/index.js";
import { LIMITS } from "./limits.js";
import crypto from "crypto";
import { log, generateTraceId, withTraceAsync, getTraceId } from "./logger.js";

// Simple API key auth
async function verifyApiKey(
  authHeader: string | undefined
): Promise<{ userId: string } | null> {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const apiKey = authHeader.slice(7);
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

  const key = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, keyHash),
  });

  if (!key || (key.expiresAt && key.expiresAt < new Date())) {
    return null;
  }

  // Update last used
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id));

  return { userId: key.userId };
}

// Mask sensitive fields in config (API keys, secrets)
function maskSensitiveConfig(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;

  const masked = { ...config } as Record<string, unknown>;

  // Mask API keys
  if ("apiKey" in masked && typeof masked.apiKey === "string") {
    masked.apiKey = masked.apiKey.slice(0, 8) + "..." + masked.apiKey.slice(-4);
  }

  // Mask Authorization headers
  if ("headers" in masked && typeof masked.headers === "object" && masked.headers) {
    const headers = { ...masked.headers } as Record<string, string>;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "authorization") {
        headers[key] = headers[key].slice(0, 10) + "...";
      }
    }
    masked.headers = headers;
  }

  return masked;
}

export async function registerApi(app: FastifyInstance): Promise<void> {
  // Trace context middleware - extract or generate traceId for each request
  app.addHook("onRequest", async (request, reply) => {
    // Check for X-Trace-Id header (allows external systems to pass trace)
    const externalTraceId = request.headers["x-trace-id"] as string | undefined;
    const traceId = externalTraceId || generateTraceId();

    // Store on request for later use
    (request as any).traceId = traceId;

    // Add to response headers so clients can correlate
    reply.header("X-Trace-Id", traceId);
  });

  // Auth middleware
  app.addHook("preHandler", async (request, reply) => {
    // Skip auth for health check, metrics, and webhooks
    // Support both /metrics and /api/metrics for Prometheus compatibility
    if (
      request.url === "/health" ||
      request.url.startsWith("/metrics") ||
      request.url.startsWith("/api/metrics") ||
      request.url.startsWith("/webhooks")
    ) {
      return;
    }

    const auth = await verifyApiKey(request.headers.authorization);
    if (!auth) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    (request as any).userId = auth.userId;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND CONFIG ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════

  // Schema for creating/updating send configs
  const emailConfigSchema = z.object({
    mode: z.enum(["managed", "byok"]),
    provider: z.enum(["resend", "ses"]).optional(),
    apiKey: z.string().optional(),
    region: z.string().optional(),
    fromEmail: z.string().email().optional(),
    fromName: z.string().optional(),
  });

  const webhookConfigSchema = z.object({
    url: z.string().url(),
    method: z.enum(["POST", "PUT"]).optional(),
    headers: z.record(z.string()).optional(),
    timeout: z.number().min(1000).max(60000).optional(),
    retries: z.number().min(0).max(10).optional(),
    successStatusCodes: z.array(z.number()).optional(),
  });

  const rateLimitSchema = z.object({
    perSecond: z.number().min(1).max(500).optional(),
    perMinute: z.number().min(1).max(25000).optional(),
    dailyLimit: z.number().min(1).optional(),
  });

  const createSendConfigSchema = z.object({
    name: z.string().min(1).max(255),
    module: z.enum(["email", "webhook"]),
    config: z.union([emailConfigSchema, webhookConfigSchema]),
    rateLimit: rateLimitSchema.optional(),
    isDefault: z.boolean().optional(),
  });

  // Create send config
  app.post("/api/send-configs", async (request, reply) => {
    const userId = (request as any).userId;

    try {
      const data = createSendConfigSchema.parse(request.body);

      // Check limit
      const [configCount] = await db
        .select({ count: count() })
        .from(sendConfigs)
        .where(eq(sendConfigs.userId, userId));

      if ((configCount?.count || 0) >= LIMITS.maxSendConfigsPerUser) {
        return reply.status(400).send({
          error: `Maximum ${LIMITS.maxSendConfigsPerUser} send configs allowed`,
        });
      }

      // Validate config with module
      const module = getModule(data.module);
      const validation = module.validateConfig(data.config);
      if (!validation.valid) {
        return reply.status(400).send({
          error: "Invalid config",
          details: validation.errors,
        });
      }

      // If setting as default, unset other defaults for this module type
      if (data.isDefault) {
        await db
          .update(sendConfigs)
          .set({ isDefault: false })
          .where(and(eq(sendConfigs.userId, userId), eq(sendConfigs.module, data.module)));
      }

      const [config] = await db
        .insert(sendConfigs)
        .values({
          userId,
          name: data.name,
          module: data.module,
          config: data.config,
          rateLimit: data.rateLimit || null,
          isDefault: data.isDefault || false,
        })
        .returning();

      return reply.status(201).send({
        id: config.id,
        name: config.name,
        module: config.module,
        isDefault: config.isDefault,
        isActive: config.isActive,
        createdAt: config.createdAt,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: "Invalid input", details: error.errors });
      }
      log.api.error({ error: (error as Error).message }, "create send config failed");
      return reply.status(500).send({ error: "Failed to create send config" });
    }
  });

  // List send configs
  app.get("/api/send-configs", async (request, reply) => {
    const userId = (request as any).userId;

    const configs = await db.query.sendConfigs.findMany({
      where: eq(sendConfigs.userId, userId),
      orderBy: (sendConfigs: { createdAt: any }, { desc }: { desc: (col: any) => any }) => [
        desc(sendConfigs.createdAt),
      ],
    });

    // Mask sensitive fields
    const masked = configs.map((c: typeof configs[number]) => ({
      id: c.id,
      name: c.name,
      module: c.module,
      config: maskSensitiveConfig(c.config),
      rateLimit: c.rateLimit,
      isDefault: c.isDefault,
      isActive: c.isActive,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    return reply.send({ configs: masked });
  });

  // Get single send config
  app.get("/api/send-configs/:id", async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };

    const config = await db.query.sendConfigs.findFirst({
      where: and(eq(sendConfigs.id, id), eq(sendConfigs.userId, userId)),
    });

    if (!config) {
      return reply.status(404).send({ error: "Send config not found" });
    }

    return reply.send({
      ...config,
      config: maskSensitiveConfig(config.config),
    });
  });

  // Update send config
  app.put("/api/send-configs/:id", async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };

    try {
      const data = createSendConfigSchema.partial().parse(request.body);

      const existing = await db.query.sendConfigs.findFirst({
        where: and(eq(sendConfigs.id, id), eq(sendConfigs.userId, userId)),
      });

      if (!existing) {
        return reply.status(404).send({ error: "Send config not found" });
      }

      // Validate config if provided
      if (data.config) {
        const moduleType = data.module || existing.module;
        const module = getModule(moduleType);
        const validation = module.validateConfig(data.config);
        if (!validation.valid) {
          return reply.status(400).send({
            error: "Invalid config",
            details: validation.errors,
          });
        }
      }

      // If setting as default, unset other defaults
      if (data.isDefault) {
        const moduleType = data.module || existing.module;
        await db
          .update(sendConfigs)
          .set({ isDefault: false })
          .where(
            and(
              eq(sendConfigs.userId, userId),
              eq(sendConfigs.module, moduleType)
            )
          );
      }

      const [updated] = await db
        .update(sendConfigs)
        .set({
          ...(data.name && { name: data.name }),
          ...(data.config && { config: data.config }),
          ...(data.rateLimit && { rateLimit: data.rateLimit }),
          ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
          updatedAt: new Date(),
        })
        .where(eq(sendConfigs.id, id))
        .returning();

      return reply.send({
        id: updated.id,
        name: updated.name,
        module: updated.module,
        isDefault: updated.isDefault,
        isActive: updated.isActive,
        updatedAt: updated.updatedAt,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: "Invalid input", details: error.errors });
      }
      log.api.error({ error: (error as Error).message }, "update send config failed");
      return reply.status(500).send({ error: "Failed to update send config" });
    }
  });

  // Delete send config
  app.delete("/api/send-configs/:id", async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };

    const existing = await db.query.sendConfigs.findFirst({
      where: and(eq(sendConfigs.id, id), eq(sendConfigs.userId, userId)),
    });

    if (!existing) {
      return reply.status(404).send({ error: "Send config not found" });
    }

    // Check if any batches are using this config
    const [batchCount] = await db
      .select({ count: count() })
      .from(batches)
      .where(
        and(
          eq(batches.sendConfigId, id),
          inArray(batches.status, ["draft", "scheduled", "queued", "processing"])
        )
      );

    if ((batchCount?.count || 0) > 0) {
      return reply.status(400).send({
        error: "Cannot delete config with active batches",
        activeBatches: batchCount?.count,
      });
    }

    await db.delete(sendConfigs).where(eq(sendConfigs.id, id));

    return reply.send({ success: true });
  });

  // Test send config
  app.post("/api/send-configs/:id/test", async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };

    const config = await db.query.sendConfigs.findFirst({
      where: and(eq(sendConfigs.id, id), eq(sendConfigs.userId, userId)),
    });

    if (!config) {
      return reply.status(404).send({ error: "Send config not found" });
    }

    const testPayloadSchema = z.object({
      to: z.string().email().optional(),
      subject: z.string().optional(),
      data: z.record(z.unknown()).optional(),
    });

    try {
      const testData = testPayloadSchema.parse(request.body);
      const module = getModule(config.module);

      const payload = {
        to: testData.to || "test@example.com",
        subject: testData.subject || "Test from BatchSender",
        htmlContent: "<p>This is a test email from BatchSender.</p>",
        textContent: "This is a test email from BatchSender.",
        data: testData.data,
      };

      const result = await module.execute(payload, config);

      return reply.send({
        success: result.success,
        latencyMs: result.latencyMs,
        error: result.error,
        providerMessageId: result.providerMessageId,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: "Invalid input", details: error.errors });
      }
      log.api.error({ error: (error as Error).message }, "test send config failed");
      return reply.status(500).send({ error: "Test failed", message: (error as Error).message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BATCH ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════

  // Create a batch
  const createBatchSchema = z.object({
    name: z.string().min(1),
    sendConfigId: z.string().uuid().optional(),
    scheduledAt: z.string().datetime().optional(),
    // Dry run mode - processes everything but skips actual outbound calls
    dryRun: z.boolean().optional().default(false),
    // Email fields (required for email module without sendConfigId)
    subject: z.string().optional(),
    fromEmail: z.string().email().optional(),
    fromName: z.string().optional(),
    htmlContent: z.string().optional(),
    textContent: z.string().optional(),
    recipients: z
      .array(
        z.object({
          email: z.string().email(),
          name: z.string().optional(),
          variables: z.record(z.string()).optional(),
          data: z.record(z.unknown()).optional(), // For webhook module
        })
      )
      .min(1)
      .max(LIMITS.maxBatchSize),
  });

  app.post("/api/batches", async (request, reply) => {
    const userId = (request as any).userId;
    const traceId = (request as any).traceId;

    return withTraceAsync(async () => {
      try {
        const data = createBatchSchema.parse(request.body);

      // ═══════════════════════════════════════════════════════════════════════
      // CREATION-TIME LIMITS
      // ═══════════════════════════════════════════════════════════════════════

      // Check 1: Batch size
      if (data.recipients.length > LIMITS.maxBatchSize) {
        return reply.status(400).send({
          error: `Batch too large. Maximum ${LIMITS.maxBatchSize.toLocaleString()} recipients per batch.`,
          limit: LIMITS.maxBatchSize,
          requested: data.recipients.length,
        });
      }

      // Check 2: Total pending jobs
      const [pendingCount] = await db
        .select({ count: count() })
        .from(recipients)
        .innerJoin(batches, eq(recipients.batchId, batches.id))
        .where(
          and(
            eq(batches.userId, userId),
            inArray(recipients.status, ["pending", "queued"])
          )
        );

      const currentPending = Number(pendingCount?.count || 0);
      const newTotal = currentPending + data.recipients.length;

      if (newTotal > LIMITS.maxPendingJobsPerUser) {
        return reply.status(429).send({
          error: `Too many pending jobs.`,
          currentPending,
          requested: data.recipients.length,
          limit: LIMITS.maxPendingJobsPerUser,
          suggestion: `Wait for ${(newTotal - LIMITS.maxPendingJobsPerUser).toLocaleString()} jobs to complete.`,
        });
      }

      // Check 3: Active batches
      const [activeBatchCount] = await db
        .select({ count: count() })
        .from(batches)
        .where(
          and(
            eq(batches.userId, userId),
            inArray(batches.status, ["draft", "scheduled", "queued", "processing"])
          )
        );

      if (Number(activeBatchCount?.count || 0) >= LIMITS.maxActiveBatchesPerUser) {
        return reply.status(429).send({
          error: `Too many active batches.`,
          limit: LIMITS.maxActiveBatchesPerUser,
          suggestion: `Wait for some batches to complete or cancel unused drafts.`,
        });
      }

      // ═══════════════════════════════════════════════════════════════════════
      // SEND CONFIG VALIDATION
      // ═══════════════════════════════════════════════════════════════════════

      let sendConfig = null;
      if (data.sendConfigId) {
        sendConfig = await db.query.sendConfigs.findFirst({
          where: and(
            eq(sendConfigs.id, data.sendConfigId),
            eq(sendConfigs.userId, userId)
          ),
        });

        if (!sendConfig) {
          return reply.status(404).send({ error: "Send config not found" });
        }

        if (!sendConfig.isActive) {
          return reply.status(400).send({ error: "Send config is not active" });
        }
      } else {
        // Using default managed email - validate required fields
        if (!data.subject) {
          return reply.status(400).send({ error: "subject is required for email batches" });
        }
        if (!data.fromEmail) {
          return reply.status(400).send({ error: "fromEmail is required for email batches" });
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // SCHEDULING VALIDATION
      // ═══════════════════════════════════════════════════════════════════════

      let scheduledAt: Date | null = null;
      let status: "draft" | "scheduled" = "draft";

      if (data.scheduledAt) {
        scheduledAt = new Date(data.scheduledAt);

        if (scheduledAt <= new Date()) {
          return reply.status(400).send({ error: "scheduledAt must be in the future" });
        }

        const maxScheduleDate = new Date();
        maxScheduleDate.setDate(maxScheduleDate.getDate() + LIMITS.maxScheduleAheadDays);

        if (scheduledAt > maxScheduleDate) {
          return reply.status(400).send({
            error: `scheduledAt cannot be more than ${LIMITS.maxScheduleAheadDays} days in the future`,
          });
        }

        status = "scheduled";
      }

      // ═══════════════════════════════════════════════════════════════════════
      // CREATE BATCH
      // ═══════════════════════════════════════════════════════════════════════

      const [batch] = await db
        .insert(batches)
        .values({
          userId,
          sendConfigId: data.sendConfigId || null,
          name: data.name,
          subject: data.subject || null,
          fromEmail: data.fromEmail || null,
          fromName: data.fromName || null,
          htmlContent: data.htmlContent || null,
          textContent: data.textContent || null,
          totalRecipients: data.recipients.length,
          status,
          scheduledAt,
          dryRun: data.dryRun,
        })
        .returning();

      // Insert recipients in chunks
      const chunkSize = 1000;
      for (let i = 0; i < data.recipients.length; i += chunkSize) {
        const chunk = data.recipients.slice(i, i + chunkSize);
        await db.insert(recipients).values(
          chunk.map((r) => ({
            batchId: batch.id,
            email: r.email,
            name: r.name || null,
            variables: r.variables || null,
            status: "pending" as const,
          }))
        );
      }

      return reply.status(201).send({
        id: batch.id,
        name: batch.name,
        totalRecipients: batch.totalRecipients,
        status: batch.status,
        scheduledAt: batch.scheduledAt,
        sendConfigId: batch.sendConfigId,
        dryRun: batch.dryRun,
      });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({ error: "Invalid input", details: error.errors });
        }
        log.api.error({ error: (error as Error).message }, "create batch failed");
        return reply.status(500).send({ error: "Failed to create batch" });
      }
    }, traceId);
  });

  // Get batch details
  app.get("/api/batches/:id", async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };

    const batch = await db.query.batches.findFirst({
      where: and(eq(batches.id, id), eq(batches.userId, userId)),
    });

    if (!batch) {
      return reply.status(404).send({ error: "Batch not found" });
    }

    // Get stats from ClickHouse
    const stats = await getBatchStats(id);

    return reply.send({
      ...batch,
      analytics: stats,
    });
  });

  // List batches
  app.get("/api/batches", async (request, reply) => {
    const userId = (request as any).userId;
    const { limit = 50, offset = 0 } = request.query as {
      limit?: number;
      offset?: number;
    };

    const userBatches = await db.query.batches.findMany({
      where: eq(batches.userId, userId),
      orderBy: (batches: { createdAt: any }, { desc }: { desc: (col: any) => any }) => [desc(batches.createdAt)],
      limit: Math.min(limit, 100),
      offset,
    });

    return reply.send({ batches: userBatches });
  });

  // Start sending a batch
  app.post("/api/batches/:id/send", async (request, reply) => {
    const userId = (request as any).userId;
    const traceId = (request as any).traceId;
    const { id } = request.params as { id: string };

    return withTraceAsync(async () => {
      const batch = await db.query.batches.findFirst({
        where: and(eq(batches.id, id), eq(batches.userId, userId)),
      });

      if (!batch) {
        return reply.status(404).send({ error: "Batch not found" });
      }

      if (batch.status !== "draft") {
        return reply.status(400).send({
          error: `Batch is already ${batch.status}, cannot start sending`,
        });
      }

      // Update status to queued
      await db
        .update(batches)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(batches.id, id));

      // Add to processing queue (traceId propagates via getTraceId() in queue-service)
      await queueService.enqueueBatch(id, userId);

      log.api.info({ batchId: id, userId }, "batch send initiated");

      return reply.send({
        id: batch.id,
        status: "queued",
        message: "Batch queued for sending",
      });
    }, traceId);
  });

  // Pause a batch
  app.post("/api/batches/:id/pause", async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };

    const batch = await db.query.batches.findFirst({
      where: and(eq(batches.id, id), eq(batches.userId, userId)),
    });

    if (!batch) {
      return reply.status(404).send({ error: "Batch not found" });
    }

    if (batch.status !== "processing" && batch.status !== "queued") {
      return reply.status(400).send({
        error: `Cannot pause batch with status: ${batch.status}`,
      });
    }

    await db
      .update(batches)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(batches.id, id));

    return reply.send({ id: batch.id, status: "paused" });
  });

  // Resume a batch
  app.post("/api/batches/:id/resume", async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };

    const batch = await db.query.batches.findFirst({
      where: and(eq(batches.id, id), eq(batches.userId, userId)),
    });

    if (!batch) {
      return reply.status(404).send({ error: "Batch not found" });
    }

    if (batch.status !== "paused") {
      return reply.status(400).send({
        error: `Cannot resume batch with status: ${batch.status}`,
      });
    }

    await db
      .update(batches)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(batches.id, id));

    await queueService.enqueueBatch(id, userId);

    return reply.send({ id: batch.id, status: "queued" });
  });

  // Get batch recipients
  app.get("/api/batches/:id/recipients", async (request, reply) => {
    const userId = (request as any).userId;
    const { id } = request.params as { id: string };
    const { status, limit = 100, offset = 0 } = request.query as {
      status?: string;
      limit?: number;
      offset?: number;
    };

    const batch = await db.query.batches.findFirst({
      where: and(eq(batches.id, id), eq(batches.userId, userId)),
      columns: { id: true },
    });

    if (!batch) {
      return reply.status(404).send({ error: "Batch not found" });
    }

    let whereClause = eq(recipients.batchId, id);
    if (status) {
      whereClause = and(whereClause, eq(recipients.status, status as any))!;
    }

    const batchRecipients = await db.query.recipients.findMany({
      where: whereClause,
      orderBy: (recipients: { updatedAt: any }, { desc }: { desc: (col: any) => any }) => [desc(recipients.updatedAt)],
      limit: Math.min(limit, 500),
      offset,
    });

    return reply.send({ recipients: batchRecipients });
  });

  // Get user analytics
  app.get("/api/analytics", async (request, reply) => {
    const userId = (request as any).userId;
    const { days = 30 } = request.query as { days?: number };

    const stats = await getUserDailyStats(userId, Math.min(days, 90));

    return reply.send({ stats });
  });

  // Queue status
  app.get("/api/queue/status", async (request, reply) => {
    const stats = await queueService.getQueueStats();

    return reply.send({
      batches: stats.batch,
      emails: stats.email,
      priority: stats.priority,
    });
  });

  // Metrics endpoint (for monitoring systems)
  // Support both /metrics and /api/metrics for Prometheus compatibility
  const metricsHandler = async (request: any, reply: any) => {
    try {
      // Update NATS queue depth metrics (for KEDA autoscaling)
      const natsMetrics = await collectNatsMetrics(natsClient);
      const queueStats = await queueService.getQueueStats();

      // Import metrics module dynamically to avoid circular dependencies
      const {
        natsQueueDepthBatchProcessor,
        natsQueueDepthEmailProcessor,
        natsQueueDepthTotal,
        getMetrics,
        getMetricsContentType
      } = await import('./metrics.js');

      // Update NATS queue depth gauges
      natsQueueDepthBatchProcessor.set(
        natsMetrics.consumer_pending['batch-processor'] || 0
      );

      // Sum all user-* consumer queues
      let emailQueueDepth = 0;
      for (const [consumerName, pending] of Object.entries(natsMetrics.consumer_pending)) {
        if (consumerName.startsWith('user-')) {
          emailQueueDepth += pending;
        }
      }
      natsQueueDepthEmailProcessor.set(emailQueueDepth);
      natsQueueDepthTotal.set(natsMetrics.pending_messages);

      // Get all metrics in Prometheus format
      const metricsOutput = await getMetrics();

      reply.type(getMetricsContentType());
      return reply.send(metricsOutput);
    } catch (error) {
      log.api.error({ error }, "Failed to collect metrics");
      return reply.status(500).send({ error: "Failed to collect metrics" });
    }
  };

  app.get("/metrics", metricsHandler);
  app.get("/api/metrics", metricsHandler);
}
