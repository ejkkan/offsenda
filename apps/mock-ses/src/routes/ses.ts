/**
 * Mock SES send endpoint
 * Mimics AWS SES SendEmail API response format
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { store } from "../store.js";
import { getConfig, determineOutcome } from "../config.js";

const sendEmailSchema = z.object({
  to: z.string().email(),
  from: z.string().email(),
  fromName: z.string().optional(),
  subject: z.string(),
  html: z.string().optional(),
  text: z.string().optional(),
});

export async function registerSESRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /ses/send - Accept email (mimics SES API)
   * Returns MessageId like real SES
   */
  app.post("/ses/send", async (request, reply) => {
    const config = getConfig();

    if (!config.enabled) {
      return reply.status(503).send({
        error: "Mock SES is disabled",
        code: "ServiceUnavailable",
      });
    }

    const result = sendEmailSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        error: "Invalid request",
        details: result.error.format(),
      });
    }

    const { to, from, fromName, subject, html, text } = result.data;

    // Store the email
    const email = store.add({
      to,
      from: fromName ? `${fromName} <${from}>` : from,
      subject,
      html,
      text,
    });

    // Determine outcome and schedule webhook
    const outcome = determineOutcome();
    const webhookScheduledAt = Date.now() + config.webhookDelayMs;

    store.update(email.messageId, {
      outcome,
      webhookScheduledAt,
    });

    console.log(`[SES] Accepted: ${to} - "${subject}" → ${outcome} (${email.messageId})`);

    // Return SES-like response
    return reply.send({
      MessageId: email.messageId,
      RequestId: `req-${Date.now()}`,
    });
  });

  /**
   * GET /ses/emails - List all sent emails
   */
  app.get("/ses/emails", async (request, reply) => {
    const emails = store.getAll();
    return reply.send({
      count: emails.length,
      emails: emails.map((e) => ({
        messageId: e.messageId,
        to: e.to,
        from: e.from,
        subject: e.subject,
        outcome: e.outcome,
        webhookSent: e.webhookSent,
        createdAt: new Date(e.createdAt).toISOString(),
      })),
    });
  });

  /**
   * GET /ses/email/:messageId - Get single email details
   */
  app.get("/ses/email/:messageId", async (request, reply) => {
    const { messageId } = request.params as { messageId: string };
    const email = store.get(messageId);

    if (!email) {
      return reply.status(404).send({ error: "Email not found" });
    }

    return reply.send({
      messageId: email.messageId,
      to: email.to,
      from: email.from,
      subject: email.subject,
      html: email.html,
      text: email.text,
      outcome: email.outcome,
      webhookSent: email.webhookSent,
      webhookScheduledAt: email.webhookScheduledAt
        ? new Date(email.webhookScheduledAt).toISOString()
        : null,
      createdAt: new Date(email.createdAt).toISOString(),
    });
  });
}
