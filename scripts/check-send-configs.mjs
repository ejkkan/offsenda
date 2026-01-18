import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const result = await pool.query("SELECT id, name, module, is_default FROM send_configs WHERE user_id = 'eddfd3b7-33af-4ca8-829b-a4e96bdeaab1'");
console.log('Send configs:', result.rows);
await pool.end();
