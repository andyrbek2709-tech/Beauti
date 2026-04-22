import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { hashPassword, signAdminToken, verifyAdminToken, verifyPassword } from "./auth";
import { assertConfig, config } from "./config";
import { pool, withTx } from "./db";
import { metrics } from "./metrics";
import {
  ConflictError,
  bookAppointmentForSalon,
  cancelAppointmentForSalon,
  getAvailabilityForSalon,
  getBookingForSalon
} from "./services/bookingService";

assertConfig();
const app = express();
app.use(express.json());
app.use("/assets", express.static(path.join(process.cwd(), "public")));

app.use((req, res, next) => {
  const startedAt = Date.now();
  metrics.incCounter("http_requests_total");
  res.on("finish", () => {
    if (res.statusCode >= 400) metrics.incCounter("http_errors_total");
    const elapsedMs = Date.now() - startedAt;
    console.log(
      JSON.stringify({
        type: "http_request",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        elapsedMs
      })
    );
  });
  next();
});

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

const availabilityQuery = z.object({ salonId: z.string().min(1), from: z.string(), to: z.string() });

app.get("/availability", async (req, res) => {
  const parsed = availabilityQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(parsed.error.flatten());
  }
  const data = await getAvailabilityForSalon(parsed.data.salonId, parsed.data.from, parsed.data.to);
  res.json({ slots: data });
});

const bookBody = z.object({
  salonId: z.string().min(1),
  clientName: z.string().min(1),
  clientPhone: z.string().min(5),
  source: z.enum(["telegram", "web"]),
  requestId: z.string().min(8),
  slotStartAt: z.string().datetime()
});

app.post("/book", async (req, res) => {
  const parsed = bookBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(parsed.error.flatten());
  }
  try {
    const result = await bookAppointmentForSalon(parsed.data);
    metrics.incCounter("book_success_total");
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof ConflictError) {
      metrics.incCounter("book_conflict_total");
      return res.status(409).json({ code: "slot_unavailable" });
    }
    return res.status(400).json({ message: (error as Error).message });
  }
});

const cancelBody = z.object({
  salonId: z.string().min(1),
  appointmentId: z.string().min(6),
  requestId: z.string().min(8),
  actor: z.enum(["client", "admin"]).default("client")
});

app.post("/cancel", async (req, res) => {
  const parsed = cancelBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(parsed.error.flatten());
  }
  try {
    const result = await cancelAppointmentForSalon(parsed.data);
    metrics.incCounter("cancel_success_total");
    res.json(result);
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
});

app.get("/booking/:id", async (req, res) => {
  const salonId = String(req.query.salonId ?? "");
  if (!salonId) return res.status(400).json({ message: "salonId query required" });
  const data = await getBookingForSalon(salonId, req.params.id);
  if (!data) {
    return res.status(404).json({ message: "booking not found" });
  }
  res.json(data);
});

type AuthedRequest = express.Request & { admin?: { adminId: string; salonId: string; email: string } };
function adminOnly(req: AuthedRequest, res: express.Response, next: express.NextFunction): void {
  const auth = req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return void res.status(401).json({ message: "missing token" });
  try {
    req.admin = verifyAdminToken(auth.slice(7));
    next();
  } catch {
    res.status(401).json({ message: "invalid token" });
  }
}

