/**
 * Unified Test Report Schema
 *
 * All test types (load, integration, e2e, stress) output to this format.
 * This enables automated analysis without human interpretation.
 *
 * Design principles:
 * 1. Self-describing: Contains enough context to understand what was tested
 * 2. Comparable: Same structure across test types for trend analysis
 * 3. Actionable: Includes pass/fail criteria and recommendations
 * 4. Traceable: Links to git commit, environment, and configuration
 */

// ============================================================================
// Core Types
// ============================================================================

export type TestType = "load" | "stress" | "integration" | "e2e" | "unit" | "smoke";
export type TestStatus = "passed" | "failed" | "degraded" | "skipped";
export type Severity = "critical" | "high" | "medium" | "low";

export interface TestReport {
  /** Schema version for forward compatibility */
  schemaVersion: "1.0";

  /** Unique identifier for this test run */
  runId: string;

  /** Type of test */
  testType: TestType;

  /** Human-readable name */
  name: string;

  /** Overall status */
  status: TestStatus;

  /** ISO timestamp when test started */
  startedAt: string;

  /** ISO timestamp when test completed */
  completedAt: string;

  /** Duration in milliseconds */
  durationMs: number;

  /** Environment context */
  environment: EnvironmentContext;

  /** Test configuration used */
  configuration: TestConfiguration;

  /** Results summary */
  summary: TestSummary;

  /** Detailed metrics (type-specific) */
  metrics: TestMetrics;

  /** Issues found during the test */
  issues: TestIssue[];

  /** Comparison with baseline (if available) */
  comparison?: BaselineComparison;

  /** AI-friendly narrative summary */
  narrative: string;
}

// ============================================================================
// Environment Context
// ============================================================================

export interface EnvironmentContext {
  /** Git commit SHA */
  gitCommit: string;

  /** Git branch */
  gitBranch: string;

  /** Deployment environment */
  environment: "local" | "staging" | "production";

  /** Kubernetes namespace (if applicable) */
  namespace?: string;

  /** Infrastructure snapshot at test time */
  infrastructure: {
    workerPods: number;
    dragonflyMemoryMb: number;
    natsNodes: number;
    provider: string;
  };
}

// ============================================================================
// Test Configuration
// ============================================================================

export interface TestConfiguration {
  /** Test preset used (e.g., "smoke", "medium", "stress") */
  preset?: string;

  /** Key parameters that affect results */
  parameters: Record<string, number | string | boolean>;

  /** Thresholds that define pass/fail */
  thresholds: Threshold[];
}

export interface Threshold {
  metric: string;
  operator: "<" | "<=" | ">" | ">=" | "==" | "!=";
  value: number;
  passed: boolean;
  actual: number;
}

// ============================================================================
// Test Summary
// ============================================================================

export interface TestSummary {
  /** Total test cases/scenarios */
  total: number;

  /** Passed */
  passed: number;

  /** Failed */
  failed: number;

  /** Skipped */
  skipped: number;

  /** Pass rate as percentage */
  passRate: number;

  /** Key takeaways (1-3 bullet points) */
  keyFindings: string[];
}

// ============================================================================
// Test Metrics (Union type for different test types)
// ============================================================================

export type TestMetrics = LoadTestMetrics | IntegrationTestMetrics | E2ETestMetrics;

export interface LoadTestMetrics {
  type: "load";

  /** Throughput metrics */
  throughput: {
    peak: number;
    average: number;
    target: number;
    unit: "rps" | "msg/s";
  };

  /** Latency metrics in milliseconds */
  latency: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };

  /** Error metrics */
  errors: {
    total: number;
    rate: number;
    byType: Record<string, number>;
  };

  /** Resource utilization */
  resources: {
    cpuPeakPercent: number;
    memoryPeakMb: number;
    podScaleEvents: number;
  };

  /** Batch-specific metrics */
  batches?: {
    total: number;
    completed: number;
    failed: number;
    avgCompletionTimeMs: number;
  };

  /** Queue metrics */
  queue?: {
    peakDepth: number;
    drainTimeMs: number;
  };
}

export interface IntegrationTestMetrics {
  type: "integration";

  /** Test case results */
  testCases: {
    name: string;
    status: TestStatus;
    durationMs: number;
    error?: string;
  }[];

  /** Code coverage (if available) */
  coverage?: {
    lines: number;
    branches: number;
    functions: number;
  };
}

export interface E2ETestMetrics {
  type: "e2e";

  /** Scenario results */
  scenarios: {
    name: string;
    status: TestStatus;
    durationMs: number;
    steps: {
      name: string;
      status: TestStatus;
      durationMs: number;
    }[];
  }[];
}

// ============================================================================
// Issues
// ============================================================================

export interface TestIssue {
  /** Severity level */
  severity: Severity;

  /** Issue category */
  category: "performance" | "reliability" | "correctness" | "resource" | "configuration";

  /** Short title */
  title: string;

  /** Detailed description */
  description: string;

  /** Evidence/data supporting this issue */
  evidence: string;

  /** Suggested fix or investigation */
  recommendation: string;
}

// ============================================================================
// Baseline Comparison
// ============================================================================

export interface BaselineComparison {
  /** Baseline run ID */
  baselineRunId: string;

  /** When baseline was recorded */
  baselineDate: string;

  /** Metric comparisons */
  deltas: {
    metric: string;
    baseline: number;
    current: number;
    changePercent: number;
    significance: "improved" | "degraded" | "unchanged";
  }[];

  /** Overall regression status */
  hasRegression: boolean;
}

// ============================================================================
// Report Storage Location
// ============================================================================

/**
 * Convention: All test reports are stored in a predictable location
 *
 * Directory structure:
 *   test-reports/
 *     latest.json                    <- Most recent report (any type)
 *     latest-{testType}.json         <- Most recent by type (e.g., latest-load.json)
 *     history/
 *       {date}/
 *         {runId}.json               <- Individual reports
 *     baselines/
 *       {testType}-baseline.json     <- Baseline for comparison
 *
 * This allows Claude to:
 *   1. Read test-reports/latest.json for quick status
 *   2. Read test-reports/latest-load.json for specific test type
 *   3. Compare with baselines automatically
 *   4. Analyze trends from history/
 */
export const TEST_REPORT_PATHS = {
  root: "test-reports",
  latest: "test-reports/latest.json",
  latestByType: (type: TestType) => `test-reports/latest-${type}.json`,
  history: (date: string, runId: string) => `test-reports/history/${date}/${runId}.json`,
  baseline: (type: TestType) => `test-reports/baselines/${type}-baseline.json`,
} as const;
