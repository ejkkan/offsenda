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
  "queued",
  "processing",
  "completed",
  "failed",
  "paused",
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

// Email batches table
export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 500 }).notNull(),
    fromEmail: varchar("from_email", { length: 255 }).notNull(),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("batches_user_id_idx").on(table.userId),
    statusIdx: index("batches_status_idx").on(table.status),
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
    email: varchar("email", { length: 255 }).notNull(),
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
}));

export const batchesRelations = relations(batches, ({ one, many }) => ({
  user: one(users, {
    fields: [batches.userId],
    references: [users.id],
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

// Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Batch = typeof batches.$inferSelect;
export type NewBatch = typeof batches.$inferInsert;
export type Recipient = typeof recipients.$inferSelect;
export type NewRecipient = typeof recipients.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

export type BatchStatus = (typeof batchStatusEnum.enumValues)[number];
export type RecipientStatus = (typeof recipientStatusEnum.enumValues)[number];