function platformOwnerOnly(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.header("x-platform-key") !== config.adminApiKey) {
    res.status(403).json({ message: "forbidden" });
    return;
  }
  next();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const registerBody = z.object({
  salonName: z.string().min(2),
  salonSlug: z.string().min(2).optional(),
  email: z.string().email(),
  password: z.string().min(8)
});
app.post("/auth/register", async (req, res) => {
  const parsed = registerBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const salonId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const passwordHash = await hashPassword(parsed.data.password);
  try {
    await withTx(async (client) => {
      const salonSlug = parsed.data.salonSlug?.trim() || slugify(parsed.data.salonName);
      await client.query("INSERT INTO salons (id, name, slug) VALUES ($1,$2,$3)", [salonId, parsed.data.salonName, salonSlug]);
      await client.query("INSERT INTO admins (id, salon_id, email, password_hash) VALUES ($1,$2,$3,$4)", [
        adminId,
        salonId,
        parsed.data.email.toLowerCase(),
        passwordHash
      ]);
      await client.query(
        `INSERT INTO master_settings (salon_id, slot_duration_minutes, booking_horizon_days, cancel_cutoff_hours, timezone)
         VALUES ($1,30,14,2,$2)`,
        [salonId, config.timezone]
      );
      await client.query(
        `INSERT INTO subscriptions
          (id, salon_id, plan_code, status, trial_started_at, trial_ends_at, current_period_start, current_period_end)
         VALUES ($1,$2,'beautime-basic','trial', now(), now() + interval '14 days', now(), now() + interval '14 days')`,
        [crypto.randomUUID(), salonId]
      );
      await client.query(
        `INSERT INTO billing_events (salon_id, event_type, payload_json)
         VALUES ($1,'subscription.trial_started',$2)`,
        [salonId, JSON.stringify({ trialDays: 14, source: "register" })]
      );
    });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ message: "email already used" });
    throw error;
  }
  const token = signAdminToken({ adminId, salonId, email: parsed.data.email.toLowerCase() });
  res.status(201).json({ token, salonId, adminId });
});

const createInviteBody = z.object({
  note: z.string().max(200).optional(),
  ttlHours: z.number().int().min(1).max(168).default(72)
});
app.post("/platform/invites", platformOwnerOnly, async (req, res) => {
  const parsed = createInviteBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());
  const inviteToken = crypto.randomUUID();
  await pool.query(
    `INSERT INTO salon_invites (token, created_by, expires_at, note)
     VALUES ($1,$2, now() + ($3 || ' hours')::interval, $4)`,
    [inviteToken, "platform-owner", parsed.data.ttlHours, parsed.data.note ?? null]
  );
  res.status(201).json({
    token: inviteToken,
    inviteUrl: `/admin?invite=${inviteToken}`
  });
});

app.get("/platform/invites", platformOwnerOnly, async (_req, res) => {
  const rows = await pool.query(
    `SELECT token, expires_at, used_at, revoked_at, used_by_salon_id, note, created_at
     FROM salon_invites
     ORDER BY created_at DESC
     LIMIT 50`
  );
  const now = Date.now();
  const items = rows.rows.map((r) => {
    const used = Boolean(r.used_at);
    const revoked = Boolean(r.revoked_at);
    const expired = !used && !revoked && new Date(r.expires_at).getTime() < now;
    return {
      token: r.token,
      inviteUrl: `/admin?invite=${r.token}`,
      note: r.note,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      revokedAt: r.revoked_at,
      usedBySalonId: r.used_by_salon_id,
      status: used ? "used" : revoked ? "revoked" : expired ? "expired" : "active"
    };
  });
  res.json({ items });
});

app.post("/platform/invites/:token/revoke", platformOwnerOnly, async (req, res) => {
  const token = req.params.token;
  const result = await pool.query(
    `UPDATE salon_invites
     SET revoked_at = now()
     WHERE token = $1
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now()
     RETURNING token`,
    [token]
  );
  if (!result.rowCount) {
    return res.status(400).json({ message: "invite cannot be revoked" });
  }
  res.json({ ok: true, token });
});

app.get("/platform/stats", platformOwnerOnly, async (_req, res) => {
  const [salonsRes, subsRes, invitesRes, bookingsRes] = await Promise.all([
    pool.query(
      `SELECT
        count(*)::int as total,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int as new_last_7_days
       FROM salons`
    ),
    pool.query(
      `SELECT
        count(*) FILTER (WHERE status = 'trial')::int as trial_count,
        count(*) FILTER (WHERE status = 'active')::int as active_count,
        count(*) FILTER (WHERE status = 'past_due')::int as past_due_count,
        count(*) FILTER (WHERE status = 'canceled')::int as canceled_count
       FROM subscriptions`
    ),
    pool.query(
      `SELECT
        count(*) FILTER (WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now())::int as invites_active,
        count(*) FILTER (WHERE used_at IS NOT NULL)::int as invites_used,
        count(*) FILTER (WHERE revoked_at IS NOT NULL)::int as invites_revoked,
        count(*) FILTER (WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at <= now())::int as invites_expired
       FROM salon_invites`
    ),
    pool.query(
      `SELECT
        count(*) FILTER (WHERE status = 'booked')::int as booked_total,
        count(*) FILTER (WHERE status = 'booked' AND start_at >= now() - interval '30 days')::int as booked_last_30_days
       FROM appointments`
    )
  ]);

  res.json({
    salons: salonsRes.rows[0],
    subscriptions: subsRes.rows[0],
    invites: invitesRes.rows[0],
    bookings: bookingsRes.rows[0]
  });
});

