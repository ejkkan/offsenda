import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { batches, recipients, sendConfigs } from "@batchsender/db";

// Limits
const LIMITS = {
  maxBatchSize: 100_000,
  maxPendingJobsPerUser: 1_000_000,
  maxActiveBatchesPerUser: 50,
  maxScheduleAheadDays: 30,
};

const createBatchSchema = z.object({
  name: z.string().min(1),
  subject: z.string().min(1).optional(),
  fromEmail: z.string().email().optional(),
  fromName: z.string().optional(),
  htmlContent: z.string().optional(),
  textContent: z.string().optional(),
  sendConfigId: z.string().uuid().optional(),
  scheduledAt: z.string().datetime().optional(),
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

    // 1. Validate batch size limit
    if (data.recipients.length > LIMITS.maxBatchSize) {
      return NextResponse.json(
        { error: `Batch size exceeds limit of ${LIMITS.maxBatchSize.toLocaleString()} recipients` },
        { status: 400 }
      );
    }

    // 2. Validate send config if provided
    let sendConfig = null;
    if (data.sendConfigId) {
      sendConfig = await db.query.sendConfigs.findFirst({
        where: and(
          eq(sendConfigs.id, data.sendConfigId),
          eq(sendConfigs.userId, session.user.id),
          eq(sendConfigs.isActive, true)
        ),
      });

      if (!sendConfig) {
        return NextResponse.json(
          { error: "Send configuration not found or inactive" },
          { status: 400 }
        );
      }

      // For email module, subject and fromEmail are required
      if (sendConfig.module === "email") {
        if (!data.subject) {
          return NextResponse.json(
            { error: "Subject is required for email batches" },
            { status: 400 }
          );
        }
        // fromEmail can come from config or request
        const configEmail = (sendConfig.config as { fromEmail?: string }).fromEmail;
        if (!data.fromEmail && !configEmail) {
          return NextResponse.json(
            { error: "From email is required (provide in request or send config)" },
            { status: 400 }
          );
        }
      }
    } else {
      // No send config - require email fields (backwards compatibility)
      if (!data.subject) {
        return NextResponse.json(
          { error: "Subject is required" },
          { status: 400 }
        );
      }
      if (!data.fromEmail) {
        return NextResponse.json(
          { error: "From email is required" },
          { status: 400 }
        );
      }
    }

    // 3. Validate scheduled time if provided
    let scheduledAt: Date | null = null;
    if (data.scheduledAt) {
      scheduledAt = new Date(data.scheduledAt);
      const now = new Date();

      if (scheduledAt <= now) {
        return NextResponse.json(
          { error: "Scheduled time must be in the future" },
          { status: 400 }
        );
      }

      const maxScheduleDate = new Date();
      maxScheduleDate.setDate(maxScheduleDate.getDate() + LIMITS.maxScheduleAheadDays);

      if (scheduledAt > maxScheduleDate) {
        return NextResponse.json(
          { error: `Cannot schedule more than ${LIMITS.maxScheduleAheadDays} days ahead` },
          { status: 400 }
        );
      }
    }

    // 4. Check active batches limit
    const activeBatches = await db.query.batches.findMany({
      where: and(
        eq(batches.userId, session.user.id),
        inArray(batches.status, ["queued", "processing", "scheduled"])
      ),
      columns: { id: true },
    });

    if (activeBatches.length >= LIMITS.maxActiveBatchesPerUser) {
      return NextResponse.json(
        { error: `Maximum ${LIMITS.maxActiveBatchesPerUser} active batches allowed` },
        { status: 400 }
      );
    }

    // 5. Check pending jobs limit
    const pendingJobsResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(recipients)
      .innerJoin(batches, eq(recipients.batchId, batches.id))
      .where(
        and(
          eq(batches.userId, session.user.id),
          inArray(recipients.status, ["pending", "queued"])
        )
      );

    const currentPendingJobs = Number(pendingJobsResult[0]?.count || 0);
    if (currentPendingJobs + data.recipients.length > LIMITS.maxPendingJobsPerUser) {
      return NextResponse.json(
        { error: `Would exceed pending jobs limit of ${LIMITS.maxPendingJobsPerUser.toLocaleString()}` },
        { status: 400 }
      );
    }

    // Determine initial status
    const initialStatus = scheduledAt ? "scheduled" : "draft";

    // Get fromEmail from config if not provided
    let fromEmail = data.fromEmail || null;
    let fromName = data.fromName || null;
    if (sendConfig?.module === "email") {
      const configData = sendConfig.config as { fromEmail?: string; fromName?: string };
      fromEmail = fromEmail || configData.fromEmail || null;
      fromName = fromName || configData.fromName || null;
    }

    const [batch] = await db
      .insert(batches)
      .values({
        userId: session.user.id,
        name: data.name,
        subject: data.subject || null,
        fromEmail,
        fromName,
        htmlContent: data.htmlContent || null,
        textContent: data.textContent || null,
        sendConfigId: data.sendConfigId || null,
        scheduledAt,
        totalRecipients: data.recipients.length,
        status: initialStatus,
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

    return NextResponse.json({
      id: batch.id,
      status: initialStatus,
      scheduledAt: scheduledAt?.toISOString() || null,
    });
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
