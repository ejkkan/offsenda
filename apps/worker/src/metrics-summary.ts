/**
 * Metrics Summary Module
 *
 * Provides a function to query Prometheus for aggregated metrics.
 * Used by the /api/metrics/summary endpoint to give k6 tests access
 * to real throughput numbers (the source of truth for load tests).
 *
 * This allows k6 running locally to get the same metrics that Grafana shows,
 * rather than calculating throughput from batch completion time (which
 * includes polling overhead and is inaccurate).
 */

import { log } from "./logger.js";

// Default Prometheus URL for in-cluster access
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus-server.monitoring.svc:80";

export interface MetricsSummary {
  emailsSentTotal: number;
  emailsSentRate1m: number;
  emailsSentRate5m: number;
  queueDepth: number;
  batchesInProgress: number;
  batchesCompleted: number;
  batchesFailed: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  timestamp: string;
  source: "prometheus" | "local";
}

interface PrometheusResult {
  status: "success" | "error";
  data: {
    resultType: string;
    result: Array<{
      metric: Record<string, string>;
      value: [number, string];
    }>;
  };
  error?: string;
  errorType?: string;
}

/**
 * Execute a PromQL query and return the numeric result
 */
async function queryPrometheus(query: string): Promise<number | null> {
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      log.system.warn({ status: response.status, query }, "Prometheus query failed");
      return null;
    }

    const data = (await response.json()) as PrometheusResult;

    if (data.status !== "success") {
      log.system.warn({ error: data.error, query }, "Prometheus query error");
      return null;
    }

    if (data.data.result.length === 0) {
      return 0;
    }

    // Return the first result's value
    const value = parseFloat(data.data.result[0].value[1]);
    return isNaN(value) ? 0 : value;
  } catch (error) {
    log.system.warn({ error: (error as Error).message, query }, "Prometheus query exception");
    return null;
  }
}

/**
 * Get metrics summary from Prometheus
 *
 * Queries Prometheus for the key metrics that k6 tests need to
 * verify throughput and accuracy.
 */
export async function getMetricsSummary(): Promise<MetricsSummary> {
  // Try to query Prometheus for real metrics
  const [
    emailsSentTotal,
    emailsSentRate1m,
    emailsSentRate5m,
    queueDepth,
    batchesInProgress,
    batchesCompleted,
    batchesFailed,
    avgLatencyMs,
    p95LatencyMs,
  ] = await Promise.all([
    // Total emails sent (cumulative counter)
    queryPrometheus("sum(emails_sent_total)"),
    // Rate over last 1 minute
    queryPrometheus("sum(rate(emails_sent_total[1m]))"),
    // Rate over last 5 minutes (smoother)
    queryPrometheus("sum(rate(emails_sent_total[5m]))"),
    // Queue depth
    queryPrometheus("sum(nats_queue_depth_total)"),
    // Batches currently processing
    queryPrometheus("sum(batches_in_progress)"),
    // Completed batches
    queryPrometheus('sum(batches_processed_total{status="completed"})'),
    // Failed batches
    queryPrometheus('sum(batches_processed_total{status="failed"})'),
    // Average email send latency in ms
    queryPrometheus("avg(rate(email_send_duration_seconds_sum[1m]) / rate(email_send_duration_seconds_count[1m])) * 1000"),
    // p95 latency (histogram quantile)
    queryPrometheus("histogram_quantile(0.95, sum(rate(email_send_duration_seconds_bucket[5m])) by (le)) * 1000"),
  ]);

  // If Prometheus is unavailable, return zeros with local source indicator
  const prometheusAvailable = emailsSentTotal !== null;

  return {
    emailsSentTotal: emailsSentTotal ?? 0,
    emailsSentRate1m: emailsSentRate1m ?? 0,
    emailsSentRate5m: emailsSentRate5m ?? 0,
    queueDepth: queueDepth ?? 0,
    batchesInProgress: batchesInProgress ?? 0,
    batchesCompleted: batchesCompleted ?? 0,
    batchesFailed: batchesFailed ?? 0,
    avgLatencyMs: avgLatencyMs ?? 0,
    p95LatencyMs: p95LatencyMs ?? 0,
    timestamp: new Date().toISOString(),
    source: prometheusAvailable ? "prometheus" : "local",
  };
}

/**
 * Get the rate of emails sent over a specified time window
 *
 * @param windowSeconds - Time window in seconds (default 60)
 */
export async function getEmailSendRate(windowSeconds: number = 60): Promise<number> {
  const rate = await queryPrometheus(`sum(rate(emails_sent_total[${windowSeconds}s]))`);
  return rate ?? 0;
}

/**
 * Check if Prometheus is reachable
 */
export async function isPrometheusAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${PROMETHEUS_URL}/-/healthy`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
