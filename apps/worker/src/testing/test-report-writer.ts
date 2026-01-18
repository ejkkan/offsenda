/**
 * Test Report Writer
 *
 * Utility for generating standardized test reports from any test type.
 * Handles file writing, baseline comparison, and narrative generation.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type {
  TestReport,
  TestType,
  TestStatus,
  TestMetrics,
  TestIssue,
  Threshold,
  BaselineComparison,
  LoadTestMetrics,
  Severity,
} from "./test-report-schema.js";
import { TEST_REPORT_PATHS } from "./test-report-schema.js";

// ============================================================================
// Report Builder
// ============================================================================

export interface ReportBuilderOptions {
  testType: TestType;
  name: string;
  preset?: string;
  parameters?: Record<string, number | string | boolean>;
  rootDir?: string;
}

export class TestReportBuilder {
  private startTime: Date;
  private runId: string;
  private options: ReportBuilderOptions;
  private thresholds: Threshold[] = [];
  private issues: TestIssue[] = [];
  private metrics: TestMetrics | null = null;
  private rootDir: string;

  constructor(options: ReportBuilderOptions) {
    this.options = options;
    this.startTime = new Date();
    this.runId = this.generateRunId();
    this.rootDir = options.rootDir || process.cwd();
  }

  private generateRunId(): string {
    const date = new Date().toISOString().split("T")[0];
    const time = new Date().toISOString().split("T")[1].slice(0, 5).replace(":", "");
    const random = Math.random().toString(36).slice(2, 6);
    return `${this.options.testType}-${date}-${time}-${random}`;
  }

  // ---------------------------------------------------------------------------
  // Threshold Management
  // ---------------------------------------------------------------------------

  addThreshold(metric: string, operator: Threshold["operator"], target: number, actual: number): this {
    this.thresholds.push({
      metric,
      operator,
      value: target,
      actual,
      passed: this.evaluateThreshold(operator, actual, target),
    });
    return this;
  }

  private evaluateThreshold(operator: Threshold["operator"], actual: number, target: number): boolean {
    switch (operator) {
      case "<": return actual < target;
      case "<=": return actual <= target;
      case ">": return actual > target;
      case ">=": return actual >= target;
      case "==": return actual === target;
      case "!=": return actual !== target;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue Reporting
  // ---------------------------------------------------------------------------

  addIssue(issue: Omit<TestIssue, "severity"> & { severity?: Severity }): this {
    this.issues.push({
      severity: issue.severity || "medium",
      ...issue,
    } as TestIssue);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  setLoadMetrics(metrics: Omit<LoadTestMetrics, "type">): this {
    this.metrics = { type: "load", ...metrics };

    // Auto-generate issues from metrics
    this.autoDetectIssues(metrics);

    return this;
  }

  setMetrics(metrics: TestMetrics): this {
    this.metrics = metrics;
    return this;
  }

  private autoDetectIssues(metrics: Omit<LoadTestMetrics, "type">): void {
    // High error rate
    if (metrics.errors.rate > 0.01) {
      this.addIssue({
        severity: metrics.errors.rate > 0.05 ? "critical" : "high",
        category: "reliability",
        title: "Elevated error rate",
        description: `Error rate of ${(metrics.errors.rate * 100).toFixed(2)}% exceeds acceptable threshold`,
        evidence: `Total errors: ${metrics.errors.total}, By type: ${JSON.stringify(metrics.errors.byType)}`,
        recommendation: "Investigate error logs and increase retry capacity or timeout values",
      });
    }

    // High latency
    if (metrics.latency.p95 > 1000) {
      this.addIssue({
        severity: metrics.latency.p95 > 5000 ? "high" : "medium",
        category: "performance",
        title: "High p95 latency",
        description: `P95 latency of ${metrics.latency.p95}ms may impact user experience`,
        evidence: `p50: ${metrics.latency.p50}ms, p95: ${metrics.latency.p95}ms, p99: ${metrics.latency.p99}ms`,
        recommendation: "Profile hot paths and consider caching or connection pooling",
      });
    }

    // Throughput below target
    if (metrics.throughput.average < metrics.throughput.target * 0.9) {
      this.addIssue({
        severity: "high",
        category: "performance",
        title: "Throughput below target",
        description: `Average throughput ${metrics.throughput.average} ${metrics.throughput.unit} is below target ${metrics.throughput.target}`,
        evidence: `Peak: ${metrics.throughput.peak}, Avg: ${metrics.throughput.average}, Target: ${metrics.throughput.target}`,
        recommendation: "Scale up workers or increase concurrency settings",
      });
    }

    // Resource pressure
    if (metrics.resources.memoryPeakMb > 800) {
      this.addIssue({
        severity: metrics.resources.memoryPeakMb > 900 ? "high" : "medium",
        category: "resource",
        title: "High memory utilization",
        description: `Peak memory usage of ${metrics.resources.memoryPeakMb}MB approaching limits`,
        evidence: `CPU peak: ${metrics.resources.cpuPeakPercent}%, Memory peak: ${metrics.resources.memoryPeakMb}MB`,
        recommendation: "Increase memory limits or optimize memory usage patterns",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Environment Detection
  // ---------------------------------------------------------------------------

  private getGitInfo(): { commit: string; branch: string } {
    try {
      const commit = execSync("git rev-parse HEAD", { encoding: "utf-8", cwd: this.rootDir }).trim();
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8", cwd: this.rootDir }).trim();
      return { commit, branch };
    } catch {
      return { commit: "unknown", branch: "unknown" };
    }
  }

  private detectEnvironment(): "local" | "staging" | "production" {
    const env = process.env.NODE_ENV || "development";
    const namespace = process.env.K8S_NAMESPACE || "";

    if (namespace.includes("prod")) return "production";
    if (namespace.includes("staging")) return "staging";
    if (env === "production") return "production";
    return "local";
  }

  // ---------------------------------------------------------------------------
  // Narrative Generation
  // ---------------------------------------------------------------------------

  private generateNarrative(status: TestStatus, metrics: TestMetrics | null): string {
    const lines: string[] = [];

    lines.push(`## ${this.options.name} - ${status.toUpperCase()}`);
    lines.push("");

    if (metrics?.type === "load") {
      const m = metrics;
      lines.push(`**Throughput**: Peak ${m.throughput.peak} ${m.throughput.unit}, Average ${m.throughput.average} ${m.throughput.unit} (target: ${m.throughput.target})`);
      lines.push(`**Latency**: p50=${m.latency.p50}ms, p95=${m.latency.p95}ms, p99=${m.latency.p99}ms`);
      lines.push(`**Errors**: ${m.errors.total} total (${(m.errors.rate * 100).toFixed(3)}% rate)`);

      if (m.batches) {
        lines.push(`**Batches**: ${m.batches.completed}/${m.batches.total} completed, avg ${m.batches.avgCompletionTimeMs}ms`);
      }

      if (m.queue) {
        lines.push(`**Queue**: Peak depth ${m.queue.peakDepth}, drained in ${m.queue.drainTimeMs}ms`);
      }
    }

    if (this.issues.length > 0) {
      lines.push("");
      lines.push(`### Issues Found (${this.issues.length})`);
      for (const issue of this.issues) {
        lines.push(`- **[${issue.severity.toUpperCase()}]** ${issue.title}: ${issue.description}`);
      }
    }

    const failedThresholds = this.thresholds.filter((t) => !t.passed);
    if (failedThresholds.length > 0) {
      lines.push("");
      lines.push(`### Failed Thresholds (${failedThresholds.length})`);
      for (const t of failedThresholds) {
        lines.push(`- ${t.metric}: expected ${t.operator} ${t.value}, got ${t.actual}`);
      }
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Baseline Comparison
  // ---------------------------------------------------------------------------

  private loadBaseline(): TestReport | null {
    const baselinePath = join(this.rootDir, TEST_REPORT_PATHS.baseline(this.options.testType));
    if (!existsSync(baselinePath)) return null;

    try {
      return JSON.parse(readFileSync(baselinePath, "utf-8"));
    } catch {
      return null;
    }
  }

  private compareWithBaseline(baseline: TestReport): BaselineComparison | undefined {
    if (!this.metrics || this.metrics.type !== "load") return undefined;
    const baselineMetrics = baseline.metrics;
    if (baselineMetrics.type !== "load") return undefined;

    const current = this.metrics;
    const deltas: BaselineComparison["deltas"] = [];

    // Compare throughput
    const throughputDelta = ((current.throughput.average - baselineMetrics.throughput.average) / baselineMetrics.throughput.average) * 100;
    deltas.push({
      metric: "throughput.average",
      baseline: baselineMetrics.throughput.average,
      current: current.throughput.average,
      changePercent: throughputDelta,
      significance: throughputDelta > 5 ? "improved" : throughputDelta < -5 ? "degraded" : "unchanged",
    });

    // Compare p95 latency
    const latencyDelta = ((current.latency.p95 - baselineMetrics.latency.p95) / baselineMetrics.latency.p95) * 100;
    deltas.push({
      metric: "latency.p95",
      baseline: baselineMetrics.latency.p95,
      current: current.latency.p95,
      changePercent: latencyDelta,
      significance: latencyDelta < -5 ? "improved" : latencyDelta > 10 ? "degraded" : "unchanged",
    });

    // Compare error rate
    const errorDelta = current.errors.rate - baselineMetrics.errors.rate;
    deltas.push({
      metric: "errors.rate",
      baseline: baselineMetrics.errors.rate,
      current: current.errors.rate,
      changePercent: baselineMetrics.errors.rate > 0 ? (errorDelta / baselineMetrics.errors.rate) * 100 : 0,
      significance: errorDelta < -0.001 ? "improved" : errorDelta > 0.005 ? "degraded" : "unchanged",
    });

    return {
      baselineRunId: baseline.runId,
      baselineDate: baseline.startedAt,
      deltas,
      hasRegression: deltas.some((d) => d.significance === "degraded"),
    };
  }

  // ---------------------------------------------------------------------------
  // Build & Write
  // ---------------------------------------------------------------------------

  build(): TestReport {
    const endTime = new Date();
    const git = this.getGitInfo();

    const allThresholdsPassed = this.thresholds.every((t) => t.passed);
    const hasCriticalIssues = this.issues.some((i) => i.severity === "critical");
    const hasHighIssues = this.issues.some((i) => i.severity === "high");

    let status: TestStatus;
    if (hasCriticalIssues || !allThresholdsPassed) {
      status = "failed";
    } else if (hasHighIssues) {
      status = "degraded";
    } else {
      status = "passed";
    }

    const baseline = this.loadBaseline();
    const comparison = baseline ? this.compareWithBaseline(baseline) : undefined;

    // If regression detected, escalate status
    if (comparison?.hasRegression && status === "passed") {
      status = "degraded";
    }

    const report: TestReport = {
      schemaVersion: "1.0",
      runId: this.runId,
      testType: this.options.testType,
      name: this.options.name,
      status,
      startedAt: this.startTime.toISOString(),
      completedAt: endTime.toISOString(),
      durationMs: endTime.getTime() - this.startTime.getTime(),
      environment: {
        gitCommit: git.commit,
        gitBranch: git.branch,
        environment: this.detectEnvironment(),
        infrastructure: {
          workerPods: parseInt(process.env.WORKER_PODS || "1", 10),
          dragonflyMemoryMb: parseInt(process.env.DRAGONFLY_MEMORY_MB || "900", 10),
          natsNodes: parseInt(process.env.NATS_NODES || "1", 10),
          provider: process.env.EMAIL_PROVIDER || "mock",
        },
      },
      configuration: {
        preset: this.options.preset,
        parameters: this.options.parameters || {},
        thresholds: this.thresholds,
      },
      summary: {
        total: this.thresholds.length,
        passed: this.thresholds.filter((t) => t.passed).length,
        failed: this.thresholds.filter((t) => !t.passed).length,
        skipped: 0,
        passRate: this.thresholds.length > 0
          ? (this.thresholds.filter((t) => t.passed).length / this.thresholds.length) * 100
          : 100,
        keyFindings: this.generateKeyFindings(status),
      },
      metrics: this.metrics || { type: "load", throughput: { peak: 0, average: 0, target: 0, unit: "rps" }, latency: { p50: 0, p95: 0, p99: 0, max: 0 }, errors: { total: 0, rate: 0, byType: {} }, resources: { cpuPeakPercent: 0, memoryPeakMb: 0, podScaleEvents: 0 } },
      issues: this.issues,
      comparison,
      narrative: this.generateNarrative(status, this.metrics),
    };

    return report;
  }

  private generateKeyFindings(status: TestStatus): string[] {
    const findings: string[] = [];

    if (status === "passed") {
      findings.push("All thresholds met successfully");
    } else if (status === "failed") {
      findings.push(`${this.thresholds.filter((t) => !t.passed).length} threshold(s) failed`);
    }

    if (this.issues.length > 0) {
      const criticalCount = this.issues.filter((i) => i.severity === "critical").length;
      const highCount = this.issues.filter((i) => i.severity === "high").length;
      if (criticalCount > 0) findings.push(`${criticalCount} critical issue(s) require immediate attention`);
      if (highCount > 0) findings.push(`${highCount} high severity issue(s) found`);
    }

    if (this.metrics?.type === "load") {
      const m = this.metrics;
      if (m.throughput.average >= m.throughput.target) {
        findings.push(`Throughput target achieved: ${m.throughput.average} ${m.throughput.unit}`);
      }
      if (m.errors.rate < 0.001) {
        findings.push("Error rate within acceptable bounds (<0.1%)");
      }
    }

    return findings.slice(0, 3);
  }

  write(): TestReport {
    const report = this.build();

    // Ensure directories exist
    const latestPath = join(this.rootDir, TEST_REPORT_PATHS.latest);
    const latestTypePath = join(this.rootDir, TEST_REPORT_PATHS.latestByType(this.options.testType));
    const historyPath = join(this.rootDir, TEST_REPORT_PATHS.history(
      report.startedAt.split("T")[0],
      report.runId
    ));

    for (const path of [latestPath, latestTypePath, historyPath]) {
      mkdirSync(dirname(path), { recursive: true });
    }

    const json = JSON.stringify(report, null, 2);

    // Write to all locations
    writeFileSync(latestPath, json);
    writeFileSync(latestTypePath, json);
    writeFileSync(historyPath, json);

    console.log(`Test report written to:`);
    console.log(`  - ${latestPath}`);
    console.log(`  - ${latestTypePath}`);
    console.log(`  - ${historyPath}`);

    return report;
  }

  saveAsBaseline(): this {
    const report = this.build();
    const baselinePath = join(this.rootDir, TEST_REPORT_PATHS.baseline(this.options.testType));
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(report, null, 2));
    console.log(`Baseline saved to: ${baselinePath}`);
    return this;
  }
}

// ============================================================================
// Convenience Factory
// ============================================================================

export function createTestReport(options: ReportBuilderOptions): TestReportBuilder {
  return new TestReportBuilder(options);
}
