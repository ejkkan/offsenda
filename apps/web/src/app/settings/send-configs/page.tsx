import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendConfigs } from "@batchsender/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { SendConfigsList } from "./send-configs-list";

export default async function SendConfigsPage() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/login");
  }

  const configs = await db.query.sendConfigs.findMany({
    where: eq(sendConfigs.userId, session.user.id),
    orderBy: (sendConfigs, { desc }) => [desc(sendConfigs.createdAt)],
  });

  // Mask sensitive fields
  const maskedConfigs = configs.map((c) => ({
    id: c.id,
    name: c.name,
    module: c.module,
    config: maskSensitiveConfig(c.config),
    rateLimit: c.rateLimit,
    isDefault: c.isDefault,
    isActive: c.isActive,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Send Configurations</h1>
          <p className="text-gray-600 mt-1">
            Configure how your batches are sent - email providers, webhooks, and rate limits.
          </p>
        </div>
        <Link
          href="/settings/send-configs/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700"
        >
          New Config
        </Link>
      </div>

      <SendConfigsList initialConfigs={maskedConfigs} />
    </div>
  );
}

function maskSensitiveConfig(config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };
  if ("apiKey" in masked && masked.apiKey) {
    const key = masked.apiKey as string;
    masked.apiKey = key.slice(0, 8) + "..." + key.slice(-4);
  }
  return masked;
}
