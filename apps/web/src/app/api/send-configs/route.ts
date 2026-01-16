import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendConfigs } from "@batchsender/db";
import type { EmailModuleConfig, WebhookModuleConfig, RateLimitConfig } from "@batchsender/db";

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

const rateLimitSchema = z.object({
  perSecond: z.number().min(1).max(500).optional(),
  perMinute: z.number().optional(),
  dailyLimit: z.number().optional(),
}).optional();

const createSendConfigSchema = z.object({
  name: z.string().min(1).max(255),
  module: z.enum(["email", "webhook"]),
  config: z.union([emailConfigSchema, webhookConfigSchema]),
  rateLimit: rateLimitSchema,
  isDefault: z.boolean().optional(),
});

// Mask sensitive fields in config
function maskSensitiveConfig(config: EmailModuleConfig | WebhookModuleConfig): Record<string, unknown> {
  const masked = { ...config } as Record<string, unknown>;
  if ("apiKey" in masked && masked.apiKey) {
    const key = masked.apiKey as string;
    masked.apiKey = key.slice(0, 8) + "..." + key.slice(-4);
  }
  return masked;
}

// GET /api/send-configs - List all send configs for user
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const configs = await db.query.sendConfigs.findMany({
      where: eq(sendConfigs.userId, session.user.id),
      orderBy: (sendConfigs, { desc }) => [desc(sendConfigs.createdAt)],
    });

    // Mask sensitive fields
    const masked = configs.map((c) => ({
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

    return NextResponse.json({ configs: masked });
  } catch (error) {
    console.error("Get send configs error:", error);
    return NextResponse.json(
      { error: "Failed to get send configs" },
      { status: 500 }
    );
  }
}

// POST /api/send-configs - Create new send config
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const data = createSendConfigSchema.parse(body);

    // Validate config based on module type
    if (data.module === "email") {
      const emailConfig = data.config as EmailModuleConfig;
      if (emailConfig.mode === "byok") {
        if (!emailConfig.provider) {
          return NextResponse.json(
            { error: "Provider is required for BYOK mode" },
            { status: 400 }
          );
        }
        if (!emailConfig.apiKey) {
          return NextResponse.json(
            { error: "API key is required for BYOK mode" },
            { status: 400 }
          );
        }
      }
    } else if (data.module === "webhook") {
      // Webhook config validated by schema
    }

    // Check limit (max 20 configs per user)
    const existingCount = await db.query.sendConfigs.findMany({
      where: eq(sendConfigs.userId, session.user.id),
      columns: { id: true },
    });

    if (existingCount.length >= 20) {
      return NextResponse.json(
        { error: "Maximum 20 send configs allowed per user" },
        { status: 400 }
      );
    }

    // If setting as default, unset other defaults for this module type
    if (data.isDefault) {
      await db
        .update(sendConfigs)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(sendConfigs.userId, session.user.id));
    }

    const [config] = await db
      .insert(sendConfigs)
      .values({
        userId: session.user.id,
        name: data.name,
        module: data.module,
        config: data.config,
        rateLimit: data.rateLimit || null,
        isDefault: data.isDefault || false,
      })
      .returning();

    return NextResponse.json({
      id: config.id,
      name: config.name,
      module: config.module,
      config: maskSensitiveConfig(config.config),
      rateLimit: config.rateLimit,
      isDefault: config.isDefault,
      isActive: config.isActive,
      createdAt: config.createdAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid input", details: error.errors },
        { status: 400 }
      );
    }
    console.error("Create send config error:", error);
    return NextResponse.json(
      { error: "Failed to create send config" },
      { status: 500 }
    );
  }
}
