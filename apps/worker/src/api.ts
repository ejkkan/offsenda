import { FastifyInstance } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { batches, recipients, users, apiKeys } from "@batchsender/db";
import { db } from "./db.js";
import { queueService, natsClient } from "./index.js";
import { getBatchStats, getUserDailyStats } from "./clickhouse.js";
import { collectNatsMetrics } from "./nats/monitoring.js";
import crypto from "crypto";
import { log } from "./logger.js";

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

export async function registerApi(app: FastifyInstance): Promise<void> {
  // Auth middleware
  app.addHook("preHandler", async (request, reply) => {
    // Skip auth for health check, metrics, and webhooks
    if (
      request.url === "/health" ||
      request.url === "/api/metrics" ||
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

  // Create a batch
  const createBatchSchema = z.object({
    name: z.string().min(1),
    subject: z.string().min(1),
    fromEmail: z.string().email(),
    fromName: z.string().optional(),
    htmlContent: z.string().optional(),
    textContent: z.string().optional(),
    recipients: z
      .array(
        z.object({
          email: z.string().email(),
          name: z.string().optional(),
          variables: z.record(z.string()).optional(),
        })
      )
      .min(1)
      .max(10000),
  });

  app.post("/api/batches", async (request, reply) => {
    const userId = (request as any).userId;

    try {
      const data = createBatchSchema.parse(request.body);

      const [batch] = await db
        .insert(batches)
        .values({
          userId,
          name: data.name,
          subject: data.subject,
          fromEmail: data.fromEmail,
          fromName: data.fromName || null,
          htmlContent: data.htmlContent || null,
          textContent: data.textContent || null,
          totalRecipients: data.recipients.length,
          status: "draft",
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
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: "Invalid input", details: error.errors });
      }
      log.api.error({ error: (error as Error).message }, "create batch failed");
      return reply.status(500).send({ error: "Failed to create batch" });
    }
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
    const { id } = request.params as { id: string };

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

    // Add to processing queue
    await queueService.enqueueBatch(id, userId);

    return reply.send({
      id: batch.id,
      status: "queued",
      message: "Batch queued for sending",
    });
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
  app.get("/api/metrics", async (request, reply) => {
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
  });
}
