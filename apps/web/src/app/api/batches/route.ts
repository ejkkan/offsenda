import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { batches, recipients, sendConfigs } from "@batchsender/db";
import type { BatchPayload, ModuleType } from "@batchsender/db";

// Limits
const LIMITS = {
  maxBatchSize: 100_000,
  maxPendingJobsPerUser: 1_000_000,
  maxActiveBatchesPerUser: 50,
  maxScheduleAheadDays: 30,
};

// Module-specific payload schemas
const emailPayloadSchema = z.object({
  subject: z.string().min(1),
  htmlContent: z.string().optional(),
  textContent: z.string().optional(),
  fromEmail: z.string().email().optional(),
  fromName: z.string().optional(),
});

const smsPayloadSchema = z.object({
  message: z.string().min(1).max(1600),
  fromNumber: z.string().optional(),
});

const pushPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  data: z.record(z.unknown()).optional(),
  icon: z.string().optional(),
  badge: z.number().optional(),
});

const webhookPayloadSchema = z.object({
  body: z.record(z.unknown()),
  method: z.enum(["POST", "PUT", "PATCH"]).optional(),
  headers: z.record(z.string()).optional(),
});

// Generic recipient schema (supports both legacy email and new identifier)
const recipientSchema = z.object({
  email: z.string().email().optional(),
  identifier: z.string().min(1).optional(),
  name: z.string().optional(),
  variables: z.record(z.string()).optional(),
}).refine(
  (data) => data.email || data.identifier,
  { message: "Either email or identifier is required" }
);

const createBatchSchema = z.object({
  name: z.string().min(1),
  // GENERIC: Module-specific payload
  payload: z.union([
    emailPayloadSchema,
    smsPayloadSchema,
    pushPayloadSchema,
    webhookPayloadSchema,
  ]).optional(),
  // LEGACY: Email-specific fields (for backwards compatibility)
  subject: z.string().min(1).optional(),
  fromEmail: z.string().email().optional(),
  fromName: z.string().optional(),
  htmlContent: z.string().optional(),
  textContent: z.string().optional(),
  sendConfigId: z.string().uuid().optional(),
  scheduledAt: z.string().datetime().optional(),
  recipients: z.array(recipientSchema).min(1),
});

// Validate payload based on module type
function validatePayloadForModule(
  payload: unknown,
  module: ModuleType
): { valid: boolean; errors?: string[] } {
  try {
    switch (module) {
      case "email":
        emailPayloadSchema.parse(payload);
        break;
      case "sms":
        smsPayloadSchema.parse(payload);
        break;
      case "push":
        pushPayloadSchema.parse(payload);
        break;
      case "webhook":
        webhookPayloadSchema.parse(payload);
        break;
      default:
        return { valid: false, errors: [`Unknown module type: ${module}`] };
    }
    return { valid: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { valid: false, errors: error.errors.map((e) => e.message) };
    }
    return { valid: false, errors: ["Invalid payload"] };
  }
}

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
    let moduleType: ModuleType = "email"; // Default to email for backwards compatibility

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

      moduleType = sendConfig.module;

      // If payload is provided, validate it against the module type
      if (data.payload) {
        const validation = validatePayloadForModule(data.payload, moduleType);
        if (!validation.valid) {
          return NextResponse.json(
            { error: "Invalid payload for module", details: validation.errors },
            { status: 400 }
          );
        }
      } else {
        // No payload - use legacy fields (only works for email module)
        if (moduleType === "email") {
          if (!data.subject) {
            return NextResponse.json(
              { error: "Subject is required for email batches (use payload or legacy fields)" },
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
        } else {
          // Non-email modules require payload
          return NextResponse.json(
            { error: `Payload is required for ${moduleType} module` },
            { status: 400 }
          );
        }
      }
    } else {
      // No send config - require email fields (backwards compatibility)
      if (!data.payload) {
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

    // Build batch payload - either from new payload field or legacy fields
    let batchPayload: BatchPayload | null = null;
    let fromEmail = data.fromEmail || null;
    let fromName = data.fromName || null;

    if (data.payload) {
      // Use new payload structure
      batchPayload = data.payload as BatchPayload;
    }

    // For email module, merge fromEmail/fromName from config if not in request
    if (moduleType === "email" && sendConfig) {
      const configData = sendConfig.config as { fromEmail?: string; fromName?: string };
      fromEmail = fromEmail || configData.fromEmail || null;
      fromName = fromName || configData.fromName || null;
    }

    const [batch] = await db
      .insert(batches)
      .values({
        userId: session.user.id,
        name: data.name,
        // GENERIC: Store payload if provided
        payload: batchPayload,
        // LEGACY: Store email-specific fields for backwards compatibility
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
          // GENERIC: Use identifier if provided, fall back to email
          identifier: r.identifier || r.email || null,
          // LEGACY: Store email for backwards compatibility
          email: r.email || r.identifier || null,
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
