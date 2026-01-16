#!/usr/bin/env tsx

/**
 * Create a user account
 * Usage: tsx scripts/create-user.ts <email> [name]
 */

import { db } from "../apps/worker/src/db.js";
import { users } from "@batchsender/db";
import { eq } from "drizzle-orm";

async function createUser(email: string, name?: string) {
  // Check if user already exists
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (existing) {
    console.error(`❌ User already exists: ${email}`);
    console.log(`\n💡 Create an API key for this user instead:`);
    console.log(`   tsx scripts/create-api-key.ts ${email}`);
    process.exit(1);
  }

  // Create user
  const [user] = await db.insert(users).values({
    email,
    name: name || email.split("@")[0],
  }).returning();

  console.log(`\n✅ User Created Successfully!\n`);
  console.log(`ID:    ${user.id}`);
  console.log(`Email: ${user.email}`);
  console.log(`Name:  ${user.name}`);
  console.log(`\n💡 Next Steps:\n`);
  console.log(`   1. Create an API key:`);
  console.log(`      tsx scripts/create-api-key.ts ${email}\n`);
  console.log(`   2. Configure email provider in .env.prod:`);
  console.log(`      RESEND_API_KEY=re_xxxxx\n`);

  process.exit(0);
}

const email = process.argv[2];
const name = process.argv[3];

if (!email) {
  console.error("Usage: tsx scripts/create-user.ts <email> [name]");
  process.exit(1);
}

createUser(email, name);
