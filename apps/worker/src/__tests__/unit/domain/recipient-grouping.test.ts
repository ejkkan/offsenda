import { describe, it, expect } from "vitest";
import {
  groupRecipientsByStatus,
  isTerminalStatus,
  countByStatus,
  type RecipientState,
  type RecipientStatus,
} from "../../../domain/utils/recipient-grouping.js";

describe("groupRecipientsByStatus", () => {
  it("should return empty groups for empty input", () => {
    const result = groupRecipientsByStatus(new Map());

    expect(result.sent).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("should group sent recipients", () => {
    const states = new Map<string, RecipientState>([
      [
        "r1",
        {
          status: "sent",
          sentAt: 1704067200000, // 2024-01-01
          providerMessageId: "msg-123",
        },
      ],
      [
        "r2",
        {
          status: "sent",
          sentAt: 1704153600000, // 2024-01-02
          providerMessageId: "msg-456",
        },
      ],
    ]);

    const result = groupRecipientsByStatus(states);

    expect(result.sent).toHaveLength(2);
    expect(result.sent[0].id).toBe("r1");
    expect(result.sent[0].providerMessageId).toBe("msg-123");
    expect(result.sent[0].sentAt).toEqual(new Date(1704067200000));
    expect(result.sent[1].id).toBe("r2");
    expect(result.sent[1].providerMessageId).toBe("msg-456");
    expect(result.failed).toHaveLength(0);
  });

  it("should group failed recipients", () => {
    const states = new Map<string, RecipientState>([
      ["r1", { status: "failed", errorMessage: "Connection timeout" }],
      ["r2", { status: "failed", errorMessage: "Invalid email address" }],
    ]);

    const result = groupRecipientsByStatus(states);

    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].id).toBe("r1");
    expect(result.failed[0].errorMessage).toBe("Connection timeout");
    expect(result.failed[1].id).toBe("r2");
    expect(result.failed[1].errorMessage).toBe("Invalid email address");
    expect(result.sent).toHaveLength(0);
  });

  it("should handle mixed statuses", () => {
    const states = new Map<string, RecipientState>([
      ["r1", { status: "sent", sentAt: 1704067200000, providerMessageId: "msg-1" }],
      ["r2", { status: "failed", errorMessage: "Error" }],
      ["r3", { status: "pending" }],
      ["r4", { status: "sent", sentAt: 1704067200000, providerMessageId: "msg-2" }],
      ["r5", { status: "queued" }],
      ["r6", { status: "bounced" }],
    ]);

    const result = groupRecipientsByStatus(states);

    expect(result.sent).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    // pending, queued, bounced are not included in groups
  });

  it("should use default values for missing optional fields", () => {
    const states = new Map<string, RecipientState>([
      ["r1", { status: "sent" }], // missing sentAt and providerMessageId
      ["r2", { status: "failed" }], // missing errorMessage
    ]);

    const result = groupRecipientsByStatus(states);

    expect(result.sent[0].providerMessageId).toBe("");
    expect(result.sent[0].sentAt).toBeInstanceOf(Date);
    expect(result.failed[0].errorMessage).toBe("");
  });
});

describe("isTerminalStatus", () => {
  it("should return true for sent", () => {
    expect(isTerminalStatus("sent")).toBe(true);
  });

  it("should return true for failed", () => {
    expect(isTerminalStatus("failed")).toBe(true);
  });

  it("should return true for bounced", () => {
    expect(isTerminalStatus("bounced")).toBe(true);
  });

  it("should return true for complained", () => {
    expect(isTerminalStatus("complained")).toBe(true);
  });

  it("should return false for pending", () => {
    expect(isTerminalStatus("pending")).toBe(false);
  });

  it("should return false for queued", () => {
    expect(isTerminalStatus("queued")).toBe(false);
  });
});

describe("countByStatus", () => {
  it("should return all zeros for empty input", () => {
    const result = countByStatus(new Map());

    expect(result).toEqual({
      pending: 0,
      queued: 0,
      sent: 0,
      failed: 0,
      bounced: 0,
      complained: 0,
    });
  });

  it("should count all statuses correctly", () => {
    const states = new Map<string, RecipientState>([
      ["r1", { status: "pending" }],
      ["r2", { status: "pending" }],
      ["r3", { status: "queued" }],
      ["r4", { status: "sent", sentAt: 123 }],
      ["r5", { status: "sent", sentAt: 456 }],
      ["r6", { status: "sent", sentAt: 789 }],
      ["r7", { status: "failed", errorMessage: "err" }],
      ["r8", { status: "bounced" }],
      ["r9", { status: "complained" }],
      ["r10", { status: "complained" }],
    ]);

    const result = countByStatus(states);

    expect(result).toEqual({
      pending: 2,
      queued: 1,
      sent: 3,
      failed: 1,
      bounced: 1,
      complained: 2,
    });
  });

  it("should handle single status", () => {
    const states = new Map<string, RecipientState>([
      ["r1", { status: "sent", sentAt: 123 }],
      ["r2", { status: "sent", sentAt: 456 }],
      ["r3", { status: "sent", sentAt: 789 }],
    ]);

    const result = countByStatus(states);

    expect(result.sent).toBe(3);
    expect(result.pending).toBe(0);
    expect(result.failed).toBe(0);
  });
});
