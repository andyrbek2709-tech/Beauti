import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertConfig } from "../config";
import { pool } from "../db";

async function main(): Promise<void> {
  assertConfig();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`
  );
  const dir = join(process.cwd(), "src", "migrations");
  const files = readdirSync(dir).filter((x) => x.endsWith(".sql")).sort();
  for (const file of files) {
    const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (exists.rowCount) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      console.log(`applied: ${file}`);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
  console.log("migrations applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
