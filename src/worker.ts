import dayjs from "dayjs";
import { assertConfig } from "./config";
import { pool } from "./db";

assertConfig();

async function scanAndNotify(): Promise<void> {
  const tomorrow = dayjs().add(1, "day").format("YYYY-MM-DD");
  const salons = await pool.query("SELECT id FROM salons");
  for (const salon of salons.rows) {
    const salonId = String(salon.id);
    const countRes = await pool.query(
      `SELECT count(*)::int as cnt
       FROM appointments
       WHERE salon_id = $1
         AND status = 'booked'
         AND date(start_at at time zone 'UTC') = $2::date`,
      [salonId, tomorrow]
    );
    const booked = Number(countRes.rows[0]?.cnt ?? 0);
    await pool.query(
      "INSERT INTO audit_logs (salon_id, action, payload_json) VALUES ($1,'worker_daily_summary',$2)",
      [salonId, JSON.stringify({ date: tomorrow, booked })]
    );
  }
}

async function main(): Promise<void> {
  console.log("worker started");
  await scanAndNotify();
  setInterval(() => {
    scanAndNotify().catch((error) => console.error("worker scan failed", error));
  }, 60_000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