const acceptInviteBody = z.object({
  inviteToken: z.string().uuid(),
  salonName: z.string().min(2),
  salonSlug: z.string().min(2).optional(),
  email: z.string().email(),
  password: z.string().min(8),
  telegramBotToken: z.string().min(10),
  telegramUserId: z.string().min(3)
});
app.post("/auth/accept-invite", async (req, res) => {
  const parsed = acceptInviteBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const salonId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const passwordHash = await hashPassword(parsed.data.password);
  const salonSlug = parsed.data.salonSlug?.trim() || slugify(parsed.data.salonName);

  try {
    await withTx(async (client) => {
      const invite = await client.query(
        `SELECT token, expires_at, used_at, revoked_at
         FROM salon_invites
         WHERE token = $1
         FOR UPDATE`,
        [parsed.data.inviteToken]
      );
      if (!invite.rowCount) throw new Error("invite not found");
      if (invite.rows[0].used_at) throw new Error("invite already used");
      if (invite.rows[0].revoked_at) throw new Error("invite revoked");
      if (new Date(invite.rows[0].expires_at).getTime() < Date.now()) throw new Error("invite expired");

      await client.query("INSERT INTO salons (id, name, slug) VALUES ($1,$2,$3)", [salonId, parsed.data.salonName, salonSlug]);
      await client.query("INSERT INTO admins (id, salon_id, email, password_hash) VALUES ($1,$2,$3,$4)", [
        adminId,
        salonId,
        parsed.data.email.toLowerCase(),
        passwordHash
      ]);
      await client.query(
        `INSERT INTO master_settings (salon_id, slot_duration_minutes, booking_horizon_days, cancel_cutoff_hours, timezone)
         VALUES ($1,30,14,2,$2)`,
        [salonId, config.timezone]
      );
      await client.query(
        `INSERT INTO subscriptions
          (id, salon_id, plan_code, status, trial_started_at, trial_ends_at, current_period_start, current_period_end)
         VALUES ($1,$2,'beautime-basic','trial', now(), now() + interval '14 days', now(), now() + interval '14 days')`,
        [crypto.randomUUID(), salonId]
      );
      await client.query(
        `INSERT INTO telegram_integrations (salon_id, bot_token, telegram_user_id)
         VALUES ($1,$2,$3)`,
        [salonId, parsed.data.telegramBotToken, parsed.data.telegramUserId]
      );
      await client.query(
        `INSERT INTO billing_events (salon_id, event_type, payload_json)
         VALUES ($1,'subscription.trial_started',$2)`,
        [salonId, JSON.stringify({ trialDays: 14, source: "invite" })]
      );
      await client.query("UPDATE salon_invites SET used_at = now(), used_by_salon_id = $2 WHERE token = $1", [
        parsed.data.inviteToken,
        salonId
      ]);
    });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ message: "email or salon slug already used" });
    return res.status(400).json({ message: error.message || "cannot accept invite" });
  }

  const token = signAdminToken({ adminId, salonId, email: parsed.data.email.toLowerCase() });
  res.status(201).json({ token, salonId, adminId, salonSlug });
});

const loginBody = z.object({ email: z.string().email(), password: z.string().min(8) });
app.post("/auth/login", async (req, res) => {
  const parsed = loginBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());
  const row = await pool.query("SELECT id, salon_id, email, password_hash FROM admins WHERE email = $1", [
    parsed.data.email.toLowerCase()
  ]);
  if (!row.rowCount) return res.status(401).json({ message: "invalid credentials" });
  const admin = row.rows[0];
  const ok = await verifyPassword(parsed.data.password, String(admin.password_hash));
  if (!ok) return res.status(401).json({ message: "invalid credentials" });
  const token = signAdminToken({
    adminId: String(admin.id),
    salonId: String(admin.salon_id),
    email: String(admin.email)
  });
  res.json({ token, salonId: admin.salon_id, adminId: admin.id });
});

