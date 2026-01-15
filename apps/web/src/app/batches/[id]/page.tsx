import { getServerSession } from "next-auth";
import { notFound } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { batches, recipients } from "@batchsender/db";
import { eq, and, sql } from "drizzle-orm";
import { BatchActions } from "./batch-actions";

export default async function BatchDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await getServerSession(authOptions);

  const batch = await db.query.batches.findFirst({
    where: and(
      eq(batches.id, params.id),
      eq(batches.userId, session!.user.id)
    ),
  });

  if (!batch) {
    notFound();
  }

  const statusCounts = await db
    .select({
      status: recipients.status,
      count: sql<number>`count(*)`,
    })
    .from(recipients)
    .where(eq(recipients.batchId, batch.id))
    .groupBy(recipients.status);

  const recentRecipients = await db.query.recipients.findMany({
    where: eq(recipients.batchId, batch.id),
    orderBy: (recipients, { desc }) => [desc(recipients.updatedAt)],
    limit: 20,
  });

  const statusCountMap = Object.fromEntries(
    statusCounts.map((s) => [s.status, s.count])
  );

  return (
    <div>
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold">{batch.name}</h1>
          <p className="text-gray-500">{batch.subject}</p>
        </div>
        <BatchActions batch={batch} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-6 gap-4 mb-8">
        <StatCard
          label="Total"
          value={batch.totalRecipients}
          color="bg-gray-100"
        />
        <StatCard
          label="Pending"
          value={statusCountMap.pending || 0}
          color="bg-gray-100"
        />
        <StatCard
          label="Sent"
          value={statusCountMap.sent || 0}
          color="bg-blue-100"
        />
        <StatCard
          label="Delivered"
          value={statusCountMap.delivered || 0}
          color="bg-green-100"
        />
        <StatCard
          label="Bounced"
          value={statusCountMap.bounced || 0}
          color="bg-red-100"
        />
        <StatCard
          label="Failed"
          value={statusCountMap.failed || 0}
          color="bg-red-100"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium">Batch Details</h2>
          </div>
          <div className="p-6 space-y-3 text-sm">
            <Row label="Status" value={<StatusBadge status={batch.status} />} />
            <Row label="From" value={`${batch.fromName || ""} <${batch.fromEmail}>`} />
            <Row
              label="Created"
              value={new Date(batch.createdAt).toLocaleString()}
            />
            {batch.startedAt && (
              <Row
                label="Started"
                value={new Date(batch.startedAt).toLocaleString()}
              />
            )}
            {batch.completedAt && (
              <Row
                label="Completed"
                value={new Date(batch.completedAt).toLocaleString()}
              />
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-medium">Recent Recipients</h2>
          </div>
          <div className="divide-y divide-gray-200 max-h-80 overflow-y-auto">
            {recentRecipients.map((r) => (
              <div key={r.id} className="px-6 py-3 flex justify-between items-center">
                <div>
                  <div className="font-medium text-sm">{r.email}</div>
                  {r.name && <div className="text-xs text-gray-500">{r.name}</div>}
                </div>
                <RecipientStatusBadge status={r.status} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className={`${color} rounded-lg px-4 py-3`}>
      <div className="text-xs text-gray-600">{label}</div>
      <div className="text-xl font-bold">{value.toLocaleString()}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-800",
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

function RecipientStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-gray-100 text-gray-800",
    queued: "bg-yellow-100 text-yellow-800",
    sent: "bg-blue-100 text-blue-800",
    delivered: "bg-green-100 text-green-800",
    bounced: "bg-red-100 text-red-800",
    complained: "bg-orange-100 text-orange-800",
    failed: "bg-red-100 text-red-800",
  };

  return (
    <span
      className={`inline-block px-2 py-1 text-xs font-medium rounded ${colors[status] || colors.pending}`}
    >
      {status}
    </span>
  );
}
