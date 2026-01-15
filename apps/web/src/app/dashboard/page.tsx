import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { batches, recipients } from "@batchsender/db";
import { eq, sql, and, gte } from "drizzle-orm";
import Link from "next/link";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);

  const stats = await db
    .select({
      totalBatches: sql<number>`count(*)`,
      totalRecipients: sql<number>`sum(${batches.totalRecipients})`,
      totalSent: sql<number>`sum(${batches.sentCount})`,
      totalDelivered: sql<number>`sum(${batches.deliveredCount})`,
    })
    .from(batches)
    .where(eq(batches.userId, session!.user.id));

  const recentBatches = await db.query.batches.findMany({
    where: eq(batches.userId, session!.user.id),
    orderBy: (batches, { desc }) => [desc(batches.createdAt)],
    limit: 5,
  });

  const stat = stats[0];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Batches" value={stat?.totalBatches || 0} />
        <StatCard label="Total Recipients" value={stat?.totalRecipients || 0} />
        <StatCard label="Emails Sent" value={stat?.totalSent || 0} />
        <StatCard label="Delivered" value={stat?.totalDelivered || 0} />
      </div>

      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h2 className="text-lg font-medium">Recent Batches</h2>
          <Link
            href="/batches/new"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700"
          >
            New Batch
          </Link>
        </div>
        <div className="divide-y divide-gray-200">
          {recentBatches.length === 0 ? (
            <div className="px-6 py-8 text-center text-gray-500">
              No batches yet. Create your first batch!
            </div>
          ) : (
            recentBatches.map((batch) => (
              <Link
                key={batch.id}
                href={`/batches/${batch.id}`}
                className="block px-6 py-4 hover:bg-gray-50"
              >
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-medium">{batch.name}</div>
                    <div className="text-sm text-gray-500">{batch.subject}</div>
                  </div>
                  <div className="text-right">
                    <StatusBadge status={batch.status} />
                    <div className="text-sm text-gray-500 mt-1">
                      {batch.sentCount}/{batch.totalRecipients} sent
                    </div>
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white rounded-lg shadow px-6 py-4">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-2xl font-bold">{value.toLocaleString()}</div>
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