const integrationBody = z.object({
  telegramBotToken: z.string().min(10),
  telegramUserId: z.string().min(3)
});
app.put("/admin/integration/telegram", adminOnly, async (req: AuthedRequest, res) => {
  const parsed = integrationBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());
  const webhookSecret = crypto.randomUUID();
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO telegram_integrations (salon_id, bot_token, telegram_user_id, webhook_secret)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (salon_id)
       DO UPDATE SET
         bot_token = EXCLUDED.bot_token,
         telegram_user_id = EXCLUDED.telegram_user_id,
         webhook_secret = EXCLUDED.webhook_secret,
         updated_at = now()`,
      [req.admin!.salonId, parsed.data.telegramBotToken, parsed.data.telegramUserId, webhookSecret]
    );
    await client.query(
      "INSERT INTO audit_logs (salon_id, actor_admin_id, action, payload_json) VALUES ($1,$2,'save_telegram_integration',$3)",
      [req.admin!.salonId, req.admin!.adminId, JSON.stringify({ telegramUserId: parsed.data.telegramUserId })]
    );
  });
  res.json({
    ok: true,
    webhookPath: `/telegram/webhook/${req.admin!.salonId}`,
    webhookSecret
  });
});

app.post("/admin/integration/telegram/auto-setup", adminOnly, async (req: AuthedRequest, res) => {
  const parsed = integrationBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const webhookSecret = crypto.randomUUID();
  const webhookPath = `/telegram/webhook/${req.admin!.salonId}`;
  const publicBaseUrl = req.protocol + "://" + req.get("host");
  const webhookUrl = `${publicBaseUrl}${webhookPath}`;

  try {
    const setWebhookResp = await fetch(`https://api.telegram.org/bot${parsed.data.telegramBotToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret
      })
    });
    const webhookResult: any = await setWebhookResp.json();
    if (!setWebhookResp.ok || !webhookResult.ok) {
      return res.status(400).json({
        message: "Не удалось автоматически подключить бота. Проверьте token.",
        details: webhookResult?.description ?? null
      });
    }

    await withTx(async (client) => {
      await client.query(
        `INSERT INTO telegram_integrations (salon_id, bot_token, telegram_user_id, webhook_secret)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (salon_id)
         DO UPDATE SET
           bot_token = EXCLUDED.bot_token,
           telegram_user_id = EXCLUDED.telegram_user_id,
           webhook_secret = EXCLUDED.webhook_secret,
           updated_at = now()`,
        [req.admin!.salonId, parsed.data.telegramBotToken, parsed.data.telegramUserId, webhookSecret]
      );
      await client.query(
        "INSERT INTO audit_logs (salon_id, actor_admin_id, action, payload_json) VALUES ($1,$2,'telegram_auto_setup',$3)",
        [req.admin!.salonId, req.admin!.adminId, JSON.stringify({ webhookUrl })]
      );
    });

    const salonNameRes = await pool.query("SELECT name FROM salons WHERE id = $1", [req.admin!.salonId]);
    const salonName = String(salonNameRes.rows[0]?.name ?? "Ваш салон");
    await sendTelegramMessage(
      parsed.data.telegramBotToken,
      Number(parsed.data.telegramUserId),
      `Салон "${salonName}" успешно подключен к системе Beautime. Можно настраивать график и принимать записи.`
    );

    res.json({
      ok: true,
      webhookPath,
      webhookSecret,
      webhookUrl
    });
  } catch (error: any) {
    res.status(400).json({ message: "Ошибка автонастройки Telegram", details: error?.message ?? null });
  }
});

