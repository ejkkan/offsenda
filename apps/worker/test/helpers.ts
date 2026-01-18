/**
 * E2E test helpers
 */

const WORKER_URL = `http://localhost:${process.env.TEST_WORKER_PORT || "3001"}`;

// Global API key for E2E tests (set by test setup)
let globalApiKey: string | null = null;

export function setApiKey(apiKey: string) {
  globalApiKey = apiKey;
}

export function getApiKey(): string {
  if (!globalApiKey) {
    throw new Error("API key not set. Call setApiKey() first.");
  }
  return globalApiKey;
}

export interface CreateBatchRequest {
  name: string;
  subject: string;
  fromEmail: string;
  fromName?: string;
  htmlContent?: string;
  textContent?: string;
  recipients: Array<{
    email: string;
    name?: string;
    variables?: Record<string, string>;
  }>;
  autoSend?: boolean; // Auto-send batch after creation (for E2E tests)
  dryRun?: boolean; // Dry run mode - skip actual outbound calls
}

export interface CreateBatchResponse {
  id: string;
  name: string;
  totalRecipients: number;
  status: string;
  dryRun: boolean;
}

/**
 * Create a batch via the API
 * If autoSend is true, the batch will be automatically sent after creation
 */
export async function createBatch(
  request: CreateBatchRequest
): Promise<CreateBatchResponse> {
  // Destructure autoSend from request (don't send it to API, but dryRun should be sent)
  const { autoSend, ...batchData } = request;

  const response = await fetch(`${WORKER_URL}/api/batches`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify(batchData),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create batch: ${response.status} ${error}`);
  }

  const batch = await response.json();

  // Auto-send if requested
  if (autoSend) {
    await sendBatch(batch.id);
  }

  return batch;
}

/**
 * Send a batch (transition from draft to queued)
 */
export async function sendBatch(batchId: string): Promise<void> {
  const response = await fetch(`${WORKER_URL}/api/batches/${batchId}/send`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${getApiKey()}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send batch: ${response.status} ${error}`);
  }
}

/**
 * Create a batch and immediately send it (convenience wrapper)
 * This is equivalent to calling createBatch() with autoSend: true
 */
export async function createAndSendBatch(
  request: Omit<CreateBatchRequest, 'autoSend'>
): Promise<CreateBatchResponse> {
  return createBatch({ ...request, autoSend: true });
}

/**
 * Get batch status via API
 */
export async function getBatchStatus(batchId: string): Promise<any> {
  const response = await fetch(`${WORKER_URL}/api/batches/${batchId}`, {
    headers: {
      "Authorization": `Bearer ${getApiKey()}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get batch: ${response.status}`);
  }

  return response.json();
}

/**
 * Send a webhook (simulating SNS)
 */
export async function sendWebhook(payload: string): Promise<void> {
  const response = await fetch(`${WORKER_URL}/webhooks/ses`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "x-amz-sns-message-type": "Notification",
    },
    body: payload,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to send webhook: ${response.status} ${errorText}`);
  }
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<any> {
  const response = await fetch(`${WORKER_URL}/api/queue/status`, {
    headers: {
      "Authorization": `Bearer ${getApiKey()}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get queue stats: ${response.status}`);
  }

  return response.json();
}

/**
 * Wait for a condition to be true
 */
export async function waitFor<T>(
  conditionFn: () => Promise<T | null | undefined | false>,
  options: {
    timeout?: number;
    interval?: number;
    timeoutMessage?: string;
  } = {}
): Promise<T> {
  const {
    timeout = 30000,
    interval = 500,
    timeoutMessage = "Timeout waiting for condition",
  } = options;

  const start = Date.now();

  while (Date.now() - start < timeout) {
    const result = await conditionFn();
    if (result) {
      return result;
    }
    await sleep(interval);
  }

  throw new Error(`${timeoutMessage} (${timeout}ms)`);
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate bulk recipients for load testing
 */
export function generateRecipients(count: number): Array<{
  email: string;
  name: string;
  variables?: Record<string, string>;
}> {
  return Array.from({ length: count }, (_, i) => ({
    email: `user${i}@test.local`,
    name: `Test User ${i}`,
    variables: {
      customField: `value${i}`,
    },
  }));
}

/**
 * Monitor batch progress with live updates
 */
export async function monitorBatchProgress(
  batchId: string,
  onProgress?: (progress: {
    sent: number;
    total: number;
    rate: number;
  }) => void
): Promise<void> {
  let lastSentCount = 0;
  let lastCheckTime = Date.now();

  const checkInterval = setInterval(async () => {
    try {
      const batch = await getBatchStatus(batchId);
      const now = Date.now();
      const elapsed = (now - lastCheckTime) / 1000; // seconds
      const sentSinceLast = batch.sentCount - lastSentCount;
      const rate = sentSinceLast / elapsed;

      if (onProgress) {
        onProgress({
          sent: batch.sentCount,
          total: batch.totalRecipients,
          rate,
        });
      }

      lastSentCount = batch.sentCount;
      lastCheckTime = now;

      // Stop monitoring if completed
      if (batch.status === "completed" || batch.status === "failed") {
        clearInterval(checkInterval);
      }
    } catch (error) {
      // Ignore errors during monitoring
    }
  }, 2000);

  // Return cleanup function
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      clearInterval(checkInterval);
      resolve();
    }, 300000); // Max 5 minutes of monitoring
  });
}

/**
 * Measure throughput of batch processing
 */
export async function measureThroughput(
  batchId: string,
  totalEmails: number
): Promise<{
  totalTimeMs: number;
  emailsPerSecond: number;
  avgLatencyMs: number;
}> {
  const start = Date.now();

  await waitFor(
    async () => {
      const batch = await getBatchStatus(batchId);
      return batch.status === "completed" ? batch : null;
    },
    { timeout: 600000 } // 10 minutes
  );

  const totalTimeMs = Date.now() - start;
  const emailsPerSecond = (totalEmails / totalTimeMs) * 1000;
  const avgLatencyMs = totalTimeMs / totalEmails;

  return {
    totalTimeMs,
    emailsPerSecond,
    avgLatencyMs,
  };
}
