/**
 * AWS SES Email Provider
 *
 * Can be configured to use either:
 * - Real AWS SES (production)
 * - Mock SES server (testing)
 *
 * Set SES_ENDPOINT to point to mock server for local testing.
 */

import type { EmailProvider, SendEmailRequest, SendEmailResult } from "./types.js";

export interface SESProviderConfig {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string; // Override for mock server
}

export class SESProvider implements EmailProvider {
  name = "ses";
  private config: SESProviderConfig;

  constructor(config: SESProviderConfig) {
    this.config = config;
  }

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    try {
      // If custom endpoint is set, use simple HTTP API (mock server)
      if (this.config.endpoint) {
        return await this.sendViaMockEndpoint(request);
      }

      // Otherwise use real AWS SES SDK
      return await this.sendViaAWS(request);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Send via mock SES endpoint (for local testing)
   */
  private async sendViaMockEndpoint(request: SendEmailRequest): Promise<SendEmailResult> {
    const response = await fetch(this.config.endpoint!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: request.to,
        from: request.from,
        fromName: request.fromName,
        subject: request.subject,
        html: request.html,
        text: request.text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Mock SES error: ${response.status} - ${error}`,
      };
    }

    const data = (await response.json()) as { MessageId: string };

    return {
      success: true,
      providerMessageId: data.MessageId,
    };
  }

  /**
   * Send via real AWS SES using v2 SDK
   */
  private async sendViaAWS(request: SendEmailRequest): Promise<SendEmailResult> {
    // Dynamic import to avoid loading AWS SDK when using mock
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");

    const client = new SESv2Client({
      region: this.config.region,
      credentials: this.config.accessKeyId
        ? {
            accessKeyId: this.config.accessKeyId,
            secretAccessKey: this.config.secretAccessKey!,
          }
        : undefined, // Use default credential chain
    });

    const fromAddress = request.fromName
      ? `${request.fromName} <${request.from}>`
      : request.from;

    const command = new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: {
        ToAddresses: [request.to],
      },
      Content: {
        Simple: {
          Subject: {
            Data: request.subject,
            Charset: "UTF-8",
          },
          Body: {
            ...(request.html && {
              Html: {
                Data: request.html,
                Charset: "UTF-8",
              },
            }),
            Text: {
              Data: request.text || " ",
              Charset: "UTF-8",
            },
          },
        },
      },
    });

    const result = await client.send(command);

    return {
      success: true,
      providerMessageId: result.MessageId,
    };
  }
}
