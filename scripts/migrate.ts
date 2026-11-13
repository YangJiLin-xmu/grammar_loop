import { readFile } from "node:fs/promises";
import pg from "pg";
if (!process.env.DATABASE_URL) throw new Error("请先在 .env.local 配置 DATABASE_URL。");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("begin");
  await client.query(await readFile("supabase/migrations/001_initial.sql", "utf8"));
  await client.query("commit");
  console.log("Grammar Loop migration completed.");
} catch (error) { await client.query("rollback"); throw error; }
finally { await client.end(); }
