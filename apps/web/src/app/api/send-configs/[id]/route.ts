import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendConfigs } from "@batchsender/db";
import type { SendConfigData } from "@batchsender/db";

// Validation schemas
const emailConfigSchema = z.object({
  mode: z.enum(["managed", "byok"]),
  provider: z.enum(["resend", "ses"]).optional(),
  apiKey: z.string().optional(),
  region: z.string().optional(),
  fromEmail: z.string().email().optional(),
  fromName: z.string().optional(),
});

const webhookConfigSchema = z.object({
  url: z.string().url(),
  method: z.enum(["POST", "PUT"]).optional(),
  headers: z.record(z.string()).optional(),
  timeout: z.number().min(1000).max(60000).optional(),
  retries: z.number().min(0).max(10).optional(),
  successStatusCodes: z.array(z.number()).optional(),
});

const smsConfigSchema = z.object({
  provider: z.enum(["twilio", "aws-sns"]),
  accountSid: z.string().optional(),
  authToken: z.string().optional(),
  apiKey: z.string().optional(),
  region: z.string().optional(),
  fromNumber: z.string().optional(),
});

const pushConfigSchema = z.object({
  provider: z.enum(["fcm", "apns"]),
  apiKey: z.string().optional(),
  projectId: z.string().optional(),
  credentials: z.string().optional(),
  appId: z.string().optional(),
});

const rateLimitSchema = z.object({
  perSecond: z.number().min(1).max(500).optional(),
  perMinute: z.number().optional(),
  dailyLimit: z.number().optional(),
}).optional().nullable();

const updateSendConfigSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.union([emailConfigSchema, webhookConfigSchema, smsConfigSchema, pushConfigSchema]).optional(),
  rateLimit: rateLimitSchema,
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

// Mask sensitive fields in config (works for all module types)
function maskSensitiveConfig(config: SendConfigData): Record<string, unknown> {
  const masked = { ...config } as Record<string, unknown>;
  // Mask API keys
  if ("apiKey" in masked && masked.apiKey) {
    const key = masked.apiKey as string;
    masked.apiKey = key.slice(0, 8) + "..." + key.slice(-4);
  }
  // Mask auth tokens (for Twilio)
  if ("authToken" in masked && masked.authToken) {
    const token = masked.authToken as string;
    masked.authToken = token.slice(0, 4) + "..." + token.slice(-4);
  }
  // Mask credentials (for FCM/APNS)
  if ("credentials" in masked && masked.credentials) {
    masked.credentials = "***masked***";
  }
  return masked;
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/send-configs/[id] - Get single send config
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const config = await db.query.sendConfigs.findFirst({
      where: and(
        eq(sendConfigs.id, id),
        eq(sendConfigs.userId, session.user.id)
      ),
    });

    if (!config) {
      return NextResponse.json({ error: "Send config not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: config.id,
      name: config.name,
      module: config.module,
      config: maskSensitiveConfig(config.config),
      rateLimit: config.rateLimit,
      isDefault: config.isDefault,
      isActive: config.isActive,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    });
  } catch (error) {
    console.error("Get send config error:", error);
    return NextResponse.json(
      { error: "Failed to get send config" },
      { status: 500 }
    );
  }
}

// PUT /api/send-configs/[id] - Update send config
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await req.json();
    const data = updateSendConfigSchema.parse(body);

    // Verify ownership
    const existing = await db.query.sendConfigs.findFirst({
      where: and(
        eq(sendConfigs.id, id),
        eq(sendConfigs.userId, session.user.id)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Send config not found" }, { status: 404 });
    }

    // If setting as default, unset other defaults
    if (data.isDefault) {
      await db
        .update(sendConfigs)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(sendConfigs.userId, session.user.id));
    }

    // Build update object
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.config !== undefined) updateData.config = data.config;
    if (data.rateLimit !== undefined) updateData.rateLimit = data.rateLimit;
    if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    const [updated] = await db
      .update(sendConfigs)
      .set(updateData)
      .where(and(
        eq(sendConfigs.id, id),
        eq(sendConfigs.userId, session.user.id)
      ))
      .returning();

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      module: updated.module,
      config: maskSensitiveConfig(updated.config),
      rateLimit: updated.rateLimit,
      isDefault: updated.isDefault,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid input", details: error.errors },
        { status: 400 }
      );
    }
    console.error("Update send config error:", error);
    return NextResponse.json(
      { error: "Failed to update send config" },
      { status: 500 }
    );
  }
}

// DELETE /api/send-configs/[id] - Delete send config
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Verify ownership
    const existing = await db.query.sendConfigs.findFirst({
      where: and(
        eq(sendConfigs.id, id),
        eq(sendConfigs.userId, session.user.id)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Send config not found" }, { status: 404 });
    }

    await db
      .delete(sendConfigs)
      .where(and(
        eq(sendConfigs.id, id),
        eq(sendConfigs.userId, session.user.id)
      ));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete send config error:", error);
    return NextResponse.json(
      { error: "Failed to delete send config" },
      { status: 500 }
    );
  }
}
