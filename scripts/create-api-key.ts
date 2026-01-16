#!/usr/bin/env tsx

/**
 * Create an API key for a user
 * Usage: tsx scripts/create-api-key.ts <user-email> [key-name]
 */

import { db } from "../apps/worker/src/db.js";
import { users, apiKeys } from "@batchsender/db";
import { eq } from "drizzle-orm";
import crypto from "crypto";

async function createApiKey(userEmail: string, keyName: string = "Default API Key") {
  // Find user
  const user = await db.query.users.findFirst({
    where: eq(users.email, userEmail),
  });

  if (!user) {
    console.error(`❌ User not found: ${userEmail}`);
    console.log(`\n💡 Create a user first:`);
    console.log(`   tsx scripts/create-user.ts ${userEmail}`);
    process.exit(1);
  }

  // Generate API key
  const apiKey = `bsk_${crypto.randomBytes(32).toString("hex")}`;
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
  const keyPrefix = apiKey.slice(0, 10);

  // Insert into database
  await db.insert(apiKeys).values({
    userId: user.id,
    name: keyName,
    keyHash,
    keyPrefix,
  });

  console.log(`\n✅ API Key Created Successfully!\n`);
  console.log(`User:     ${user.email}`);
  console.log(`Key Name: ${keyName}`);
  console.log(`Prefix:   ${keyPrefix}`);
  console.log(`\n🔑 API Key (save this - it won't be shown again):\n`);
  console.log(`   ${apiKey}\n`);
  console.log(`\n📋 Example Usage:\n`);
  console.log(`   curl -H "Authorization: Bearer ${apiKey}" \\`);
  console.log(`        https://api.valuekeys.io/api/batches\n`);

  process.exit(0);
}

const userEmail = process.argv[2];
const keyName = process.argv[3];

if (!userEmail) {
  console.error("Usage: tsx scripts/create-api-key.ts <user-email> [key-name]");
  process.exit(1);
}

createApiKey(userEmail, keyName);
