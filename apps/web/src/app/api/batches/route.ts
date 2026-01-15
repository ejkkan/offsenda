import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { batches, recipients } from "@batchsender/db";

const createBatchSchema = z.object({
  name: z.string().min(1),
  subject: z.string().min(1),
  fromEmail: z.string().email(),
  fromName: z.string().optional(),
  htmlContent: z.string().optional(),
  textContent: z.string().optional(),
  recipients: z.array(
    z.object({
      email: z.string().email(),
      name: z.string().optional(),
      variables: z.record(z.string()).optional(),
    })
  ).min(1),
});

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const data = createBatchSchema.parse(body);

    const [batch] = await db
      .insert(batches)
      .values({
        userId: session.user.id,
        name: data.name,
        subject: data.subject,
        fromEmail: data.fromEmail,
        fromName: data.fromName || null,
        htmlContent: data.htmlContent || null,
        textContent: data.textContent || null,
        totalRecipients: data.recipients.length,
        status: "draft",
      })
      .returning();

    if (data.recipients.length > 0) {
      await db.insert(recipients).values(
        data.recipients.map((r) => ({
          batchId: batch.id,
          email: r.email,
          name: r.name || null,
          variables: r.variables || null,
          status: "pending" as const,
        }))
      );
    }

    return NextResponse.json({ id: batch.id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid input", details: error.errors },
        { status: 400 }
      );
    }
    console.error("Create batch error:", error);
    return NextResponse.json(
      { error: "Failed to create batch" },
      { status: 500 }
    );
  }
}
