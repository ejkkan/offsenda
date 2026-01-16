export interface HealthCheckConfig {
  url: string;
  service: string;
  expectedText?: string;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
}

export interface HealthCheckResult {
  service: string;
  healthy: boolean;
  attempts: number;
  error?: string;
}

/**
 * Perform a single HTTP health check
 */
async function performHealthCheck(
  url: string,
  expectedText?: string,
  timeout: number = 5000
): Promise<{ success: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      method: 'GET',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    if (expectedText) {
      const text = await response.text();
      if (!text.includes(expectedText)) {
        return { success: false, error: `Response doesn't contain "${expectedText}"` };
      }
    }

    return { success: true };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { success: false, error: 'Timeout' };
      }
      return { success: false, error: error.message };
    }
    return { success: false, error: 'Unknown error' };
  }
}

/**
 * Wait for a service to become healthy with retries
 */
export async function waitForHealthy(config: HealthCheckConfig): Promise<HealthCheckResult> {
  const maxRetries = config.maxRetries ?? 30;
  const retryDelay = config.retryDelay ?? 1000;
  const timeout = config.timeout ?? 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { success, error } = await performHealthCheck(
      config.url,
      config.expectedText,
      timeout
    );

    if (success) {
      return {
        service: config.service,
        healthy: true,
        attempts: attempt,
      };
    }

    // If this was the last attempt, return failure
    if (attempt === maxRetries) {
      return {
        service: config.service,
        healthy: false,
        attempts: attempt,
        error,
      };
    }

    // Wait before retrying
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  // Should never reach here, but TypeScript needs it
  return {
    service: config.service,
    healthy: false,
    attempts: maxRetries,
    error: 'Max retries exceeded',
  };
}

/**
 * Wait for multiple services to become healthy concurrently
 */
export async function waitForAllHealthy(
  configs: HealthCheckConfig[]
): Promise<HealthCheckResult[]> {
  return Promise.all(configs.map((config) => waitForHealthy(config)));
}

/**
 * Quick health check without retries
 */
export async function isHealthy(url: string, expectedText?: string): Promise<boolean> {
  const { success } = await performHealthCheck(url, expectedText, 3000);
  return success;
}

/**
 * Common health check configurations
 */
export const HEALTH_CHECKS = {
  nats: {
    url: 'http://localhost:8222/healthz',
    service: 'NATS',
    expectedText: 'ok',
  },
  clickhouse: {
    url: 'http://localhost:8123/ping',
    service: 'ClickHouse',
    expectedText: 'Ok',
  },
  worker: {
    url: 'http://localhost:6001/health',
    service: 'Worker API',
  },
  web: {
    url: 'http://localhost:5001',
    service: 'Web App',
  },
  prometheus: {
    url: 'http://localhost:9095/-/healthy',
    service: 'Prometheus',
  },
  grafana: {
    url: 'http://localhost:3003/api/health',
    service: 'Grafana',
  },
} as const;
