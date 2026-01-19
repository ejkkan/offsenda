import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Enums
export const batchStatusEnum = pgEnum("batch_status", [
  "draft",
  "scheduled",
  "queued",
  "processing",
  "completed",
  "failed",
  "paused",
]);

export const moduleTypeEnum = pgEnum("module_type", [
  "email",
  "webhook",
  "sms",
  "push",
]);

export const recipientStatusEnum = pgEnum("recipient_status", [
  "pending",
  "queued",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
]);

// Users table
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Send configurations (user's module configs)
export const sendConfigs = pgTable(
  "send_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    module: moduleTypeEnum("module").notNull(),
    config: jsonb("config").notNull().$type<SendConfigData>(),
    rateLimit: jsonb("rate_limit").$type<RateLimitConfig>(),
    isDefault: boolean("is_default").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("send_configs_user_id_idx").on(table.userId),
    userModuleIdx: index("send_configs_user_module_idx").on(table.userId, table.module),
  })
);

// Batches table
export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sendConfigId: uuid("send_config_id").references(() => sendConfigs.id, {
      onDelete: "set null",
    }),
    name: varchar("name", { length: 255 }).notNull(),

    // GENERIC: Module-specific payload (new)
    // Email: { subject, htmlContent, textContent, fromEmail?, fromName? }
    // SMS: { message, fromNumber? }
    // Push: { title, body, data, icon? }
    // Webhook: { body, method?, headers? }
    payload: jsonb("payload").$type<BatchPayload>(),

    // LEGACY: Email-specific fields (kept for backwards compatibility)
    subject: varchar("subject", { length: 500 }),
    fromEmail: varchar("from_email", { length: 255 }),
    fromName: varchar("from_name", { length: 255 }),
    htmlContent: text("html_content"),
    textContent: text("text_content"),

    status: batchStatusEnum("status").default("draft").notNull(),
    totalRecipients: integer("total_recipients").default(0).notNull(),
    sentCount: integer("sent_count").default(0).notNull(),
    deliveredCount: integer("delivered_count").default(0).notNull(),
    bouncedCount: integer("bounced_count").default(0).notNull(),
    failedCount: integer("failed_count").default(0).notNull(),
    scheduledAt: timestamp("scheduled_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    // Dry run mode - processes everything but skips actual outbound calls
    dryRun: boolean("dry_run").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("batches_user_id_idx").on(table.userId),
    statusIdx: index("batches_status_idx").on(table.status),
    scheduledIdx: index("batches_scheduled_idx").on(table.status, table.scheduledAt),
    sendConfigIdx: index("batches_send_config_idx").on(table.sendConfigId),
  })
);

// Recipients table
export const recipients = pgTable(
  "recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),

    // GENERIC: Works for any channel (email, phone, device token, URL)
    identifier: varchar("identifier", { length: 500 }),

    // LEGACY: Email-specific field (kept for backwards compatibility)
    email: varchar("email", { length: 255 }),

    name: varchar("name", { length: 255 }),
    variables: jsonb("variables").$type<Record<string, string>>(),
    status: recipientStatusEnum("status").default("pending").notNull(),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    sentAt: timestamp("sent_at"),
    deliveredAt: timestamp("delivered_at"),
    bouncedAt: timestamp("bounced_at"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    batchIdIdx: index("recipients_batch_id_idx").on(table.batchId),
    statusIdx: index("recipients_status_idx").on(table.status),
    providerMessageIdIdx: index("recipients_provider_message_id_idx").on(
      table.providerMessageId
    ),
    batchStatusIdx: index("recipients_batch_status_idx").on(
      table.batchId,
      table.status
    ),
  })
);

// API Keys for users
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    keyHash: varchar("key_hash", { length: 255 }).notNull(),
    keyPrefix: varchar("key_prefix", { length: 10 }).notNull(),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("api_keys_user_id_idx").on(table.userId),
    keyHashIdx: index("api_keys_key_hash_idx").on(table.keyHash),
  })
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  batches: many(batches),
  apiKeys: many(apiKeys),
  sendConfigs: many(sendConfigs),
}));

export const sendConfigsRelations = relations(sendConfigs, ({ one, many }) => ({
  user: one(users, {
    fields: [sendConfigs.userId],
    references: [users.id],
  }),
  batches: many(batches),
}));

export const batchesRelations = relations(batches, ({ one, many }) => ({
  user: one(users, {
    fields: [batches.userId],
    references: [users.id],
  }),
  sendConfig: one(sendConfigs, {
    fields: [batches.sendConfigId],
    references: [sendConfigs.id],
  }),
  recipients: many(recipients),
}));

export const recipientsRelations = relations(recipients, ({ one }) => ({
  batch: one(batches, {
    fields: [recipients.batchId],
    references: [batches.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

// Config type definitions for send_configs
export type EmailModuleConfig = {
  mode: "managed" | "byok";
  provider?: "resend" | "ses";
  apiKey?: string;
  region?: string;
  fromEmail?: string;
  fromName?: string;
};

export type WebhookModuleConfig = {
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  successStatusCodes?: number[];
};

export type SmsModuleConfig = {
  mode?: "managed" | "byok"; // Optional for backwards compatibility (defaults to byok if credentials provided)
  provider: "twilio" | "aws-sns" | "mock" | "telnyx";
  accountSid?: string;
  authToken?: string;
  apiKey?: string;
  region?: string;
  fromNumber?: string;
  messagingProfileId?: string; // Telnyx-specific: optional messaging profile
};

export type PushModuleConfig = {
  provider: "fcm" | "apns";
  apiKey?: string;
  projectId?: string;
  credentials?: string;
  appId?: string;
};

export type SendConfigData = EmailModuleConfig | WebhookModuleConfig | SmsModuleConfig | PushModuleConfig;

// Batch payload types (module-specific content)
export type EmailBatchPayload = {
  subject: string;
  htmlContent?: string;
  textContent?: string;
  fromEmail?: string;
  fromName?: string;
};

export type SmsBatchPayload = {
  message: string;
  fromNumber?: string;
};

export type PushBatchPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  icon?: string;
  badge?: number;
};

export type WebhookBatchPayload = {
  body: Record<string, unknown>;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
};

export type BatchPayload = EmailBatchPayload | SmsBatchPayload | PushBatchPayload | WebhookBatchPayload;

export type RateLimitConfig = {
  perSecond?: number;
  perMinute?: number;
  dailyLimit?: number;
};

// Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Batch = typeof batches.$inferSelect;
export type NewBatch = typeof batches.$inferInsert;
export type Recipient = typeof recipients.$inferSelect;
export type NewRecipient = typeof recipients.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type SendConfig = typeof sendConfigs.$inferSelect;
export type NewSendConfig = typeof sendConfigs.$inferInsert;

export type BatchStatus = (typeof batchStatusEnum.enumValues)[number];
export type RecipientStatus = (typeof recipientStatusEnum.enumValues)[number];
export type ModuleType = (typeof moduleTypeEnum.enumValues)[number];
