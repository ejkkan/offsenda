/**
 * In-memory store for mock SES emails
 * Tracks sent emails and their webhook delivery status
 */

export type EmailOutcome = "pending" | "delivered" | "bounced" | "complained";

export interface StoredEmail {
  messageId: string;
  to: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
  outcome: EmailOutcome;
  webhookSent: boolean;
  webhookScheduledAt?: number;
  createdAt: number;
}

export interface StoreStats {
  sent: number;
  webhooksPending: number;
  webhooksSent: number;
  delivered: number;
  bounced: number;
  complained: number;
}

class EmailStore {
  private emails = new Map<string, StoredEmail>();
  private messageCounter = 0;

  generateMessageId(): string {
    this.messageCounter++;
    const timestamp = Date.now().toString(36);
    const counter = this.messageCounter.toString().padStart(6, "0");
    return `mock-ses-${timestamp}-${counter}`;
  }

  add(email: Omit<StoredEmail, "messageId" | "outcome" | "webhookSent" | "createdAt">): StoredEmail {
    const messageId = this.generateMessageId();
    const stored: StoredEmail = {
      ...email,
      messageId,
      outcome: "pending",
      webhookSent: false,
      createdAt: Date.now(),
    };
    this.emails.set(messageId, stored);
    return stored;
  }

  get(messageId: string): StoredEmail | undefined {
    return this.emails.get(messageId);
  }

  update(messageId: string, updates: Partial<StoredEmail>): StoredEmail | undefined {
    const email = this.emails.get(messageId);
    if (!email) return undefined;

    const updated = { ...email, ...updates };
    this.emails.set(messageId, updated);
    return updated;
  }

  getPendingWebhooks(): StoredEmail[] {
    const now = Date.now();
    return Array.from(this.emails.values()).filter(
      (e) => !e.webhookSent && e.webhookScheduledAt && e.webhookScheduledAt <= now
    );
  }

  getAll(): StoredEmail[] {
    return Array.from(this.emails.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getStats(): StoreStats {
    const emails = Array.from(this.emails.values());
    return {
      sent: emails.length,
      webhooksPending: emails.filter((e) => !e.webhookSent && e.outcome !== "pending").length,
      webhooksSent: emails.filter((e) => e.webhookSent).length,
      delivered: emails.filter((e) => e.outcome === "delivered").length,
      bounced: emails.filter((e) => e.outcome === "bounced").length,
      complained: emails.filter((e) => e.outcome === "complained").length,
    };
  }

  reset(): void {
    this.emails.clear();
    this.messageCounter = 0;
  }
}

export const store = new EmailStore();
