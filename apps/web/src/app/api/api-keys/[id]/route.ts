import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { eq, and } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiKeys } from "@batchsender/db";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// DELETE /api/api-keys/[id] - Delete API key
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Verify ownership
    const existing = await db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.id, id),
        eq(apiKeys.userId, session.user.id)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "API key not found" }, { status: 404 });
    }

    await db
      .delete(apiKeys)
      .where(and(
        eq(apiKeys.id, id),
        eq(apiKeys.userId, session.user.id)
      ));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete API key error:", error);
    return NextResponse.json(
      { error: "Failed to delete API key" },
      { status: 500 }
    );
  }
}
