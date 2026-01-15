/**
 * Email provider abstraction layer
 * Allows swapping between Resend, SES, or mock providers
 */

export interface SendEmailRequest {
  to: string;
  from: string;
  fromName?: string;
  subject: string;
  html?: string;
  text: string;
}

export interface SendEmailResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface EmailProvider {
  /** Provider name for logging */
  name: string;

  /** Send a single email */
  send(request: SendEmailRequest): Promise<SendEmailResult>;

  /** Optional: Send multiple emails in batch (more efficient for some providers) */
  sendBatch?(requests: SendEmailRequest[]): Promise<SendEmailResult[]>;
}