app.get("/admin/integration/telegram/check", adminOnly, async (req: AuthedRequest, res) => {
  const row = await pool.query(
    "SELECT bot_token, telegram_user_id, webhook_secret, updated_at FROM telegram_integrations WHERE salon_id = $1",
    [req.admin!.salonId]
  );
  if (!row.rowCount) {
    return res.status(404).json({ message: "Telegram еще не подключен" });
  }
  const integration = row.rows[0];
  try {
    const meResp = await fetch(`https://api.telegram.org/bot${integration.bot_token}/getMe`);
    const meData: any = await meResp.json();
    if (!meResp.ok || !meData.ok) {
      return res.status(400).json({ message: "Token не прошел проверку" });
    }
    const hookResp = await fetch(`https://api.telegram.org/bot${integration.bot_token}/getWebhookInfo`);
    const hookData: any = await hookResp.json();
    if (!hookResp.ok || !hookData.ok) {
      return res.status(400).json({ message: "Не удалось получить webhook info" });
    }
    const expectedPath = `/telegram/webhook/${req.admin!.salonId}`;
    const expectedUrl = req.protocol + "://" + req.get("host") + expectedPath;
    res.json({
      ok: true,
      botUsername: meData.result?.username ?? null,
      telegramUserId: integration.telegram_user_id,
      configuredWebhookUrl: hookData.result?.url ?? null,
      expectedWebhookUrl: expectedUrl,
      isWebhookCorrect: hookData.result?.url === expectedUrl,
      lastErrorMessage: hookData.result?.last_error_message ?? null,
      updatedAt: integration.updated_at
    });
  } catch (error: any) {
    res.status(400).json({ message: "Ошибка проверки Telegram", details: error?.message ?? null });
  }
});

app.get("/admin/profile", adminOnly, async (req: AuthedRequest, res) => {
  const [salonRes, integrationRes, settingsRes] = await Promise.all([
    pool.query("SELECT id, name FROM salons WHERE id = $1", [req.admin!.salonId]),
    pool.query("SELECT telegram_user_id, updated_at FROM telegram_integrations WHERE salon_id = $1", [req.admin!.salonId]),
    pool.query(
      "SELECT slot_duration_minutes, booking_horizon_days, cancel_cutoff_hours, timezone FROM master_settings WHERE salon_id = $1",
      [req.admin!.salonId]
    )
  ]);
  res.json({
    admin: req.admin,
    salon: salonRes.rows[0] ?? null,
    telegramIntegration: integrationRes.rows[0] ?? null,
    settings: settingsRes.rows[0] ?? null
  });
});

