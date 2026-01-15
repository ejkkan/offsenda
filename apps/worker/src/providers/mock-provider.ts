import type { EmailProvider, SendEmailRequest, SendEmailResult } from "./types.js";

export type MockMode = "success" | "fail" | "random";

export interface MockProviderConfig {
  mode: MockMode;
  failureRate?: number;  // 0-1, only used in "random" mode
  latencyMs?: number;    // Simulate network delay
}

export class MockEmailProvider implements EmailProvider {
  name = "mock";
  private config: MockProviderConfig;
  private messageCounter = 0;

  constructor(config: MockProviderConfig) {
    this.config = {
      mode: config.mode || "success",
      failureRate: config.failureRate ?? 0.1,
      latencyMs: config.latencyMs ?? 50,
    };
  }

  async send(request: SendEmailRequest): Promise<SendEmailResult> {
    // Simulate network latency
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await this.sleep(this.config.latencyMs);
    }

    // Check if this email should fail
    if (this.shouldFail()) {
      console.log(`[MOCK] FAILED: ${request.to} - "${request.subject}"`);
      return {
        success: false,
        error: "Simulated failure",
      };
    }

    // Generate a mock message ID
    const messageId = this.generateMessageId();

    console.log(`[MOCK] SENT: ${request.to} - "${request.subject}" (${messageId})`);

    return {
      success: true,
      providerMessageId: messageId,
    };
  }

  async sendBatch(requests: SendEmailRequest[]): Promise<SendEmailResult[]> {
    return Promise.all(requests.map((req) => this.send(req)));
  }

  private shouldFail(): boolean {
    switch (this.config.mode) {
      case "success":
        return false;
      case "fail":
        return true;
      case "random":
        return Math.random() < (this.config.failureRate ?? 0.1);
      default:
        return false;
    }
  }

  private generateMessageId(): string {
    this.messageCounter++;
    return `mock-${Date.now()}-${this.messageCounter.toString().padStart(6, "0")}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
