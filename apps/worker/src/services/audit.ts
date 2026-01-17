import { clickhouse } from "../clickhouse.js";
import { log, getTraceId } from "../logger.js";

// =============================================================================
// Audit Logging Service
// =============================================================================
// Comprehensive audit logging for security and compliance:
// - Tracks all sensitive operations
// - Stores in ClickHouse for analysis and reporting
// - Supports filtering, searching, and alerting
// - Consistent structure across all event types
//
// Design principles:
// - Non-blocking: Audit failures don't break the main flow
// - Structured: Type-safe event definitions
// - Extensible: Easy to add new event types
// - Queryable: Optimized for ClickHouse analytics
// =============================================================================

/**
 * Audit action categories
 */
export type AuditCategory =
  | "auth"           // Authentication events
  | "batch"          // Batch operations
  | "config"         // Configuration changes
  | "api_key"        // API key management
  | "webhook"        // Webhook configuration
  | "admin"          // Administrative actions
  | "security";      // Security-related events

/**
 * Audit action types
 */
export type AuditAction =
  // Auth actions
  | "login_success"
  | "login_failure"
  | "logout"
  | "password_change"
  | "password_reset_request"
  | "password_reset_complete"
  | "session_expired"
  // Batch actions
  | "batch_create"
  | "batch_start"
  | "batch_pause"
  | "batch_resume"
  | "batch_cancel"
  | "batch_delete"
  | "batch_complete"
  // Config actions
  | "send_config_create"
  | "send_config_update"
  | "send_config_delete"
  | "send_config_test"
  // API key actions
  | "api_key_create"
  | "api_key_revoke"
  | "api_key_used"
  // Webhook actions
  | "webhook_config_create"
  | "webhook_config_update"
  | "webhook_config_delete"
  | "webhook_received"
  | "webhook_signature_invalid"
  // Admin actions
  | "user_create"
  | "user_update"
  | "user_delete"
  | "user_suspend"
  | "user_unsuspend"
  // Security actions
  | "rate_limit_exceeded"
  | "invalid_token"
  | "permission_denied"
  | "suspicious_activity"
  | "ip_blocked";

/**
 * Outcome of an action
 */
export type AuditOutcome = "success" | "failure" | "denied";

/**
 * Resource types that can be audited
 */
export type AuditResourceType =
  | "user"
  | "batch"
  | "recipient"
  | "send_config"
  | "api_key"
  | "webhook"
  | "session";

/**
 * Full audit event structure
 */
export interface AuditEvent {
  // Required fields
  action: AuditAction;
  category: AuditCategory;
  outcome: AuditOutcome;
  userId?: string;

  // Context
  resourceType?: AuditResourceType;
  resourceId?: string;
  traceId?: string;

  // Request info
  ip?: string;
  userAgent?: string;
  method?: string;
  path?: string;

  // Additional details
  metadata?: Record<string, unknown>;
  reason?: string;
  errorMessage?: string;
}

/**
 * Simplified event for common use cases
 */
export interface SimpleAuditEvent {
  action: AuditAction;
  userId?: string;
  resourceType?: AuditResourceType;
  resourceId?: string;
  outcome?: AuditOutcome;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  reason?: string;
}

/**
 * Configuration for the audit service
 */
export interface AuditServiceConfig {
  /** Whether audit logging is enabled */
  enabled: boolean;

  /** Whether to log to console in addition to ClickHouse */
  logToConsole: boolean;

  /** Batch size for bulk inserts */
  batchSize: number;

  /** Flush interval for batched events (ms) */
  flushIntervalMs: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: AuditServiceConfig = {
  enabled: true,
  logToConsole: false,
  batchSize: 100,
  flushIntervalMs: 5000,
};

/**
 * Map actions to categories
 */
const ACTION_CATEGORIES: Record<AuditAction, AuditCategory> = {
  // Auth
  login_success: "auth",
  login_failure: "auth",
  logout: "auth",
  password_change: "auth",
  password_reset_request: "auth",
  password_reset_complete: "auth",
  session_expired: "auth",
  // Batch
  batch_create: "batch",
  batch_start: "batch",
  batch_pause: "batch",
  batch_resume: "batch",
  batch_cancel: "batch",
  batch_delete: "batch",
  batch_complete: "batch",
  // Config
  send_config_create: "config",
  send_config_update: "config",
  send_config_delete: "config",
  send_config_test: "config",
  // API key
  api_key_create: "api_key",
  api_key_revoke: "api_key",
  api_key_used: "api_key",
  // Webhook
  webhook_config_create: "webhook",
  webhook_config_update: "webhook",
  webhook_config_delete: "webhook",
  webhook_received: "webhook",
  webhook_signature_invalid: "webhook",
  // Admin
  user_create: "admin",
  user_update: "admin",
  user_delete: "admin",
  user_suspend: "admin",
  user_unsuspend: "admin",
  // Security
  rate_limit_exceeded: "security",
  invalid_token: "security",
  permission_denied: "security",
  suspicious_activity: "security",
  ip_blocked: "security",
};

/**
 * Audit Logging Service
 */
export class AuditService {
  private config: AuditServiceConfig;
  private eventBuffer: AuditEvent[] = [];
  private flushIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<AuditServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the audit service (begins periodic flushing)
   */
  start(): void {
    if (!this.config.enabled) {
      log.system.info({}, "audit service disabled");
      return;
    }

    if (this.flushIntervalId) {
      return;
    }

    this.flushIntervalId = setInterval(() => {
      this.flush().catch((error) => {
        log.system.error({ error: (error as Error).message }, "audit flush failed");
      });
    }, this.config.flushIntervalMs);

    log.system.info({}, "audit service started");
  }

