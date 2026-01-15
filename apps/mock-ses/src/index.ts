/**
 * Mock SES/SNS Server
 *
 * Mimics AWS SES email sending with automatic SNS-formatted webhook callbacks.
 * For local development and testing only.
 *
 * Endpoints:
 *   POST /ses/send     - Send email (returns MessageId)
 *   GET  /ses/emails   - List all sent emails
 *   GET  /config       - Get current config
 *   POST /config       - Update config (rates, delays)
 *   POST /reset        - Reset store and config
 *   GET  /stats        - Get statistics
 *   POST /flush        - Flush pending webhooks
 *   GET  /health       - Health check
 */

import Fastify from "fastify";
import { registerSESRoutes } from "./routes/ses.js";
import { registerConfigRoutes } from "./routes/config.js";
import { startWebhookSender, stopWebhookSender } from "./webhook-sender.js";
import { updateConfig } from "./config.js";

const PORT = parseInt(process.env.PORT || "4566");
const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://localhost:6001/webhooks/ses";
const DELIVERED_RATE = parseFloat(process.env.DELIVERED_RATE || "0.90");
const BOUNCED_RATE = parseFloat(process.env.BOUNCED_RATE || "0.05");
const COMPLAINED_RATE = parseFloat(process.env.COMPLAINED_RATE || "0.01");
const WEBHOOK_DELAY_MS = parseInt(process.env.WEBHOOK_DELAY_MS || "1000");

async function main() {
  const isDev = process.env.NODE_ENV !== "production";

  const app = Fastify({
    logger: isDev
      ? {
          level: "info",
          transport: {
            target: "pino-pretty",
            options: { colorize: true },
          },
        }
      : { level: "info" },
  });

  // Initialize config from environment
  updateConfig({
    webhookUrl: WEBHOOK_URL,
    webhookDelayMs: WEBHOOK_DELAY_MS,
    deliveredRate: DELIVERED_RATE,
    bouncedRate: BOUNCED_RATE,
    complainedRate: COMPLAINED_RATE,
  });

  // Register routes
  await registerSESRoutes(app);
  await registerConfigRoutes(app);

  // Start webhook sender background job
  startWebhookSender(100);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[SHUTDOWN] Stopping...");
    stopWebhookSender();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start server
  await app.listen({ port: PORT, host: "0.0.0.0" });

  console.log(`
========================================
  Mock SES/SNS Server
========================================
  http://localhost:${PORT}

  Config:
    Webhook URL: ${WEBHOOK_URL}
    Webhook delay: ${WEBHOOK_DELAY_MS}ms
    Delivered rate: ${(DELIVERED_RATE * 100).toFixed(0)}%
    Bounced rate: ${(BOUNCED_RATE * 100).toFixed(0)}%
    Complained rate: ${(COMPLAINED_RATE * 100).toFixed(0)}%

  Endpoints:
    POST /ses/send    - Send email
    GET  /ses/emails  - List emails
    GET  /stats       - Statistics
    POST /config      - Update config
    POST /reset       - Reset all
    POST /flush       - Flush webhooks
========================================
`);
}

main().catch((err) => {
  console.error("Failed to start mock-ses server:", err);
  process.exit(1);
});
