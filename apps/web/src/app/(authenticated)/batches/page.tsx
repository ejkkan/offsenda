import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { batches } from "@batchsender/db";
import type { BatchPayload, EmailBatchPayload, SmsBatchPayload, PushBatchPayload, WebhookBatchPayload } from "@batchsender/db";
import { eq } from "drizzle-orm";
import Link from "next/link";

// Helper to get a summary of the batch content based on module type
function getBatchSummary(batch: {
  payload: BatchPayload | null;
  subject: string | null;
  sendConfigId: string | null;
}): string {
  // If payload exists, extract summary based on content
  if (batch.payload) {
    const payload = batch.payload as Record<string, unknown>;
    if ("subject" in payload) {
      return (payload as EmailBatchPayload).subject || "-";
    }
    if ("message" in payload) {
      const msg = (payload as SmsBatchPayload).message || "";
      return msg.length > 50 ? msg.substring(0, 50) + "..." : msg;
    }
    if ("title" in payload) {
      return (payload as PushBatchPayload).title || "-";
    }
    if ("body" in payload) {
      return "Webhook payload";
    }
  }

  // Fall back to legacy subject field
  return batch.subject || "-";
}

export default async function BatchesPage() {
  const session = await getServerSession(authOptions);

  const allBatches = await db.query.batches.findMany({
    where: eq(batches.userId, session!.user.id),
    orderBy: (batches, { desc }) => [desc(batches.createdAt)],
    with: {
      sendConfig: {
        columns: {
          module: true,
        },
      },
    },
  });

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Batches</h1>
        <Link
          href="/batches/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700"
        >
          New Batch
        </Link>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Channel
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Content
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Progress
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {allBatches.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                  No batches yet. Create your first batch!
                </td>
              </tr>
            ) : (
              allBatches.map((batch) => (
                <tr key={batch.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <Link
                      href={`/batches/${batch.id}`}
                      className="text-blue-600 hover:underline font-medium"
                    >
                      {batch.name}
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    <ModuleBadge module={batch.sendConfig?.module || "email"} />
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                    {getBatchSummary(batch)}
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={batch.status} />
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {batch.sentCount}/{batch.totalRecipients}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {new Date(batch.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModuleBadge({ module }: { module: string }) {
  const config: Record<string, { label: string; color: string }> = {
    email: { label: "Email", color: "bg-blue-100 text-blue-800" },
    sms: { label: "SMS", color: "bg-green-100 text-green-800" },
    push: { label: "Push", color: "bg-purple-100 text-purple-800" },
    webhook: { label: "Webhook", color: "bg-orange-100 text-orange-800" },
  };

  const { label, color } = config[module] || { label: module, color: "bg-gray-100 text-gray-800" };

  return (
    <span className={`inline-block px-2 py-1 text-xs font-medium rounded ${color}`}>
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-800",
    scheduled: "bg-purple-100 text-purple-800",
    queued: "bg-yellow-100 text-yellow-800",
    processing: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
    paused: "bg-orange-100 text-orange-800",
  };

  return (
    <span
      className={`inline-block px-2 py-1 text-xs font-medium rounded ${colors[status] || colors.draft}`}
    >
      {status}
    </span>
  );
}