  /**
   * Stop the audit service
   */
  async stop(): Promise<void> {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }

    // Flush remaining events
    await this.flush();
    log.system.info({}, "audit service stopped");
  }

  /**
   * Log an audit event (simplified interface)
   */
  async log(event: SimpleAuditEvent): Promise<void> {
    const fullEvent: AuditEvent = {
      action: event.action,
      category: ACTION_CATEGORIES[event.action],
      outcome: event.outcome || "success",
      userId: event.userId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      traceId: getTraceId(),
      ip: event.ip,
      userAgent: event.userAgent,
      metadata: event.metadata,
      reason: event.reason,
    };

    await this.logEvent(fullEvent);
  }

  /**
   * Log a full audit event
   */
  async logEvent(event: AuditEvent): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // Add trace ID if not present
    if (!event.traceId) {
      event.traceId = getTraceId();
    }

    // Log to console if enabled
    if (this.config.logToConsole) {
      log.system.info(
        {
          audit: true,
          action: event.action,
          category: event.category,
          outcome: event.outcome,
          userId: event.userId,
          resourceId: event.resourceId,
        },
        `audit: ${event.action}`
      );
    }

    // Add to buffer
    this.eventBuffer.push(event);

    // Flush if buffer is full
    if (this.eventBuffer.length >= this.config.batchSize) {
      await this.flush();
    }
  }

  /**
   * Flush buffered events to ClickHouse
   */
  async flush(): Promise<void> {
    if (this.eventBuffer.length === 0) {
      return;
    }

    const events = this.eventBuffer.splice(0, this.eventBuffer.length);

    try {
      const values = events.map((event) => ({
        timestamp: new Date().toISOString(),
        action: event.action,
        category: event.category,
        outcome: event.outcome,
        user_id: event.userId || "",
        resource_type: event.resourceType || "",
        resource_id: event.resourceId || "",
        trace_id: event.traceId || "",
        ip: event.ip || "",
        user_agent: event.userAgent || "",
        method: event.method || "",
        path: event.path || "",
        metadata: JSON.stringify(event.metadata || {}),
        reason: event.reason || "",
        error_message: event.errorMessage || "",
      }));

      await clickhouse.insert({
        table: "audit_log",
        values,
        format: "JSONEachRow",
      });

      log.system.debug({ count: events.length }, "audit events flushed");
    } catch (error) {
      // Don't lose events on failure - put them back
      this.eventBuffer.unshift(...events);
      log.system.error(
        { error: (error as Error).message, count: events.length },
        "failed to flush audit events"
      );
    }
  }

  /**
   * Log a success event
   */
  async success(
    action: AuditAction,
    options: Omit<SimpleAuditEvent, "action" | "outcome"> = {}
  ): Promise<void> {
    await this.log({ action, outcome: "success", ...options });
  }

  /**
   * Log a failure event
   */
  async failure(
    action: AuditAction,
    reason: string,
    options: Omit<SimpleAuditEvent, "action" | "outcome" | "reason"> = {}
  ): Promise<void> {
    await this.log({ action, outcome: "failure", reason, ...options });
  }

  /**
   * Log a denied event
   */
  async denied(
    action: AuditAction,
    reason: string,
    options: Omit<SimpleAuditEvent, "action" | "outcome" | "reason"> = {}
  ): Promise<void> {
    await this.log({ action, outcome: "denied", reason, ...options });
  }

  /**
   * Query audit logs (for admin interface)
   */
  async query(params: {
    userId?: string;
    action?: AuditAction;
    category?: AuditCategory;
    outcome?: AuditOutcome;
    resourceType?: AuditResourceType;
    resourceId?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const queryParams: Record<string, unknown> = {};

    if (params.userId) {
      conditions.push("user_id = {userId:String}");
      queryParams.userId = params.userId;
    }

    if (params.action) {
      conditions.push("action = {action:String}");
      queryParams.action = params.action;
    }

    if (params.category) {
      conditions.push("category = {category:String}");
      queryParams.category = params.category;
    }

    if (params.outcome) {
      conditions.push("outcome = {outcome:String}");
      queryParams.outcome = params.outcome;
    }

    if (params.resourceType) {
      conditions.push("resource_type = {resourceType:String}");
      queryParams.resourceType = params.resourceType;
    }

    if (params.resourceId) {
      conditions.push("resource_id = {resourceId:String}");
      queryParams.resourceId = params.resourceId;
    }

    if (params.startDate) {
      conditions.push("timestamp >= {startDate:DateTime}");
      queryParams.startDate = params.startDate.toISOString();
    }

    if (params.endDate) {
      conditions.push("timestamp <= {endDate:DateTime}");
      queryParams.endDate = params.endDate.toISOString();
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params.limit || 100;
    const offset = params.offset || 0;

    const result = await clickhouse.query({
      query: `
        SELECT *
        FROM audit_log
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
      `,
      query_params: { ...queryParams, limit, offset },
      format: "JSONEachRow",
    });

    const rows = await result.json<{
      timestamp: string;
      action: AuditAction;
      category: AuditCategory;
      outcome: AuditOutcome;
      user_id: string;
      resource_type: string;
      resource_id: string;
      trace_id: string;
      ip: string;
      user_agent: string;
      method: string;
      path: string;
      metadata: string;
      reason: string;
      error_message: string;
    }>();

    return rows.map((row) => ({
      action: row.action,
      category: row.category,
      outcome: row.outcome,
      userId: row.user_id || undefined,
      resourceType: (row.resource_type as AuditResourceType) || undefined,
      resourceId: row.resource_id || undefined,
      traceId: row.trace_id || undefined,
      ip: row.ip || undefined,
      userAgent: row.user_agent || undefined,
      method: row.method || undefined,
      path: row.path || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      reason: row.reason || undefined,
      errorMessage: row.error_message || undefined,
    }));
  }

  /**
   * Get audit event counts by category (for dashboard)
   */
  async getStats(params: {
    userId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<Record<AuditCategory, { total: number; success: number; failure: number; denied: number }>> {
    const conditions: string[] = [];
    const queryParams: Record<string, unknown> = {};

    if (params.userId) {
      conditions.push("user_id = {userId:String}");
      queryParams.userId = params.userId;
    }

    if (params.startDate) {
      conditions.push("timestamp >= {startDate:DateTime}");
      queryParams.startDate = params.startDate.toISOString();
    }

    if (params.endDate) {
      conditions.push("timestamp <= {endDate:DateTime}");
      queryParams.endDate = params.endDate.toISOString();
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await clickhouse.query({
      query: `
        SELECT
          category,
          count() AS total,
          countIf(outcome = 'success') AS success,
          countIf(outcome = 'failure') AS failure,
          countIf(outcome = 'denied') AS denied
        FROM audit_log
        ${whereClause}
        GROUP BY category
      `,
      query_params: queryParams,
      format: "JSONEachRow",
    });

    const rows = await result.json<{
      category: AuditCategory;
      total: string;
      success: string;
      failure: string;
      denied: string;
    }>();

    const stats: Record<AuditCategory, { total: number; success: number; failure: number; denied: number }> = {
      auth: { total: 0, success: 0, failure: 0, denied: 0 },
      batch: { total: 0, success: 0, failure: 0, denied: 0 },
      config: { total: 0, success: 0, failure: 0, denied: 0 },
      api_key: { total: 0, success: 0, failure: 0, denied: 0 },
      webhook: { total: 0, success: 0, failure: 0, denied: 0 },
      admin: { total: 0, success: 0, failure: 0, denied: 0 },
      security: { total: 0, success: 0, failure: 0, denied: 0 },
    };

    for (const row of rows) {
      stats[row.category] = {
        total: parseInt(row.total),
        success: parseInt(row.success),
        failure: parseInt(row.failure),
        denied: parseInt(row.denied),
      };
    }

    return stats;
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<AuditServiceConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Get current configuration
   */
  getConfig(): AuditServiceConfig {
    return { ...this.config };
  }
}

// =============================================================================
// Singleton & Helper Functions
// =============================================================================

let instance: AuditService | null = null;

/**
 * Get the audit service singleton
 */
export function getAuditService(config?: Partial<AuditServiceConfig>): AuditService {
  if (!instance) {
    instance = new AuditService(config);
  }
  return instance;
}

/**
 * Convenience function to log an audit event
 */
export async function audit(event: SimpleAuditEvent): Promise<void> {
  return getAuditService().log(event);
}

/**
 * Convenience function to log a success
 */
export async function auditSuccess(
  action: AuditAction,
  options: Omit<SimpleAuditEvent, "action" | "outcome"> = {}
): Promise<void> {
  return getAuditService().success(action, options);
}

/**
 * Convenience function to log a failure
 */
export async function auditFailure(
  action: AuditAction,
  reason: string,
  options: Omit<SimpleAuditEvent, "action" | "outcome" | "reason"> = {}
): Promise<void> {
  return getAuditService().failure(action, reason, options);
}

/**
 * Convenience function to log a denied action
 */
export async function auditDenied(
  action: AuditAction,
  reason: string,
  options: Omit<SimpleAuditEvent, "action" | "outcome" | "reason"> = {}
): Promise<void> {
  return getAuditService().denied(action, reason, options);
}
