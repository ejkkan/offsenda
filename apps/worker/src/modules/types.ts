import type {
  SendConfig,
  EmailModuleConfig,
  WebhookModuleConfig,
  RateLimitConfig,
} from "@batchsender/db";

/**
 * Job payload - the data to be processed by a module
 */
export interface JobPayload {
  // Common fields
  to?: string;
  name?: string;

  // Email-specific
  subject?: string;
  htmlContent?: string;
  textContent?: string;
  fromEmail?: string;
  fromName?: string;

  // Webhook-specific (arbitrary data)
  data?: Record<string, unknown>;

  // Template variables (works for all)
  variables?: Record<string, string>;
}

/**
 * Batch job payload - includes recipient identifier
 */
export interface BatchJobPayload {
  recipientId: string;
  payload: JobPayload;
}

/**
 * Result of executing a job
 */
export interface JobResult {
  success: boolean;
  providerMessageId?: string;
  statusCode?: number;
  error?: string;
  latencyMs: number;
}

/**
 * Result of executing a batch job - includes recipient identifier
 */
export interface BatchJobResult {
  recipientId: string;
  result: JobResult;
}

/**
 * Validation result for config or payload
 */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Provider limits - defines max batch size and throughput per provider
 */
export interface ProviderLimits {
  /** Maximum recipients per API request */
  maxBatchSize: number;
  /** Maximum API requests per second */
  maxRequestsPerSecond: number;
}

/**
 * System-defined provider limits (based on provider capabilities)
 */
export const PROVIDER_LIMITS: Record<string, ProviderLimits> = {
  // Email providers (platform services)
  ses: { maxBatchSize: 50, maxRequestsPerSecond: 14 },       // AWS SES SendBulkEmail limit
  resend: { maxBatchSize: 100, maxRequestsPerSecond: 100 },  // Resend batch API
  // SMS providers (platform services)
  telnyx: { maxBatchSize: 1, maxRequestsPerSecond: 50 },     // SMS is typically 1:1
  // Webhooks (BYOK) - user configurable, these are defaults
  webhook: { maxBatchSize: 100, maxRequestsPerSecond: 100 },
};

/**
 * Module interface - all modules must implement this
 */
export interface Module {
  /** Module type identifier */
  readonly type: string;

  /** Human-readable name */
  readonly name: string;

  /** Whether this module supports batch execution */
  readonly supportsBatch: boolean;

  /**
   * Validate module configuration when user saves it
   */
  validateConfig(config: unknown): ValidationResult;

  /**
   * Validate job payload before processing
   */
  validatePayload(payload: JobPayload): ValidationResult;

  /**
   * Execute a single job (send email, call webhook, etc.)
   */
  execute(payload: JobPayload, sendConfig: SendConfig): Promise<JobResult>;

  /**
   * Execute a batch of jobs (optional - only if supportsBatch is true)
   * Returns results in same order as input payloads
   */
  executeBatch?(payloads: BatchJobPayload[], sendConfig: SendConfig): Promise<BatchJobResult[]>;
}

/**
 * Context passed to module execution
 */
export interface ModuleContext {
  batchId: string;
  recipientId: string;
  userId: string;
}

// Re-export config types for convenience
export type { SendConfig, EmailModuleConfig, WebhookModuleConfig, RateLimitConfig };
