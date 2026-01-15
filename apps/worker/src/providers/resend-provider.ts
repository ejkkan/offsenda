import { Resend } from "resend";
import type { EmailProvider, SendEmailRequest, SendEmailResult } from "./types.js";

export class ResendProvider implements EmailProvider {
  name = "resend";
  private client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    try {
      const from = request.fromName
        ? `${request.fromName} <${request.from}>`
        : request.from;

      const result = await this.client.emails.send({
        from,
        to: request.to,
        subject: request.subject,
        ...(request.html ? { html: request.html } : {}),
        text: request.text || " ",
      });

      if (result.error) {
        return {
          success: false,
          error: result.error.message,
        };
      }

      return {
        success: true,
        providerMessageId: result.data?.id,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async sendBatch(requests: SendEmailRequest[]): Promise<SendEmailResult[]> {
    // Resend doesn't have a native batch API, send sequentially
    return Promise.all(requests.map((req) => this.send(req)));
  }
}
