/**
 * Test fixtures and helpers for integration tests
 */

import { randomUUID, createHash, randomBytes } from "crypto";

export interface TestBatchConfig {
  recipientCount?: number;
  status?: "draft" | "queued" | "processing" | "completed" | "failed" | "paused";
}

export interface TestRecipientConfig {
  status?: "pending" | "queued" | "sent" | "delivered" | "bounced" | "complained" | "failed";
  providerMessageId?: string;
}

/**
 * Generate a test batch fixture
 */
export function createTestBatch(userId: string, config: TestBatchConfig = {}) {
  return {
    id: randomUUID(),
    userId,
    name: `Test Batch ${Date.now()}`,
    subject: "Test Subject",
    fromEmail: "test@batchsender.local",
    fromName: "Test Sender",
    htmlContent: "<p>Test HTML content</p>",
    textContent: "Test text content",
    status: config.status || "queued",
    totalRecipients: config.recipientCount || 10,
    sentCount: 0,
    deliveredCount: 0,
    bouncedCount: 0,
    failedCount: 0,
  };
}

/**
 * Generate test recipients for a batch
 */
export function createTestRecipients(
  batchId: string,
  count: number,
  config: TestRecipientConfig = {}
) {
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    batchId,
    email: `recipient${i}@test.local`,
    name: `Test Recipient ${i}`,
    variables: { customField: `value${i}` },
    status: config.status || "pending",
    providerMessageId: config.providerMessageId,
  }));
}

/**
 * Generate a test user fixture
 */
export function createTestUser() {
  return {
    id: randomUUID(),
    email: `test-${Date.now()}@batchsender.local`,
    passwordHash: "test-hash",
    name: "Test User",
  };
}

/**
 * Build SNS message envelope for webhook tests
 */
export function buildSNSMessage(
  messageId: string,
  notificationType: "Delivery" | "Bounce" | "Complaint",
  email: string
): string {
  const sesNotification = buildSESNotification(messageId, notificationType, email);

  return JSON.stringify({
    Type: "Notification",
    MessageId: `sns-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    TopicArn: "arn:aws:sns:us-east-1:123456789:test-notifications",
    Subject: "Amazon SES Email Event Notification",
    Message: JSON.stringify(sesNotification),
    Timestamp: new Date().toISOString(),
  });
}

/**
 * Build SES notification payload
 */
export function buildSESNotification(
  messageId: string,
  notificationType: "Delivery" | "Bounce" | "Complaint",
  email: string
): Record<string, unknown> {
  const mail = {
    messageId,
    timestamp: new Date().toISOString(),
    source: "test@batchsender.local",
    destination: [email],
  };

  switch (notificationType) {
    case "Delivery":
      return {
        notificationType: "Delivery",
        mail,
        delivery: {
          recipients: [email],
          timestamp: new Date().toISOString(),
          smtpResponse: "250 2.0.0 OK",
        },
      };

    case "Bounce":
      return {
        notificationType: "Bounce",
        mail,
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          bouncedRecipients: [
            {
              emailAddress: email,
              status: "5.1.1",
              diagnosticCode: "smtp; 550 5.1.1 User unknown",
            },
          ],
          timestamp: new Date().toISOString(),
        },
      };

    case "Complaint":
      return {
        notificationType: "Complaint",
        mail,
        complaint: {
          complainedRecipients: [{ emailAddress: email }],
          complaintFeedbackType: "abuse",
          timestamp: new Date().toISOString(),
        },
      };
  }
}

/**
 * Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 10000, interval = 100 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await sleep(interval);
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a test API key for a user
 * Returns the key itself (for making API requests) and the database record
 *
 * SAFETY: Keys with prefix "bsk_test_" ALWAYS force dryRun=true at batch creation.
 * This means NO real emails/SMS are ever sent, even if tests run against
 * production infrastructure. This is enforced in api.ts and cannot be bypassed.
 *
 * @see api.ts - TEST API KEY SAFETY section
 */
export function createTestApiKey(userId: string): {
  apiKey: string;
  dbRecord: {
    id: string;
    userId: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
  };
} {
  // SAFETY: bsk_test_ prefix forces dryRun=true - no real sends ever
  const apiKey = `bsk_test_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const keyPrefix = apiKey.slice(0, 10);

  return {
    apiKey,
    dbRecord: {
      id: randomUUID(),
      userId,
      name: "Test API Key",
      keyHash,
      keyPrefix,
    },
  };
}
