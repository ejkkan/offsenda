/**
 * Worker Configuration
 *
 * Re-exports from @batchsender/config with backward compatibility aliases.
 * All config is centralized in the shared package.
 */

import { config as sharedConfig, type Config as SharedConfig } from "@batchsender/config";

// =============================================================================
// Backward Compatibility
// =============================================================================
// Support legacy env var names during migration

// MAX_CONCURRENT_EMAILS → MAX_CONCURRENT_REQUESTS
const MAX_CONCURRENT_REQUESTS = process.env.MAX_CONCURRENT_EMAILS
  ? parseInt(process.env.MAX_CONCURRENT_EMAILS, 10)
  : sharedConfig.MAX_CONCURRENT_REQUESTS;

// =============================================================================
// Extended Config with Backward Compatibility
// =============================================================================

export interface Config extends SharedConfig {
  /** @deprecated Use MAX_CONCURRENT_REQUESTS instead */
  MAX_CONCURRENT_EMAILS: number;
}

export const config: Config = {
  ...sharedConfig,
  MAX_CONCURRENT_REQUESTS,
  // Backward compatibility alias
  MAX_CONCURRENT_EMAILS: MAX_CONCURRENT_REQUESTS,
};

// Re-export everything from shared config
export { loadConfig, resetConfig, configSchema } from "@batchsender/config";
export type { Config as SharedConfig } from "@batchsender/config";
