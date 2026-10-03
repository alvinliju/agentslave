import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";

const migrationPath = join(dirname(fileURLToPath(import.meta.url)), "../migrations/001_initial.sql");
const sql = await readFile(migrationPath, "utf8");
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  await pool.query(sql);
  console.log("Applied 001_initial.sql");
} finally {
  await pool.end();
}
