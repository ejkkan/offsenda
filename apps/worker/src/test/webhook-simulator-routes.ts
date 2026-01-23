import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  getWebhookSimulator,
  initializeWebhookSimulator,
  simulationConfigSchema,
  type SimulationConfig,
} from "./webhook-simulator.js";
import { NatsClient } from "../nats/client.js";
import { db } from "../db.js";
import { batches, recipients, sendConfigs } from "@batchsender/db";

/**
 * Register webhook simulator routes
 * Available in non-production, or in production with explicit opt-in
 */
export async function registerWebhookSimulatorRoutes(
  app: FastifyInstance,
  natsClient: NatsClient
): Promise<void> {
  const IS_PRODUCTION = config.NODE_ENV === "production";
  const ENABLE_IN_PROD = process.env.ENABLE_WEBHOOK_SIMULATOR === "true";

  // Only enable in non-production, or production with explicit opt-in
  if (IS_PRODUCTION && !ENABLE_IN_PROD) {
    log.system.info("Webhook simulator routes disabled in production (set ENABLE_WEBHOOK_SIMULATOR=true to enable)");
    return;
  }

  // In production, require admin secret for all simulator routes
  if (IS_PRODUCTION) {
    app.addHook("preHandler", async (request, reply) => {
      if (!request.url.startsWith("/test/simulate")) {
        return;
      }
      const secret = request.headers["x-admin-secret"];
      if (secret !== config.TEST_ADMIN_SECRET) {
        return reply.status(401).send({ error: "Invalid admin secret" });
      }
    });
    log.system.warn({}, "Webhook simulator enabled in PRODUCTION - protected by admin secret");
  }

  // Initialize simulator
  const simulator = initializeWebhookSimulator(natsClient);
  await simulator.initialize();

  log.system.info("Webhook simulator routes enabled");

  // =============================================================================
  // Start Simulation
  // =============================================================================
  app.post<{
    Params: { batchId: string };
    Body: Partial<SimulationConfig>;
  }>("/test/simulate/batch/:batchId", async (request, reply) => {
    const { batchId } = request.params;

    try {
      const config = simulationConfigSchema.parse(request.body || {});

      const simulation = await simulator.startSimulation(batchId, config);

      return reply.status(202).send({
        message: "Simulation started",
        simulationId: simulation.id,
        batchId: simulation.batchId,
        config: simulation.config,
        totalRecipients: simulation.progress.totalRecipients,
        estimatedEvents: Math.round(
          simulation.progress.totalRecipients * getEstimatedEventsPerRecipient(config.profile)
        ),
        statusUrl: `/test/simulate/status/${simulation.id}`,
      });
    } catch (error) {
      log.system.error({ error, batchId }, "Failed to start simulation");
      return reply.status(400).send({
        error: (error as Error).message,
      });
    }
  });

  // =============================================================================
  // Get Simulation Status
  // =============================================================================
  app.get<{
    Params: { simulationId: string };
  }>("/test/simulate/status/:simulationId", async (request, reply) => {
    const { simulationId } = request.params;

    const simulation = simulator.getSimulation(simulationId);
    if (!simulation) {
      return reply.status(404).send({ error: "Simulation not found" });
    }

    const elapsed = simulation.completedAt
      ? simulation.completedAt.getTime() - simulation.startedAt.getTime()
      : Date.now() - simulation.startedAt.getTime();

    return reply.send({
      id: simulation.id,
      batchId: simulation.batchId,
      status: simulation.status,
      startedAt: simulation.startedAt.toISOString(),
      completedAt: simulation.completedAt?.toISOString(),
      elapsedSeconds: Math.round(elapsed / 1000),
      config: simulation.config,
      progress: {
        ...simulation.progress,
        percentComplete: simulation.progress.eventsGenerated > 0
          ? Math.round((simulation.progress.eventsProcessed / simulation.progress.eventsGenerated) * 100)
          : 0,
        eventsPerSecond: elapsed > 0
          ? Math.round((simulation.progress.eventsProcessed / elapsed) * 1000)
          : 0,
      },
      error: simulation.error,
    });
  });

  // =============================================================================
  // List All Simulations
  // =============================================================================
  app.get("/test/simulate/list", async (_request, reply) => {
    const simulations = simulator.listSimulations();

    return reply.send({
      count: simulations.length,
      simulations: simulations.map(s => ({
        id: s.id,
        batchId: s.batchId,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        completedAt: s.completedAt?.toISOString(),
        progress: {
          totalRecipients: s.progress.totalRecipients,
          eventsProcessed: s.progress.eventsProcessed,
          eventsGenerated: s.progress.eventsGenerated,
        },
      })),
    });
  });

  // =============================================================================
  // Cancel Simulation
  // =============================================================================
  app.delete<{
    Params: { simulationId: string };
  }>("/test/simulate/cancel/:simulationId", async (request, reply) => {
    const { simulationId } = request.params;

    const cancelled = simulator.cancelSimulation(simulationId);
    if (!cancelled) {
      return reply.status(404).send({ error: "Simulation not found or already completed" });
    }

    return reply.send({
      message: "Simulation cancelled",
      simulationId,
    });
  });

  // =============================================================================
  // Create Test Data
  // =============================================================================
  app.post<{
    Body: {
      userId: string;
      recipientCount?: number;
      emailPrefix?: string;
    };
  }>("/test/simulate/create-test-data", async (request, reply) => {
    const { userId, recipientCount = 100, emailPrefix = "test" } = request.body || {};

    if (!userId) {
      return reply.status(400).send({ error: "userId is required" });
    }

    try {
      // Get or create a send config for the user
      let sendConfig = await db.query.sendConfigs.findFirst({
        where: eq(sendConfigs.userId, userId),
      });

      if (!sendConfig) {
        const [newConfig] = await db
          .insert(sendConfigs)
          .values({
            userId,
            name: "Test Config",
            module: "email",
            config: { mode: "managed" },
            rateLimit: { perSecond: 1000 },
            isDefault: true,
            isActive: true,
          })
          .returning();
        sendConfig = newConfig;
      }

      // Create a batch
      const [batch] = await db
        .insert(batches)
        .values({
          userId,
          sendConfigId: sendConfig.id,
          name: `Simulation Test Batch - ${new Date().toISOString()}`,
          status: "completed",
          totalRecipients: recipientCount,
          sentCount: recipientCount,
          failedCount: 0,
        })
        .returning();

      // Create recipients with 'sent' status
      const recipientData = [];
      for (let i = 0; i < recipientCount; i++) {
        recipientData.push({
          batchId: batch.id,
          email: `${emailPrefix}-${i}@example.com`,
          status: "sent" as const,
          providerMessageId: `msg-${randomUUID()}`,
          data: {},
        });
      }

      // Insert in batches of 1000
      const chunkSize = 1000;
      for (let i = 0; i < recipientData.length; i += chunkSize) {
        const chunk = recipientData.slice(i, i + chunkSize);
        await db.insert(recipients).values(chunk);
      }

      log.system.info({
        batchId: batch.id,
        userId,
        recipientCount,
      }, "Created test data for simulation");

      return reply.status(201).send({
        message: "Test data created",
        batchId: batch.id,
        userId,
        recipientCount,
        simulateUrl: `/test/simulate/batch/${batch.id}`,
      });
    } catch (error) {
      log.system.error({ error, userId }, "Failed to create test data");
      return reply.status(500).send({
        error: (error as Error).message,
      });
    }
  });

  // =============================================================================
  // Help / Info
  // =============================================================================
  app.get("/test/simulate", async (_request, reply) => {
    return reply.send({
      description: "Realistic webhook simulation for load testing",
      endpoints: {
        "POST /test/simulate/batch/:batchId": {
          description: "Start a webhook simulation for a batch",
          body: {
            profile: "realistic | stress | instant (default: realistic)",
            durationSeconds: "Duration to spread events over (1-3600, default: 300)",
            throughputPerSecond: "Max webhooks per second (1-10000, default: 500)",
            rates: {
              deliveryRate: "% delivered (0-1)",
              bounceRate: "% bounced (0-1)",
              complaintRate: "% complained (0-1)",
              openRate: "% of delivered that open (0-1)",
              clickRate: "% of opens that click (0-1)",
              multipleOpens: "avg additional opens per opener (0-10)",
            },
          },
          returns: "Simulation ID and status URL",
        },
        "GET /test/simulate/status/:simulationId": {
          description: "Get simulation progress and status",
        },
        "GET /test/simulate/list": {
          description: "List all simulations",
        },
        "DELETE /test/simulate/cancel/:simulationId": {
          description: "Cancel a running simulation",
        },
      },
      profiles: {
        realistic: {
          description: "Simulates real-world email campaign behavior",
          deliveryRate: 0.94,
          bounceRate: 0.05,
          complaintRate: 0.001,
          openRate: 0.25,
          clickRate: 0.15,
          timing: "Delivery 1-30s, opens 1min-1hr, clicks 1-60s after open",
          estimatedEventsPerRecipient: 1.4,
        },
        stress: {
          description: "Maximum webhook load for stress testing",
          deliveryRate: 0.99,
          bounceRate: 0.005,
          openRate: 0.6,
          clickRate: 0.4,
          timing: "All events within seconds",
          estimatedEventsPerRecipient: 2.5,
        },
        instant: {
          description: "All events immediately (for quick functional tests)",
          deliveryRate: 0.90,
          bounceRate: 0.08,
          openRate: 0.3,
          clickRate: 0.2,
          timing: "Near-instant delivery",
          estimatedEventsPerRecipient: 1.5,
        },
      },
      examples: {
        "Quick test": {
          method: "POST /test/simulate/batch/YOUR_BATCH_ID",
          body: { profile: "instant", durationSeconds: 10 },
        },
        "Realistic campaign": {
          method: "POST /test/simulate/batch/YOUR_BATCH_ID",
          body: { profile: "realistic", durationSeconds: 300 },
        },
        "Stress test": {
          method: "POST /test/simulate/batch/YOUR_BATCH_ID",
          body: { profile: "stress", throughputPerSecond: 5000, durationSeconds: 60 },
        },
        "Custom rates": {
          method: "POST /test/simulate/batch/YOUR_BATCH_ID",
          body: {
            profile: "realistic",
            rates: { deliveryRate: 0.99, openRate: 0.5, clickRate: 0.3 },
          },
        },
      },
    });
  });
}

function getEstimatedEventsPerRecipient(profile: string): number {
  switch (profile) {
    case "realistic": return 1.4;
    case "stress": return 2.5;
    case "instant": return 1.5;
    default: return 1.5;
  }
}
