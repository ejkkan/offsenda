import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys } from "@batchsender/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { ApiKeysList } from "./api-keys-list";

export default async function ApiKeysPage() {
  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/login");
  }

  const keys = await db.query.apiKeys.findMany({
    where: eq(apiKeys.userId, session.user.id),
    orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
  });

  const safeKeys = keys.map((k) => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    createdAt: k.createdAt,
  }));

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">API Keys</h1>
          <p className="text-gray-600 mt-1">
            Manage your API keys for programmatic access to the BatchSender API.
          </p>
        </div>
        <Link
          href="/settings/api-keys/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700"
        >
          New API Key
        </Link>
      </div>

      <ApiKeysList initialKeys={safeKeys} />
    </div>
  );
}
