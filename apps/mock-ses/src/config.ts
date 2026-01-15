/**
 * Runtime configuration for mock SES behavior
 * Can be updated via API during tests
 */

export interface MockConfig {
  // Webhook delivery settings
  webhookUrl: string;
  webhookDelayMs: number;

  // Outcome rates (must sum to <= 1.0)
  deliveredRate: number;
  bouncedRate: number;
  complainedRate: number;

  // Behavior
  enabled: boolean;
}

const defaultConfig: MockConfig = {
  webhookUrl: "http://localhost:6001/webhooks/ses",
  webhookDelayMs: 1000,
  deliveredRate: 0.90,
  bouncedRate: 0.05,
  complainedRate: 0.01,
  enabled: true,
};

let currentConfig: MockConfig = { ...defaultConfig };

export function getConfig(): MockConfig {
  return { ...currentConfig };
}

export function updateConfig(updates: Partial<MockConfig>): MockConfig {
  currentConfig = { ...currentConfig, ...updates };
  return getConfig();
}

export function resetConfig(): MockConfig {
  currentConfig = { ...defaultConfig };
  return getConfig();
}

/**
 * Determine outcome based on configured rates
 */
export function determineOutcome(): "delivered" | "bounced" | "complained" {
  const rand = Math.random();
  const { bouncedRate, complainedRate, deliveredRate } = currentConfig;

  if (rand < bouncedRate) {
    return "bounced";
  }
  if (rand < bouncedRate + complainedRate) {
    return "complained";
  }
  if (rand < bouncedRate + complainedRate + deliveredRate) {
    return "delivered";
  }
  // Remaining percentage stays as "delivered" (no webhook)
  return "delivered";
}
