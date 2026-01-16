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
 * Validation result for config or payload
 */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Module interface - all modules must implement this
 */
export interface Module {
  /** Module type identifier */
  readonly type: string;

  /** Human-readable name */
  readonly name: string;

  /**
   * Validate module configuration when user saves it
   */
  validateConfig(config: unknown): ValidationResult;

  /**
   * Validate job payload before processing
   */
  validatePayload(payload: JobPayload): ValidationResult;

  /**
   * Execute the job (send email, call webhook, etc.)
   */
  execute(payload: JobPayload, sendConfig: SendConfig): Promise<JobResult>;
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
