#!/usr/bin/env tsx

/**
 * Truncate all database tables (empty data while keeping schema)
 * Usage: tsx scripts/db-truncate.ts [local|remote]
 * Default: local
 */

import { createDb, users, sendConfigs, batches, recipients, apiKeys } from "@batchsender/db";
import { sql } from "drizzle-orm";
import * as readline from 'readline/promises';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function truncateTables(env: string) {
  let databaseUrl: string;

  if (env === "local") {
    // Use local database URL
    databaseUrl = process.env.DATABASE_URL || 'postgresql://batchsender:batchsender@localhost:5455/batchsender';
    console.log("🗄️  Using local database");
  } else if (env === "remote") {
    // Load production environment variables
    const { config } = require('dotenv');
    config({ path: '.env.prod' });

    // Use direct connection URL for production
    databaseUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;

    if (!databaseUrl) {
      console.error("❌ DATABASE_URL_DIRECT or DATABASE_URL not found in .env.prod");
      console.error("   Make sure .env.prod exists and contains the database URL");
      process.exit(1);
    }

    console.log("☁️  Using remote database");
  } else {
    console.error("❌ Invalid environment. Use 'local' or 'remote'");
    process.exit(1);
  }

  // Create database connection
  const db = createDb(databaseUrl);

  // Show current record counts
  console.log("\n📊 Current record counts:");
  try {
    const recipientCount = await db.$count(recipients);
    const apiKeyCount = await db.$count(apiKeys);
    const batchCount = await db.$count(batches);
    const sendConfigCount = await db.$count(sendConfigs);
    const userCount = await db.$count(users);

    console.log(`   Recipients:    ${recipientCount.toLocaleString()}`);
    console.log(`   API Keys:      ${apiKeyCount.toLocaleString()}`);
    console.log(`   Batches:       ${batchCount.toLocaleString()}`);
    console.log(`   Send Configs:  ${sendConfigCount.toLocaleString()}`);
    console.log(`   Users:         ${userCount.toLocaleString()}`);
    console.log(`   ─────────────`);
    console.log(`   Total:         ${(recipientCount + apiKeyCount + batchCount + sendConfigCount + userCount).toLocaleString()}`);

    if (recipientCount + apiKeyCount + batchCount + sendConfigCount + userCount === 0) {
      console.log("\n✅ Database is already empty!");
      process.exit(0);
    }
  } catch (error) {
    console.error("❌ Error counting records:", error);
    process.exit(1);
  }

  // Confirmation prompt
  console.log(`\n⚠️  WARNING: This will DELETE ALL DATA from the ${env} database!`);
  console.log("   This action cannot be undone.\n");

  const answer = await rl.question(`Type "${env.toUpperCase()}" to confirm: `);
  rl.close();

  if (answer !== env.toUpperCase()) {
    console.log("\n❌ Truncate cancelled");
    process.exit(1);
  }

  console.log("\n🗑️  Truncating tables...");

  try {
    // Truncate tables in order of foreign key dependencies (child tables first)
    console.log("   - Truncating recipients...");
    await db.execute(sql`TRUNCATE TABLE recipients CASCADE`);

    console.log("   - Truncating api_keys...");
    await db.execute(sql`TRUNCATE TABLE api_keys CASCADE`);

    console.log("   - Truncating batches...");
    await db.execute(sql`TRUNCATE TABLE batches CASCADE`);

    console.log("   - Truncating send_configs...");
    await db.execute(sql`TRUNCATE TABLE send_configs CASCADE`);

    console.log("   - Truncating users...");
    await db.execute(sql`TRUNCATE TABLE users CASCADE`);

    console.log("\n✅ All tables truncated successfully!");

    // Show new counts (should all be 0)
    console.log("\n📊 New record counts:");
    const newRecipientCount = await db.$count(recipients);
    const newApiKeyCount = await db.$count(apiKeys);
    const newBatchCount = await db.$count(batches);
    const newSendConfigCount = await db.$count(sendConfigs);
    const newUserCount = await db.$count(users);

    console.log(`   Recipients:    ${newRecipientCount}`);
    console.log(`   API Keys:      ${newApiKeyCount}`);
    console.log(`   Batches:       ${newBatchCount}`);
    console.log(`   Send Configs:  ${newSendConfigCount}`);
    console.log(`   Users:         ${newUserCount}`);

    console.log("\n✨ Database is now empty and ready for fresh data!");

  } catch (error) {
    console.error("\n❌ Error truncating tables:", error);
    process.exit(1);
  }

  process.exit(0);
}

// Parse command line arguments
const env = process.argv[2] || "local";

// Run truncate
truncateTables(env).catch(error => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});