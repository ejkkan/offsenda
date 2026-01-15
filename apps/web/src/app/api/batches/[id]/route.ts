import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { eq, and } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { batches } from "@batchsender/db";

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const batch = await db.query.batches.findFirst({
      where: and(
        eq(batches.id, params.id),
        eq(batches.userId, session.user.id)
      ),
      with: {
        recipients: true,
      },
    });

    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }

    return NextResponse.json(batch);
  } catch (error) {
    console.error("Get batch error:", error);
    return NextResponse.json(
      { error: "Failed to get batch" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    const batch = await db.query.batches.findFirst({
      where: and(
        eq(batches.id, params.id),
        eq(batches.userId, session.user.id)
      ),
    });

    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }

    if (action === "queue") {
      if (batch.status !== "draft") {
        return NextResponse.json(
          { error: "Only draft batches can be queued" },
          { status: 400 }
        );
      }

      await db
        .update(batches)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(batches.id, params.id));

      return NextResponse.json({ success: true });
    }

    if (action === "pause") {
      if (batch.status !== "processing") {
        return NextResponse.json(
          { error: "Only processing batches can be paused" },
          { status: 400 }
        );
      }

      await db
        .update(batches)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(batches.id, params.id));

      return NextResponse.json({ success: true });
    }

    if (action === "resume") {
      if (batch.status !== "paused") {
        return NextResponse.json(
          { error: "Only paused batches can be resumed" },
          { status: 400 }
        );
      }

      await db
        .update(batches)
        .set({ status: "queued", updatedAt: new Date() })
        .where(eq(batches.id, params.id));

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Update batch error:", error);
    return NextResponse.json(
      { error: "Failed to update batch" },
      { status: 500 }
    );
  }
}
