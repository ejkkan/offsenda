import { config } from "../config.js";
import type { EmailProvider } from "./types.js";
import { ResendProvider } from "./resend-provider.js";
import { MockEmailProvider, type MockMode } from "./mock-provider.js";
import { SESProvider } from "./ses-provider.js";
import { log } from "../logger.js";

export * from "./types.js";
export { ResendProvider } from "./resend-provider.js";
export { MockEmailProvider, type MockMode } from "./mock-provider.js";
export { SESProvider } from "./ses-provider.js";

let providerInstance: EmailProvider | null = null;

/**
 * Get the configured email provider instance (singleton)
 */
export function getEmailProvider(): EmailProvider {
  if (providerInstance) {
    return providerInstance;
  }

  const providerType = (config as any).EMAIL_PROVIDER || "resend";

  switch (providerType) {
    case "mock":
      const mockMode = ((config as any).MOCK_MODE || "success") as MockMode;
      providerInstance = new MockEmailProvider({
        mode: mockMode,
        failureRate: (config as any).MOCK_FAILURE_RATE || 0.1,
        latencyMs: (config as any).MOCK_LATENCY_MS || 50,
      });
      log.provider.info({ provider: "mock", mode: mockMode }, "initialized");
      break;

    case "ses":
      providerInstance = new SESProvider({
        region: (config as any).AWS_REGION || "us-east-1",
        accessKeyId: (config as any).AWS_ACCESS_KEY_ID,
        secretAccessKey: (config as any).AWS_SECRET_ACCESS_KEY,
        endpoint: (config as any).SES_ENDPOINT,
      });
      const endpoint = (config as any).SES_ENDPOINT;
      log.provider.info(
        { provider: "ses", endpoint: endpoint || "AWS SES" },
        "initialized"
      );
      break;

    case "resend":
    default:
      providerInstance = new ResendProvider(config.RESEND_API_KEY);
      log.provider.info({ provider: "resend" }, "initialized");
      break;
  }

  return providerInstance;
}

/**
 * Reset the provider instance (useful for testing)
 */
export function resetEmailProvider(): void {
  providerInstance = null;
}
