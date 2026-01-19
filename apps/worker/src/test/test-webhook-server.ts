/**
 * Test Webhook Server
 *
 * A simple standalone server for testing outgoing webhooks.
 * Run with: npx tsx apps/worker/src/test/test-webhook-server.ts
 *
 * This server:
 * - Accepts POST requests to /webhook
 * - Logs received payloads
 * - Returns a success response with a generated message ID
 *
 * Use with a webhook sendConfig pointing to http://localhost:3333/webhook
 */

import Fastify from "fastify";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3333;

interface WebhookStats {
  count: number;
  startTime: number;
  lastPayloads: Array<{ timestamp: number; payload: unknown }>;
}

const stats: WebhookStats = {
  count: 0,
  startTime: Date.now(),
  lastPayloads: [],
};

async function main() {
  const app = Fastify({ logger: true });

  // Main webhook endpoint
  app.post("/webhook", async (request, reply) => {
    const timestamp = Date.now();
    stats.count++;

    // Store last 10 payloads
    stats.lastPayloads.unshift({ timestamp, payload: request.body });
    if (stats.lastPayloads.length > 10) {
      stats.lastPayloads.pop();
    }

    console.log(`\n[${new Date().toISOString()}] Webhook #${stats.count} received:`);
    console.log(JSON.stringify(request.body, null, 2));

    return reply.status(200).send({
      success: true,
      id: `msg-${timestamp}-${stats.count}`,
    });
  });

  // Stats endpoint
  app.get("/stats", async (request, reply) => {
    const elapsed = (Date.now() - stats.startTime) / 1000;
    const throughput = elapsed > 0 ? stats.count / elapsed : 0;

    return reply.send({
      count: stats.count,
      elapsedSeconds: Math.round(elapsed),
      throughputPerSecond: Math.round(throughput * 100) / 100,
      lastPayloads: stats.lastPayloads,
    });
  });

  // Reset endpoint
  app.delete("/reset", async (request, reply) => {
    stats.count = 0;
    stats.startTime = Date.now();
    stats.lastPayloads = [];
    return reply.send({ success: true, message: "Stats reset" });
  });

  // Health check
  app.get("/health", async (request, reply) => {
    return reply.send({ status: "ok" });
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });

  console.log(`\n========================================`);
  console.log(`  Test Webhook Server Started`);
  console.log(`========================================`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`  Stats: http://localhost:${PORT}/stats`);
  console.log(`  Reset: DELETE http://localhost:${PORT}/reset`);
  console.log(`========================================\n`);
  console.log(`Waiting for webhook requests...\n`);
}

main().catch(console.error);