app.post("/telegram/webhook/:salonId", async (req, res) => {
  metrics.incCounter("telegram_webhook_total");
  const salonId = req.params.salonId;
  const secretHeader = req.header("x-telegram-bot-api-secret-token") ?? "";
  const updateId = Number(req.body?.update_id);
  if (!Number.isFinite(updateId)) {
    return res.status(400).json({ message: "invalid update_id" });
  }

  const integration = await pool.query(
    "SELECT bot_token, telegram_user_id, webhook_secret FROM telegram_integrations WHERE salon_id = $1",
    [salonId]
  );
  if (!integration.rowCount) {
    return res.status(404).json({ message: "integration not found" });
  }
  const expectedSecret = String(integration.rows[0].webhook_secret ?? "");
  if (!expectedSecret || secretHeader !== expectedSecret) {
    return res.status(403).json({ message: "invalid webhook secret" });
  }

  const dedup = await pool.query(
    `INSERT INTO telegram_updates_processed (salon_id, update_id)
     VALUES ($1,$2)
     ON CONFLICT (salon_id, update_id) DO NOTHING
     RETURNING id`,
    [salonId, updateId]
  );
  if (!dedup.rowCount) {
    metrics.incCounter("telegram_webhook_duplicate_total");
    return res.json({ ok: true, duplicate: true });
  }

  await pool.query(
    "INSERT INTO audit_logs (salon_id, action, payload_json) VALUES ($1,'telegram_update_received',$2)",
    [salonId, JSON.stringify({ updateId })]
  );

  const botToken = String(integration.rows[0].bot_token ?? "");
  const adminTelegramUserId = String(integration.rows[0].telegram_user_id ?? "");
  const message = req.body?.message;
  if (message?.chat?.id && message?.from?.id) {
    const chatId = Number(message.chat.id);
    const fromId = String(message.from.id);
    const text = String(message.text ?? "").trim();

    const salonRes = await pool.query("SELECT name, slug FROM salons WHERE id = $1", [salonId]);
    const salonName = String(salonRes.rows[0]?.name ?? "Ваш салон");
    const salonSlug = String(salonRes.rows[0]?.slug ?? "");
    const baseUrl = req.protocol + "://" + req.get("host");
    const bookingUrl = `${baseUrl}/?salonId=${encodeURIComponent(salonId)}${salonSlug ? `&salon=${encodeURIComponent(salonSlug)}` : ""}`;

    if (fromId === adminTelegramUserId) {
      if (text === "/start" || text === "/help") {
        await sendTelegramMessage(botToken, chatId, [
          `Здравствуйте! Это бот салона "${salonName}".`,
          "",
          "Команды:",
          "/today - записи на сегодня",
          "/status - статус подключения",
          "/link - ссылка для клиентов"
        ].join("\n"));
      } else if (text === "/status") {
        await sendTelegramMessage(botToken, chatId, "Подключение активно. Бот работает корректно.");
      } else if (text === "/link") {
        await sendTelegramMessage(botToken, chatId, `Ссылка на запись для клиентов:\n${bookingUrl}`);
      } else if (text === "/today") {
        const todayRes = await pool.query(
          `SELECT client_name, client_phone, start_at
           FROM appointments
           WHERE salon_id = $1
             AND status = 'booked'
             AND date(start_at at time zone 'UTC') = current_date
           ORDER BY start_at ASC
           LIMIT 20`,
          [salonId]
        );
        if (!todayRes.rowCount) {
          await sendTelegramMessage(botToken, chatId, "На сегодня записей нет.");
        } else {
          const lines = todayRes.rows.map((r: any) => {
            const hhmm = new Date(r.start_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
            return `${hhmm} - ${r.client_name} (${r.client_phone})`;
          });
          await sendTelegramMessage(botToken, chatId, `Записи на сегодня (${todayRes.rowCount}):\n` + lines.join("\n"));
        }
      } else {
        await sendTelegramMessage(botToken, chatId, "Не понял команду. Наберите /help");
      }
    } else {
      if (text === "/start" || text.toLowerCase().includes("запис")) {
        await sendTelegramMessage(
          botToken,
          chatId,
          `Здравствуйте! Для записи в "${salonName}" откройте ссылку:\n${bookingUrl}`
        );
      } else {
        await sendTelegramMessage(
          botToken,
          chatId,
          `Напишите "записаться" или откройте ссылку:\n${bookingUrl}`
        );
      }
    }
  }
  res.json({ ok: true, duplicate: false });
});

app.get("/metrics", async (_req, res) => {
  const metricsSnapshot = metrics.snapshotCounters();
  const dbPing = await pool.query("SELECT 1 as ok");
  res.json({
    counters: metricsSnapshot,
    db: dbPing.rows[0]?.ok === 1 ? "ok" : "unknown",
    now: new Date().toISOString()
  });
});

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch {
    // Ignore send errors to keep webhook idempotent and fast.
  }
}

async function notifySalonAdmin(salonId: string, text: string): Promise<void> {
  try {
    const row = await pool.query(
      "SELECT bot_token, telegram_user_id FROM telegram_integrations WHERE salon_id = $1",
      [salonId]
    );
    if (!row.rowCount) return;
    const botToken = String(row.rows[0].bot_token ?? "");
    const telegramUserId = Number(row.rows[0].telegram_user_id);
    if (!botToken || !Number.isFinite(telegramUserId)) return;
    await sendTelegramMessage(botToken, telegramUserId, text);
  } catch {
    // Ignore notification errors.
  }
}

const adminSettingsBody = z.object({
  slotDurationMinutes: z.union([z.literal(30), z.literal(45), z.literal(60)]),
  bookingHorizonDays: z.number().int().min(1).max(30),
  cancelCutoffHours: z.number().int().min(0).max(48),
  timezone: z.string().min(1)
});

