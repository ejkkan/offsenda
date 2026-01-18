import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys } from "@batchsender/db";
import crypto from "crypto";

const createApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  expiresAt: z.string().datetime().optional(),
});

// GET /api/api-keys - List all API keys for user
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const keys = await db.query.apiKeys.findMany({
      where: eq(apiKeys.userId, session.user.id),
      orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
    });

    // Return keys without the hash (never expose)
    const safeKeys = keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      createdAt: k.createdAt,
    }));

    return NextResponse.json({ apiKeys: safeKeys });
  } catch (error) {
    console.error("Get API keys error:", error);
    return NextResponse.json(
      { error: "Failed to get API keys" },
      { status: 500 }
    );
  }
}

// POST /api/api-keys - Create new API key
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const data = createApiKeySchema.parse(body);

    // Check limit (max 10 API keys per user)
    const existingCount = await db.query.apiKeys.findMany({
      where: eq(apiKeys.userId, session.user.id),
      columns: { id: true },
    });

    if (existingCount.length >= 10) {
      return NextResponse.json(
        { error: "Maximum 10 API keys allowed per user" },
        { status: 400 }
      );
    }

    // Generate API key (same pattern as scripts/create-api-key.ts)
    const apiKey = `bsk_${crypto.randomBytes(32).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
    const keyPrefix = apiKey.slice(0, 10);

    const [key] = await db
      .insert(apiKeys)
      .values({
        userId: session.user.id,
        name: data.name,
        keyHash,
        keyPrefix,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      })
      .returning();

    // Return the full key ONLY on creation (never again)
    return NextResponse.json({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      apiKey, // Only returned once!
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid input", details: error.errors },
        { status: 400 }
      );
    }
    console.error("Create API key error:", error);
    return NextResponse.json(
      { error: "Failed to create API key" },
      { status: 500 }
    );
  }
}
