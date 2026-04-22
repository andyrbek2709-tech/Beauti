import dayjs from "dayjs";
import { assertConfig } from "./config";
import { pool } from "./db";

assertConfig();

export async function scanAndNotify(): Promise<void> {
  const upcoming24h = await pool.query(
    `SELECT a.id, a.salon_id, a.start_at, a.client_name, a.client_telegram_user_id, ti.bot_token
     FROM appointments a
     JOIN telegram_integrations ti ON ti.salon_id = a.salon_id
     WHERE a.status = 'booked'
       AND a.client_telegram_user_id IS NOT NULL
       AND a.reminder_24h_sent_at IS NULL
       AND a.start_at > now() + interval '23 hours'
       AND a.start_at <= now() + interval '24 hours 10 minutes'
     LIMIT 200`
  );

  for (const row of upcoming24h.rows) {
    const when = dayjs(row.start_at).format("DD.MM HH:mm");
    const text = `Напоминание: вы записаны на ${when}.\nЕсли планы не изменились, подтвердите кнопкой ниже.`;
    const ok = await sendTelegramMessage(
      String(row.bot_token),
      Number(row.client_telegram_user_id),
      text,
      { inline_keyboard: [[{ text: "Планы в силе", callback_data: `rem:confirm:${row.id}` }]] }
    );
    if (ok) {
      await pool.query("UPDATE appointments SET reminder_24h_sent_at = now() WHERE id = $1", [row.id]);
    }
  }

  const upcoming1h = await pool.query(
    `SELECT a.id, a.salon_id, a.start_at, a.client_telegram_user_id, ti.bot_token
     FROM appointments a
     JOIN telegram_integrations ti ON ti.salon_id = a.salon_id
     WHERE a.status = 'booked'
       AND a.client_telegram_user_id IS NOT NULL
       AND a.reminder_1h_sent_at IS NULL
       AND a.start_at > now() + interval '50 minutes'
       AND a.start_at <= now() + interval '70 minutes'
     LIMIT 200`
  );
  for (const row of upcoming1h.rows) {
    const when = dayjs(row.start_at).format("DD.MM HH:mm");
    const ok = await sendTelegramMessage(
      String(row.bot_token),
      Number(row.client_telegram_user_id),
      `Напоминание: через ~1 час запись на ${when}. Подтвердите, если все в силе.`,
      { inline_keyboard: [[{ text: "Планы в силе", callback_data: `rem:confirm:${row.id}` }]] }
    );
    if (ok) {
      await pool.query("UPDATE appointments SET reminder_1h_sent_at = now() WHERE id = $1", [row.id]);
    }
  }

  const salons = await pool.query(
    `SELECT s.id as salon_id, ti.bot_token, ti.telegram_user_id
     FROM salons s
     JOIN telegram_integrations ti ON ti.salon_id = s.id`
  );
  const targetDate = dayjs().add(13, "day").format("YYYY-MM-DD");
  const todayKey = dayjs().format("YYYY-MM-DD");
  for (const salon of salons.rows) {
    const hasPattern = await pool.query(
      `SELECT 1
       FROM salon_work_patterns
       WHERE salon_id = $1
         AND is_active = true
         AND $2::date BETWEEN period_start AND period_end
       LIMIT 1`,
      [salon.salon_id, targetDate]
    );
    if (hasPattern.rowCount) continue;

    const alreadySent = await pool.query(
      `SELECT 1
       FROM audit_logs
       WHERE salon_id = $1
         AND action = 'worker_schedule_extend_reminder'
         AND payload_json->>'date' = $2
       LIMIT 1`,
      [salon.salon_id, todayKey]
    );
    if (alreadySent.rowCount) continue;

    const ok = await sendTelegramMessage(
      String(salon.bot_token),
      Number(salon.telegram_user_id),
      "Напоминание: график скоро закончится. Откройте меню мастера и нажмите «График: чет/нечет/через день»."
    );
    if (ok) {
      await pool.query(
        "INSERT INTO audit_logs (salon_id, action, payload_json) VALUES ($1,'worker_schedule_extend_reminder',$2)",
        [salon.salon_id, JSON.stringify({ date: todayKey, targetDate })]
      );
    }
  }
}

async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  inlineKeyboard?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...(inlineKeyboard ? { reply_markup: inlineKeyboard } : {}) })
    });
    if (!resp.ok) return false;
    const data: any = await resp.json();
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("worker started");
  await scanAndNotify();
  setInterval(() => {
    scanAndNotify().catch((error) => console.error("worker scan failed", error));
  }, 60_000);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
