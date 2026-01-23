/**
 * k6 Test Client Library
 *
 * Provides a high-level API for k6 tests to interact with the BatchSender system.
 * Handles authentication, user management, batch operations, and cleanup.
 *
 * Usage:
 *   import { TestClient } from './lib/client.js';
 *
 *   export function setup() {
 *     const client = new TestClient();
 *     const ctx = client.setupTestUser('stress-test');
 *     return ctx;
 *   }
 *
 *   export default function(ctx) {
 *     const client = TestClient.fromContext(ctx);
 *     const batch = client.createBatch({ ... });
 *     client.waitForCompletion(batch.id);
 *   }
 *
 *   export function teardown(ctx) {
 *     const client = TestClient.fromContext(ctx);
 *     client.cleanup();
 *   }
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

// =============================================================================
// Configuration
// =============================================================================

const BASE_URL = __ENV.K6_API_URL || __ENV.API_URL || 'http://localhost:6001';
const ADMIN_SECRET = __ENV.K6_ADMIN_SECRET || __ENV.ADMIN_SECRET || 'test-admin-secret';
const DEFAULT_TIMEOUT = 30; // seconds

// =============================================================================
// Metrics (shared across all tests using this client)
// =============================================================================

export const metrics = {
  batchCreateDuration: new Trend('batch_create_duration', true),
  batchSendDuration: new Trend('batch_send_duration', true),
  batchCompletionDuration: new Trend('batch_completion_duration', true),
  batchThroughput: new Trend('batch_throughput_per_sec', true),
  batchesCompleted: new Counter('batches_completed'),
  batchesFailed: new Counter('batches_failed'),
  batchFailRate: new Rate('batch_fail_rate'),
  apiLatency: new Trend('api_latency', true),
  apiErrors: new Counter('api_errors'),
};

// =============================================================================
// Test Client
// =============================================================================

export class TestClient {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || BASE_URL;
    this.apiKey = config.apiKey || null;
    this.userId = config.userId || null;
    this.testId = config.testId || `test-${Date.now()}`;
    this.createdResources = {
      users: [],
      apiKeys: [],
      sendConfigs: [],
      batches: [],
    };
  }

  /**
   * Create a TestClient from a setup context (for use in default/teardown functions)
   */
  static fromContext(ctx) {
    const client = new TestClient({
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      userId: ctx.userId,
      testId: ctx.testId,
    });
    client.createdResources = ctx.createdResources || client.createdResources;
    return client;
  }

  /**
   * Export context for passing between k6 lifecycle functions
   */
  toContext() {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      userId: this.userId,
      testId: this.testId,
      createdResources: this.createdResources,
    };
  }

  // ===========================================================================
  // HTTP Helpers
  // ===========================================================================

  _headers(includeAuth = true) {
    const headers = {
      'Content-Type': 'application/json',
      // Include admin secret to bypass rate limits during load testing
      'X-Admin-Secret': ADMIN_SECRET,
    };
    if (includeAuth && this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  _adminHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-Admin-Secret': ADMIN_SECRET,
    };
  }

  _request(method, path, body = null, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = options.admin ? this._adminHeaders() : this._headers(options.auth !== false);

    const start = Date.now();
    let response;

    if (method === 'GET') {
      response = http.get(url, { headers, timeout: `${DEFAULT_TIMEOUT}s` });
    } else if (method === 'POST') {
      // Always send valid JSON body (empty object if null) to avoid Fastify parse errors
      response = http.post(url, JSON.stringify(body || {}), { headers, timeout: `${DEFAULT_TIMEOUT}s` });
    } else if (method === 'DELETE') {
      response = http.del(url, null, { headers, timeout: `${DEFAULT_TIMEOUT}s` });
    } else if (method === 'PUT') {
      response = http.put(url, body ? JSON.stringify(body) : null, { headers, timeout: `${DEFAULT_TIMEOUT}s` });
    }

    metrics.apiLatency.add(Date.now() - start);

    if (response.status >= 400) {
      metrics.apiErrors.add(1);
      if (options.throwOnError !== false) {
        console.error(`API Error: ${method} ${path} -> ${response.status}: ${response.body}`);
      }
    }

    return response;
  }

  _parseResponse(response) {
    try {
      return JSON.parse(response.body);
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // Test Setup (Admin Operations)
  // ===========================================================================

  /**
   * Create a test user and API key for this test run.
   * Uses the admin endpoint which doesn't require authentication.
   *
   * @param {string} prefix - Prefix for the test user name
   * @returns {object} Context object with userId, apiKey, etc.
   */
  setupTestUser(prefix = 'k6-test') {
    console.log(`Setting up test user: ${prefix}`);

    // Create test user via admin endpoint
    const userResponse = this._request('POST', '/api/test-setup/user', {
      email: `${prefix}-${this.testId}@test.batchsender.com`,
      name: `${prefix} Test User`,
    }, { admin: true, auth: false });

    if (!check(userResponse, { 'create user: status 200/201': (r) => r.status === 200 || r.status === 201 })) {
      throw new Error(`Failed to create test user: ${userResponse.status} ${userResponse.body}`);
    }

    const userData = this._parseResponse(userResponse);
    this.userId = userData.userId;
    this.apiKey = userData.apiKey;
    this.createdResources.users.push(userData.userId);
    this.createdResources.apiKeys.push(userData.apiKeyId);

    console.log(`Created test user: ${this.userId} with API key`);

    return this.toContext();
  }

  /**
   * Create a send config for this test
   *
   * @param {object} config - Send config options
   * @returns {object} Created send config
   */
  createSendConfig(config = {}) {
    const payload = {
      name: config.name || `${this.testId}-config`,
      module: config.module || 'email',
      config: config.moduleConfig || { mode: 'mock' },
      rateLimit: config.rateLimit || { perSecond: 1000 },
      isDefault: config.isDefault || false,
    };

    const response = this._request('POST', '/api/send-configs', payload);

    if (!check(response, { 'create send config: status 200/201': (r) => r.status === 200 || r.status === 201 })) {
      throw new Error(`Failed to create send config: ${response.status} ${response.body}`);
    }

    const sendConfig = this._parseResponse(response);
    this.createdResources.sendConfigs.push(sendConfig.id);
    return sendConfig;
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  /**
   * Create a batch with automatic chunking for large recipient lists
   *
   * @param {object} options - Batch options
   * @returns {object} Created batch
   */
  createBatch(options = {}) {
    const CHUNK_SIZE = 10000; // Max recipients per request
    const allRecipients = options.recipients || this.generateRecipients(options.recipientCount || 100);

    // First chunk goes with batch creation
    const firstChunk = allRecipients.slice(0, CHUNK_SIZE);
    const remainingRecipients = allRecipients.slice(CHUNK_SIZE);

    const payload = {
      name: options.name || `${this.testId}-batch-${Date.now()}`,
      subject: options.subject || 'k6 Test Email',
      fromEmail: options.fromEmail || 'test@batchsender.com',
      fromName: options.fromName || 'k6 Test',
      htmlContent: options.htmlContent || '<h1>Test</h1><p>Hello {{firstName}}!</p>',
      textContent: options.textContent || 'Hello {{firstName}}!',
      recipients: firstChunk,
      ...(options.sendConfigId && { sendConfigId: options.sendConfigId }),
      ...(options.dryRun !== undefined && { dryRun: options.dryRun }),
    };

    const start = Date.now();
    const response = this._request('POST', '/api/batches', payload);
    metrics.batchCreateDuration.add(Date.now() - start);

    if (!check(response, { 'create batch: status 200/201': (r) => r.status === 200 || r.status === 201 })) {
      metrics.batchesFailed.add(1);
      metrics.batchFailRate.add(true);
      throw new Error(`Failed to create batch: ${response.status} ${response.body}`);
    }

    const batch = this._parseResponse(response);
    this.createdResources.batches.push(batch.id);
    console.log(`Created batch: ${batch.id} (${firstChunk.length} recipients)`);

    // Add remaining recipients in chunks
    if (remainingRecipients.length > 0) {
      let added = firstChunk.length;
      for (let i = 0; i < remainingRecipients.length; i += CHUNK_SIZE) {
        const chunk = remainingRecipients.slice(i, i + CHUNK_SIZE);
        this.addRecipients(batch.id, chunk);
        added += chunk.length;
        console.log(`Added ${chunk.length} more recipients (${added}/${allRecipients.length})`);
      }
    }

    return { ...batch, totalRecipients: allRecipients.length };
  }

  /**
   * Add recipients to an existing batch (chunked upload)
   *
   * @param {string} batchId - Batch ID
   * @param {array} recipients - Recipients to add (max 10k)
   * @returns {object} Response with added count and total
   */
  addRecipients(batchId, recipients) {
    const response = this._request('POST', `/api/batches/${batchId}/recipients`, { recipients });

    if (!check(response, { 'add recipients: status 200': (r) => r.status === 200 })) {
      throw new Error(`Failed to add recipients: ${response.status} ${response.body}`);
    }

    return this._parseResponse(response);
  }

  /**
   * Send/trigger a batch
   *
   * @param {string} batchId - Batch ID
   * @returns {object} Response
   */
  sendBatch(batchId) {
    const start = Date.now();
    const response = this._request('POST', `/api/batches/${batchId}/send`);
    metrics.batchSendDuration.add(Date.now() - start);

    if (!check(response, { 'send batch: status 200': (r) => r.status === 200 })) {
      throw new Error(`Failed to send batch: ${response.status} ${response.body}`);
    }

    console.log(`Sent batch: ${batchId}`);
    return this._parseResponse(response);
  }

  /**
   * Get batch status
   *
   * @param {string} batchId - Batch ID
   * @returns {object} Batch status
   */
  getBatchStatus(batchId) {
    const response = this._request('GET', `/api/batches/${batchId}`);

    if (response.status !== 200) {
      return null;
    }

    return this._parseResponse(response);
  }

  /**
   * Wait for batch to complete
   *
   * @param {string} batchId - Batch ID
   * @param {object} options - Options
   * @returns {object} Final batch status
   */
  waitForCompletion(batchId, options = {}) {
    const maxWait = options.maxWaitSeconds || 300;
    const pollInterval = options.pollIntervalSeconds || 2;
    const silent = options.silent || false;

    const startTime = Date.now();

    while ((Date.now() - startTime) / 1000 < maxWait) {
      sleep(pollInterval);

      const batch = this.getBatchStatus(batchId);
      if (!batch) continue;

      if (batch.status === 'completed' || batch.status === 'failed') {
        const duration = Date.now() - startTime;
        metrics.batchCompletionDuration.add(duration);

        if (batch.status === 'completed') {
          metrics.batchesCompleted.add(1);
          metrics.batchFailRate.add(false);
          const throughput = batch.totalRecipients / (duration / 1000);
          metrics.batchThroughput.add(throughput);
          if (!silent) {
            console.log(`Batch ${batchId} completed in ${duration}ms (${throughput.toFixed(1)}/sec)`);
          }
        } else {
          metrics.batchesFailed.add(1);
          metrics.batchFailRate.add(true);
          if (!silent) {
            console.log(`Batch ${batchId} failed: sent=${batch.sentCount}, failed=${batch.failedCount}`);
          }
        }

        return batch;
      }

      // Log progress
      if (!silent && batch.totalRecipients > 0) {
        const progress = ((batch.sentCount + batch.failedCount) / batch.totalRecipients * 100).toFixed(1);
        console.log(`Batch ${batchId}: ${progress}% complete`);
      }
    }

    // Timeout
    metrics.batchesFailed.add(1);
    metrics.batchFailRate.add(true);
    console.log(`Batch ${batchId} timed out after ${maxWait}s`);
    return null;
  }

  /**
   * Create and send a batch, wait for completion (convenience method)
   *
   * @param {object} options - Batch options
   * @returns {object} Final batch status
   */
  runBatch(options = {}) {
    const batch = this.createBatch(options);
    this.sendBatch(batch.id);
    return this.waitForCompletion(batch.id, {
      maxWaitSeconds: options.maxWaitSeconds,
      pollIntervalSeconds: options.pollIntervalSeconds,
      silent: options.silent,
    });
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  /**
   * Generate test recipients
   *
   * @param {number} count - Number of recipients
   * @param {string} prefix - Email prefix
   * @returns {array} Recipients array
   */
  generateRecipients(count, prefix = 'test') {
    const recipients = [];
    const timestamp = Date.now();

    for (let i = 0; i < count; i++) {
      recipients.push({
        email: `${prefix}-${timestamp}-${i}@test.example.com`,
        name: `Test User ${i}`,
        variables: {
          firstName: `User${i}`,
          orderId: `ORD-${timestamp}-${i}`,
        },
      });
    }

    return recipients;
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Clean up all resources created during this test
   */
  cleanup() {
    console.log(`Cleaning up test resources for: ${this.testId}`);

    // Clean up in reverse order of creation
    for (const batchId of this.createdResources.batches) {
      try {
        this._request('DELETE', `/api/batches/${batchId}`, null, { throwOnError: false });
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    for (const configId of this.createdResources.sendConfigs) {
      try {
        this._request('DELETE', `/api/send-configs/${configId}`, null, { throwOnError: false });
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    // Clean up user via admin endpoint
    if (this.userId) {
      try {
        this._request('DELETE', `/api/test-setup/user/${this.userId}`, null, { admin: true, auth: false, throwOnError: false });
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    console.log('Cleanup complete');
  }
}

// =============================================================================
// Convenience Exports
// =============================================================================

/**
 * Quick setup for simple tests
 */
export function quickSetup(prefix = 'k6') {
  const client = new TestClient();
  return client.setupTestUser(prefix);
}

/**
 * Quick cleanup
 */
export function quickCleanup(ctx) {
  const client = TestClient.fromContext(ctx);
  client.cleanup();
}