app.put("/admin/settings", adminOnly, async (req: AuthedRequest, res) => {
  const parsed = adminSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(parsed.error.flatten());
  }
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO master_settings (salon_id, slot_duration_minutes, booking_horizon_days, cancel_cutoff_hours, timezone)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (salon_id) DO UPDATE
       SET slot_duration_minutes = EXCLUDED.slot_duration_minutes,
           booking_horizon_days = EXCLUDED.booking_horizon_days,
           cancel_cutoff_hours = EXCLUDED.cancel_cutoff_hours,
           timezone = EXCLUDED.timezone`,
      [
        req.admin!.salonId,
        parsed.data.slotDurationMinutes,
        parsed.data.bookingHorizonDays,
        parsed.data.cancelCutoffHours,
        parsed.data.timezone
      ]
    );
    await client.query(
      "INSERT INTO audit_logs (salon_id, actor_admin_id, action, payload_json) VALUES ($1,$2,'update_settings',$3)",
      [req.admin!.salonId, req.admin!.adminId, JSON.stringify(parsed.data)]
    );
  });
  await notifySalonAdmin(req.admin!.salonId, "Настройки применены: длительность слота, горизонт и таймзона обновлены.");
  res.json({ ok: true });
});

const workingRulesBody = z.object({
  rules: z.array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      startMinute: z.number().int().min(0).max(1439),
      endMinute: z.number().int().min(1).max(1440),
      isActive: z.boolean().default(true)
    })
  )
});

app.put("/admin/working-rules", adminOnly, async (req: AuthedRequest, res) => {
  const parsed = workingRulesBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(parsed.error.flatten());
  }
  await withTx(async (client) => {
    await client.query("DELETE FROM working_rules WHERE salon_id = $1", [req.admin!.salonId]);
    for (const rule of parsed.data.rules) {
      await client.query(
        `INSERT INTO working_rules (salon_id, weekday, start_minute, end_minute, is_active)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.admin!.salonId, rule.weekday, rule.startMinute, rule.endMinute, rule.isActive]
      );
    }
    await client.query(
      "INSERT INTO audit_logs (salon_id, actor_admin_id, action, payload_json) VALUES ($1,$2,'update_working_rules',$3)",
      [req.admin!.salonId, req.admin!.adminId, JSON.stringify(parsed.data.rules)]
    );
  });
  await notifySalonAdmin(req.admin!.salonId, "Настройки применены: рабочее расписание обновлено.");
  res.json({ ok: true });
});

const exceptionsBody = z.object({
  exceptions: z.array(
    z.object({
      date: z.string(),
      isClosed: z.boolean(),
      customStartMinute: z.number().int().min(0).max(1439).nullable().default(null),
      customEndMinute: z.number().int().min(1).max(1440).nullable().default(null)
    })
  )
});

app.put("/admin/exceptions", adminOnly, async (req: AuthedRequest, res) => {
  const parsed = exceptionsBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(parsed.error.flatten());
  }
  await withTx(async (client) => {
    await client.query("DELETE FROM schedule_exceptions WHERE salon_id = $1", [req.admin!.salonId]);
    for (const ex of parsed.data.exceptions) {
      await client.query(
        `INSERT INTO schedule_exceptions (salon_id, date, is_closed, custom_start_minute, custom_end_minute)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.admin!.salonId, ex.date, ex.isClosed, ex.customStartMinute, ex.customEndMinute]
      );
    }
    await client.query(
      "INSERT INTO audit_logs (salon_id, actor_admin_id, action, payload_json) VALUES ($1,$2,'update_exceptions',$3)",
      [req.admin!.salonId, req.admin!.adminId, JSON.stringify(parsed.data.exceptions)]
    );
  });
  await notifySalonAdmin(req.admin!.salonId, "Настройки применены: исключения по датам обновлены.");
  res.json({ ok: true });
});

app.get("/admin/appointments", adminOnly, async (req: AuthedRequest, res) => {
  const date = String(req.query.date ?? "");
  if (!date) {
    return res.status(400).json({ message: "date query required" });
  }
  const result = await pool.query(
    `SELECT id, client_name, client_phone, source, status, start_at, end_at
     FROM appointments
     WHERE salon_id = $1 AND date(start_at at time zone 'UTC') = $2::date
     ORDER BY start_at ASC`,
    [req.admin!.salonId, date]
  );
  res.json({ count: result.rowCount, items: result.rows });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "admin.html"));
});

app.get("/owner", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "owner.html"));
});

app.listen(config.port, () => {
  console.log(`booking-api started on port ${config.port}`);
});
