/**
 * Configuration and stats routes
 * Allows runtime configuration changes for testing
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getConfig, updateConfig, resetConfig } from "../config.js";
import { store } from "../store.js";
import { flushWebhooks } from "../webhook-sender.js";

const configSchema = z.object({
  webhookUrl: z.string().url().optional(),
  webhookDelayMs: z.number().min(0).max(60000).optional(),
  deliveredRate: z.number().min(0).max(1).optional(),
  bouncedRate: z.number().min(0).max(1).optional(),
  complainedRate: z.number().min(0).max(1).optional(),
  enabled: z.boolean().optional(),
});

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /config - Get current configuration
   */
  app.get("/config", async (request, reply) => {
    return reply.send(getConfig());
  });

  /**
   * POST /config - Update configuration
   */
  app.post("/config", async (request, reply) => {
    const result = configSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        error: "Invalid configuration",
        details: result.error.format(),
      });
    }

    const updated = updateConfig(result.data);
    console.log("[CONFIG] Updated:", result.data);

    return reply.send(updated);
  });

  /**
   * POST /reset - Reset everything (config + stored emails)
   */
  app.post("/reset", async (request, reply) => {
    store.reset();
    resetConfig();
    console.log("[RESET] Store and config reset");

    return reply.send({
      success: true,
      message: "Store and config reset",
    });
  });

  /**
   * GET /stats - Get store statistics
   */
  app.get("/stats", async (request, reply) => {
    return reply.send(store.getStats());
  });

  /**
   * POST /flush - Flush all pending webhooks immediately
   */
  app.post("/flush", async (request, reply) => {
    const flushed = await flushWebhooks();
    return reply.send({
      success: true,
      webhooksSent: flushed,
    });
  });

  /**
   * GET /health - Health check
   */
  app.get("/health", async (request, reply) => {
    return reply.send({
      status: "ok",
      timestamp: new Date().toISOString(),
      stats: store.getStats(),
    });
  });
}
