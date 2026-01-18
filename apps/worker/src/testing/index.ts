/**
 * Testing Module
 *
 * Unified test reporting infrastructure for AI-consumable analytics.
 *
 * Usage:
 *   import { createTestReport, TEST_REPORT_PATHS } from './testing';
 *
 *   const report = createTestReport({
 *     testType: 'load',
 *     name: 'Medium Load Test',
 *     preset: 'medium',
 *     parameters: { batches: 5, recipients: 1000 },
 *   })
 *     .setLoadMetrics({ ... })
 *     .addThreshold('throughput.average', '>=', 100, 150)
 *     .write();
 */

export * from "./test-report-schema.js";
export * from "./test-report-writer.js";
