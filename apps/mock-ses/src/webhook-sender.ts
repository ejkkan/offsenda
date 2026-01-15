/**
 * Background job that fires SNS-formatted webhooks
 * Mimics AWS SES → SNS → webhook flow
 */

import { store, type EmailOutcome, type StoredEmail } from "./store.js";
import { getConfig } from "./config.js";

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Build SNS message envelope (matches AWS format exactly)
 */
function buildSNSMessage(email: StoredEmail): string {
  const sesNotification = buildSESNotification(email);

  return JSON.stringify({
    Type: "Notification",
    MessageId: `sns-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    TopicArn: "arn:aws:sns:us-east-1:123456789:mock-ses-notifications",
    Subject: `Amazon SES Email Event Notification`,
    Message: JSON.stringify(sesNotification),
    Timestamp: new Date().toISOString(),
  });
}

/**
 * Build SES notification payload (matches AWS format exactly)
 */
function buildSESNotification(email: StoredEmail): Record<string, unknown> {
  const mail = {
    messageId: email.messageId,
    timestamp: new Date(email.createdAt).toISOString(),
    source: email.from,
    destination: [email.to],
  };

  switch (email.outcome) {
    case "delivered":
      return {
        notificationType: "Delivery",
        mail,
        delivery: {
          recipients: [email.to],
          timestamp: new Date().toISOString(),
          smtpResponse: "250 2.0.0 OK",
        },
      };

    case "bounced":
      return {
        notificationType: "Bounce",
        mail,
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          bouncedRecipients: [
            {
              emailAddress: email.to,
              status: "5.1.1",
              diagnosticCode: "smtp; 550 5.1.1 User unknown",
            },
          ],
          timestamp: new Date().toISOString(),
        },
      };

    case "complained":
      return {
        notificationType: "Complaint",
        mail,
        complaint: {
          complainedRecipients: [{ emailAddress: email.to }],
          complaintFeedbackType: "abuse",
          timestamp: new Date().toISOString(),
        },
      };

    default:
      throw new Error(`Unknown outcome: ${email.outcome}`);
  }
}

/**
 * Send webhook for a single email
 */
async function sendWebhook(email: StoredEmail): Promise<boolean> {
  const config = getConfig();

  if (!config.enabled || !config.webhookUrl) {
    return false;
  }

  try {
    const body = buildSNSMessage(email);

    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "x-amz-sns-message-type": "Notification",
      },
      body,
    });

    if (response.ok) {
      store.update(email.messageId, { webhookSent: true });
      console.log(`[WEBHOOK] Sent ${email.outcome} for ${email.to} (${email.messageId})`);
      return true;
    } else {
      console.error(`[WEBHOOK] Failed for ${email.messageId}: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error(`[WEBHOOK] Error for ${email.messageId}:`, error);
    return false;
  }
}

/**
 * Process all pending webhooks
 */
async function processPendingWebhooks(): Promise<void> {
  const pending = store.getPendingWebhooks();

  for (const email of pending) {
    await sendWebhook(email);
  }
}

/**
 * Start the webhook sender background job
 */
export function startWebhookSender(intervalMs: number = 100): void {
  if (intervalId) {
    return;
  }

  console.log(`[WEBHOOK] Starting sender (interval: ${intervalMs}ms)`);
  intervalId = setInterval(processPendingWebhooks, intervalMs);
}

/**
 * Stop the webhook sender
 */
export function stopWebhookSender(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[WEBHOOK] Stopped sender");
  }
}

/**
 * Flush all pending webhooks immediately (useful for tests)
 */
export async function flushWebhooks(): Promise<number> {
  const pending = store.getPendingWebhooks();
  let sent = 0;

  for (const email of pending) {
    if (await sendWebhook(email)) {
      sent++;
    }
  }

  return sent;
}
