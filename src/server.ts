import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import dayjs from "dayjs";
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
import { scanAndNotify } from "./worker";

assertConfig();
const app = express();
app.set("trust proxy", true);
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
function getPublicBaseUrl(req: express.Request): string {
  const forwardedProtoRaw = String(req.header("x-forwarded-proto") ?? "");
  const forwardedProto = forwardedProtoRaw.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol || "https";
  const host = req.get("host") || "";
  return `${protocol}://${host}`;
}

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
         VALUES ($1,60,30,2,$2)`,
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

app.get("/platform/salons", platformOwnerOnly, async (_req, res) => {
  const rows = await pool.query(
    `SELECT
       s.id,
       s.name,
       s.slug,
       s.created_at,
       a.email as admin_email,
       sub.status as subscription_status
     FROM salons s
     LEFT JOIN LATERAL (
       SELECT email FROM admins WHERE salon_id = s.id ORDER BY created_at ASC LIMIT 1
     ) a ON true
     LEFT JOIN subscriptions sub ON sub.salon_id = s.id
     ORDER BY s.created_at DESC
     LIMIT 200`
  );
  res.json({ items: rows.rows });
});

app.delete("/platform/salons/:salonId", platformOwnerOnly, async (req, res) => {
  const salonId = req.params.salonId;
  const result = await pool.query("DELETE FROM salons WHERE id = $1 RETURNING id, name", [salonId]);
  if (!result.rowCount) {
    return res.status(404).json({ message: "salon not found" });
  }
  res.json({ ok: true, deleted: result.rows[0] });
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
         VALUES ($1,60,30,2,$2)`,
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
  await sendTelegramMessage(
    parsed.data.telegramBotToken,
    Number(parsed.data.telegramUserId),
    `Регистрация салона "${parsed.data.salonName}" завершена.\nEmail: ${parsed.data.email.toLowerCase()}\nТеперь нажмите "Подключить бота автоматически", чтобы включить уведомления и прием записей.`
  );
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

const passwordResetStartBody = z.object({
  email: z.string().email(),
  telegramBotToken: z.string().min(10)
});

app.post("/auth/password-reset/telegram/start", async (req, res) => {
  const parsed = passwordResetStartBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const pair = await pool.query(
    `SELECT a.id as admin_id, ti.telegram_user_id
     FROM admins a
     JOIN telegram_integrations ti ON ti.salon_id = a.salon_id
     WHERE a.email = $1 AND ti.bot_token = $2
     LIMIT 1`,
    [parsed.data.email.toLowerCase(), parsed.data.telegramBotToken]
  );
  if (!pair.rowCount) {
    return res.status(400).json({ message: "email и telegram token не совпадают" });
  }

  const adminId = String(pair.rows[0].admin_id);
  const telegramUserId = Number(pair.rows[0].telegram_user_id);
  if (!Number.isFinite(telegramUserId)) {
    return res.status(400).json({ message: "telegram user id не настроен" });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await withTx(async (client) => {
    await client.query("DELETE FROM password_reset_codes WHERE admin_id = $1 AND used_at IS NULL", [adminId]);
    await client.query(
      `INSERT INTO password_reset_codes (id, admin_id, reset_code, expires_at)
       VALUES ($1,$2,$3, now() + interval '15 minutes')`,
      [crypto.randomUUID(), adminId, code]
    );
  });

  await sendTelegramMessage(
    parsed.data.telegramBotToken,
    telegramUserId,
    `Код для восстановления пароля Beautime: ${code}\nКод действует 15 минут.`
  );
  res.json({ ok: true, message: "Код отправлен в Telegram" });
});

const passwordResetConfirmBody = z.object({
  email: z.string().email(),
  telegramBotToken: z.string().min(10),
  code: z.string().regex(/^\d{6}$/),
  newPassword: z.string().min(8)
});

app.post("/auth/password-reset/telegram/confirm", async (req, res) => {
  const parsed = passwordResetConfirmBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const pair = await pool.query(
    `SELECT a.id as admin_id
     FROM admins a
     JOIN telegram_integrations ti ON ti.salon_id = a.salon_id
     WHERE a.email = $1 AND ti.bot_token = $2
     LIMIT 1`,
    [parsed.data.email.toLowerCase(), parsed.data.telegramBotToken]
  );
  if (!pair.rowCount) {
    return res.status(400).json({ message: "email и telegram token не совпадают" });
  }

  const adminId = String(pair.rows[0].admin_id);
  const newPasswordHash = await hashPassword(parsed.data.newPassword);
  const updated = await withTx(async (client) => {
    const codeRow = await client.query(
      `SELECT id
       FROM password_reset_codes
       WHERE admin_id = $1
         AND reset_code = $2
         AND used_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [adminId, parsed.data.code]
    );
    if (!codeRow.rowCount) return false;

    const codeId = String(codeRow.rows[0].id);
    await client.query("UPDATE admins SET password_hash = $1 WHERE id = $2", [newPasswordHash, adminId]);
    await client.query("UPDATE password_reset_codes SET used_at = now() WHERE id = $1", [codeId]);
    return true;
  });

  if (!updated) {
    return res.status(400).json({ message: "код неверный или истек" });
  }
  res.json({ ok: true, message: "Пароль обновлен" });
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
  const publicBaseUrl = getPublicBaseUrl(req);
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
    const expectedUrl = `${getPublicBaseUrl(req)}${expectedPath}`;
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
  const salonRes = await pool.query("SELECT name, slug FROM salons WHERE id = $1", [salonId]);
  const salonName = String(salonRes.rows[0]?.name ?? "Ваш салон");
  const salonSlug = String(salonRes.rows[0]?.slug ?? "");
  const baseUrl = getPublicBaseUrl(req);
  const bookingUrl = `${baseUrl}/?salonId=${encodeURIComponent(salonId)}${salonSlug ? `&salon=${encodeURIComponent(salonSlug)}` : ""}`;

  const settingsRow = await pool.query(
    "SELECT booking_horizon_days, timezone FROM master_settings WHERE salon_id = $1",
    [salonId]
  );
  const salonTimezone = String(settingsRow.rows[0]?.timezone ?? config.timezone);
  const horizonDays = Number(settingsRow.rows[0]?.booking_horizon_days ?? 30);

  const renderDateChoices = async (chatId: number) => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000).toISOString();
    const slots = (await getAvailabilityForSalon(salonId, from, to)).filter((s) => s.available);
    if (!slots.length) {
      await sendTelegramMessage(botToken, chatId, "Свободных слотов пока нет.");
      return;
    }
    const dates = new Map<string, string>();
    for (const slot of slots) {
      const dateKey = new Intl.DateTimeFormat("en-CA", {
        timeZone: salonTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date(slot.startAt));
      if (!dates.has(dateKey)) {
        const label = new Intl.DateTimeFormat("ru-RU", {
          timeZone: salonTimezone,
          weekday: "short",
          day: "2-digit",
          month: "2-digit"
        }).format(new Date(slot.startAt));
        dates.set(dateKey, label);
      }
    }
    const buttons = Array.from(dates.entries())
      .slice(0, 30)
      .map(([key, label]) => ({ text: label, callback_data: `bk:date:${key}` }));
    await sendTelegramMessage(botToken, chatId, "Выберите дату:", {
      reply_markup: { inline_keyboard: chunkButtons(buttons, 2) }
    });
  };

  const renderTimeChoices = async (chatId: number, dateKey: string) => {
    const from = `${dateKey}T00:00:00.000Z`;
    const to = `${dateKey}T23:59:59.999Z`;
    const slots = (await getAvailabilityForSalon(salonId, from, to)).filter((s) => s.available);
    if (!slots.length) {
      await sendTelegramMessage(botToken, chatId, "На эту дату свободных слотов нет. Выберите другую дату.");
      await renderDateChoices(chatId);
      return;
    }
    const buttons = slots.slice(0, 24).map((slot) => ({
      text: new Intl.DateTimeFormat("ru-RU", { timeZone: salonTimezone, hour: "2-digit", minute: "2-digit" }).format(
        new Date(slot.startAt)
      ),
      callback_data: `bk:slot:${new Date(slot.startAt).getTime()}`
    }));
    await sendTelegramMessage(botToken, chatId, `Дата ${dateKey}. Выберите время:`, {
      reply_markup: { inline_keyboard: chunkButtons(buttons, 3) }
    });
  };

  const dateKeyByOffset = (offsetDays: number): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: salonTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));

  const adminMenuKeyboard = () => ({
    inline_keyboard: [
      [{ text: "📋 Записи", callback_data: "adm:section:bookings" }],
      [{ text: "🗓 График", callback_data: "adm:section:schedule" }],
      [{ text: "⚙️ Настройки", callback_data: "adm:section:settings" }],
      [{ text: "❓ Помощь", callback_data: "adm:section:help" }]
    ]
  });

  const scheduleMenuKeyboard = () => ({
    inline_keyboard: [
      [{ text: "Рабочие дни", callback_data: "adm:workdays" }],
      [{ text: "Рабочее время", callback_data: "adm:worktime" }],
      [{ text: "Длительность записи", callback_data: "adm:duration" }],
      [{ text: "Назад", callback_data: "adm:menu" }]
    ]
  });

  const settingsMenuKeyboard = () => ({
    inline_keyboard: [
      [{ text: "Закрыть даты", callback_data: "adm:close-dates" }],
      [{ text: "Сообщение клиентам", callback_data: "adm:broadcast:start" }],
      [{ text: "Очистить график", callback_data: "adm:clear-schedule:start" }],
      [{ text: "Назад", callback_data: "adm:menu" }]
    ]
  });

  const getMonthRange = (monthMode: "current" | "next"): { start: string; end: string; label: string } => {
    const base = dayjs().tz(salonTimezone).startOf("month").add(monthMode === "next" ? 1 : 0, "month");
    return {
      start: base.format("YYYY-MM-DD"),
      end: base.endOf("month").format("YYYY-MM-DD"),
      label: base.format("MM.YYYY")
    };
  };

  const saveScheduleActionState = async (
    adminTelegramUserId: string,
    payload: Record<string, unknown>
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO telegram_admin_actions (salon_id, admin_telegram_user_id, action_type, payload_json, updated_at)
       VALUES ($1,$2,'schedule_setup',$3,now())
       ON CONFLICT (salon_id, admin_telegram_user_id)
       DO UPDATE SET action_type='schedule_setup', payload_json=EXCLUDED.payload_json, updated_at=now()`,
      [salonId, adminTelegramUserId, JSON.stringify(payload)]
    );
  };

  const showScheduleMonthPicker = async (chatId: number) => {
    await sendTelegramMessage(botToken, chatId, "Выберите месяц для шаблона графика:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Этот месяц", callback_data: "adm:sch:month:current" },
            { text: "Следующий месяц", callback_data: "adm:sch:month:next" }
          ],
          [{ text: "Назад к меню", callback_data: "adm:menu" }]
        ]
      }
    });
  };

  const pauseDateButtons = (prefix: "adm:pause:start:" | "adm:pause:end:", fromOffsetDays = 0, count = 21) => {
    const items = Array.from({ length: count }, (_, i) => {
      const offset = fromOffsetDays + i;
      const key = dateKeyByOffset(offset);
      const label = new Intl.DateTimeFormat("ru-RU", {
        timeZone: salonTimezone,
        weekday: "short",
        day: "2-digit",
        month: "2-digit"
      }).format(new Date(`${key}T12:00:00.000Z`));
      return { text: label, callback_data: `${prefix}${key}` };
    });
    return chunkButtons(items, 2);
  };

  const countBookingsInRange = async (start: string, end: string): Promise<number> => {
    const c = await pool.query(
      `SELECT count(*)::int as cnt
       FROM appointments
       WHERE salon_id = $1
         AND status = 'booked'
         AND start_at >= $2::timestamptz
         AND start_at <= $3::timestamptz`,
      [salonId, `${start}T00:00:00.000Z`, `${end}T23:59:59.999Z`]
    );
    return Number(c.rows[0]?.cnt ?? 0);
  };

  const setPauseOnly = async (start: string, end: string) => {
    await pool.query("UPDATE booking_pauses SET is_active = false, updated_at = now() WHERE salon_id = $1 AND is_active = true", [salonId]);
    await pool.query(
      `INSERT INTO booking_pauses (salon_id, start_date, end_date, reason, is_active, updated_at)
       VALUES ($1,$2::date,$3::date,$4,true,now())`,
      [salonId, start, end, "admin_button_pause_range"]
    );
  };

  const cancelBookingsInRangeWithMessage = async (start: string, end: string, messageForClients: string): Promise<number> => {
    const affected = await pool.query(
      `SELECT id, client_telegram_user_id, client_name, start_at
       FROM appointments
       WHERE salon_id = $1
         AND status = 'booked'
         AND start_at >= $2::timestamptz
         AND start_at <= $3::timestamptz
       ORDER BY start_at ASC`,
      [salonId, `${start}T00:00:00.000Z`, `${end}T23:59:59.999Z`]
    );
    let cancelled = 0;
    for (const appt of affected.rows) {
      try {
        await cancelAppointmentForSalon({
          salonId,
          appointmentId: String(appt.id),
          requestId: `pause-cancel-${salonId}-${appt.id}`,
          actor: "admin"
        });
        cancelled += 1;
        const clientTelegramId = Number(appt.client_telegram_user_id);
        if (Number.isFinite(clientTelegramId)) {
          const when = new Intl.DateTimeFormat("ru-RU", {
            timeZone: salonTimezone,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(String(appt.start_at)));
          await sendTelegramMessage(
            botToken,
            clientTelegramId,
            `Ваша запись на ${when} отменена.\n${messageForClients}\nНапишите "записаться", чтобы выбрать новое время.`
          );
        }
      } catch {
        // Continue cancelling the rest.
      }
    }
    return cancelled;
  };

  const renderBookingsHome = async (chatId: number) => {
    const today = dateKeyByOffset(0);
    const tomorrow = dateKeyByOffset(1);
    const weekDays = Array.from({ length: 7 }, (_, i) => dateKeyByOffset(i));
    const [todayCountRes, nearestRes] = await Promise.all([
      pool.query(
        `SELECT count(*)::int as cnt
         FROM appointments
         WHERE salon_id = $1
           AND status = 'booked'
           AND start_at >= $2::timestamptz
           AND start_at <= $3::timestamptz`,
        [salonId, `${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`]
      ),
      pool.query(
        `SELECT id, client_name, start_at
         FROM appointments
         WHERE salon_id = $1
           AND status = 'booked'
           AND start_at >= now()
         ORDER BY start_at ASC
         LIMIT 1`,
        [salonId]
      )
    ]);

    const dayButtons: Array<{ text: string; callback_data: string }> = [];
    for (const d of weekDays) {
      const cntRes = await pool.query(
        `SELECT count(*)::int as cnt
         FROM appointments
         WHERE salon_id = $1
           AND status = 'booked'
           AND start_at >= $2::timestamptz
           AND start_at <= $3::timestamptz`,
        [salonId, `${d}T00:00:00.000Z`, `${d}T23:59:59.999Z`]
      );
      const cnt = Number(cntRes.rows[0]?.cnt ?? 0);
      const shortDay = new Intl.DateTimeFormat("ru-RU", { timeZone: salonTimezone, weekday: "short" })
        .format(new Date(`${d}T12:00:00.000Z`))
        .replace(".", "");
      dayButtons.push({
        text: `${shortDay[0]?.toUpperCase() ?? shortDay}${shortDay.slice(1)} (${cnt})`,
        callback_data: `adm:day:${d}`
      });
    }
    const todayCount = Number(todayCountRes.rows[0]?.cnt ?? 0);
    const nearest = nearestRes.rowCount ? nearestRes.rows[0] : null;
    const nearestLine = nearest
      ? `${new Intl.DateTimeFormat("ru-RU", {
          timeZone: salonTimezone,
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        }).format(new Date(String(nearest.start_at)))} - ${nearest.client_name}`
      : "нет ближайшей записи";
    const keyboardRows: Array<Array<{ text: string; callback_data: string }>> = [];
    keyboardRows.push([{ text: "Сегодня", callback_data: `adm:day:${today}` }, { text: "Завтра", callback_data: `adm:day:${tomorrow}` }]);
    keyboardRows.push(...chunkButtons(dayButtons, 2));
    keyboardRows.push([{ text: "Следующие 30 дней", callback_data: "adm:days" }]);
    keyboardRows.push([{ text: "Главное меню", callback_data: "adm:menu" }]);
    await sendTelegramMessage(
      botToken,
      chatId,
      `Записи\nСегодня: ${todayCount}\nБлижайшая: ${nearestLine}\n\nЗагрузка по дням:`,
      { reply_markup: { inline_keyboard: keyboardRows } }
    );
  };

  const renderAdminDay = async (chatId: number, dateKey: string) => {
    const from = `${dateKey}T00:00:00.000Z`;
    const to = `${dateKey}T23:59:59.999Z`;
    const [slots, apptRes] = await Promise.all([
      getAvailabilityForSalon(salonId, from, to),
      pool.query(
        `SELECT id, client_name, client_phone, start_at, is_admin_block
         FROM appointments
         WHERE salon_id = $1
           AND status = 'booked'
           AND start_at >= $2::timestamptz
           AND start_at <= $3::timestamptz
         ORDER BY start_at ASC`,
        [salonId, from, to]
      )
    ]);
    const bookedByStart = new Map<string, any>();
    for (const a of apptRes.rows) bookedByStart.set(new Date(a.start_at).toISOString(), a);

    const buttons: Array<{ text: string; callback_data: string }> = [];
    for (const slot of slots) {
      const time = new Intl.DateTimeFormat("ru-RU", { timeZone: salonTimezone, hour: "2-digit", minute: "2-digit" }).format(
        new Date(slot.startAt)
      );
      const booked = bookedByStart.get(slot.startAt);
      if (booked) {
        if (Boolean(booked.is_admin_block)) {
          buttons.push({ text: `${time} • 🔒`, callback_data: `adm:appt:${booked.id}` });
        } else {
          buttons.push({ text: `${time} • 👤`, callback_data: `adm:appt:${booked.id}` });
        }
      } else {
        const slotMs = new Date(slot.startAt).getTime();
        buttons.push({ text: `${time}`, callback_data: `adm:block:start:${slotMs}` });
      }
    }
    if (!buttons.length) {
      await sendTelegramMessage(botToken, chatId, `На ${dateKey} рабочие слоты не настроены.`, {
        reply_markup: { inline_keyboard: [[{ text: "Назад к записям", callback_data: "adm:section:bookings" }]] }
      });
      return;
    }
    const keyboardRows = chunkButtons(buttons.slice(0, 30), 2);
    keyboardRows.push([{ text: "Назад к записям", callback_data: "adm:section:bookings" }]);
    await sendTelegramMessage(
      botToken,
      chatId,
      `Записи на ${dateKey}\n👤 — клиент  🔒 — закрыт  (пусто) — свободно`,
      { reply_markup: { inline_keyboard: keyboardRows } }
    );
  };

  const renderHelp = async (chatId: number) => {
    await sendTelegramMessage(
      botToken,
      chatId,
      [
        "Этот бот помогает вам быстро управлять записями клиентов.",
        "",
        "Как смотреть записи",
        "Откройте раздел «Записи», выберите день и нажмите нужное время. Слот с клиентом отмечен значком 👤.",
        "",
        "Как отменить запись",
        "Откройте занятый слот, нажмите «Отменить запись» и отправьте причину (или «-» без причины).",
        "",
        "Как настроить график",
        "Раздел «График»: там вы меняете рабочие дни, рабочее время и длительность записи.",
        "",
        "Как закрыть даты",
        "Раздел «Настройки» → «Закрыть даты». Выберите сегодня, завтра или нужные даты вручную.",
        "",
        "Сообщения клиентам",
        "Раздел «Настройки» → «Сообщение клиентам». Введите текст и отправьте всем клиентам.",
        "",
        "Как очистить график",
        "Если нужно начать заново, откройте «Настройки» → «Очистить график».",
        "Это удалит рабочие дни, время и закрытые даты. После этого задайте новый график.",
        "",
        "Если не уверены — смело нажимайте кнопки. Все шаги простые и понятные."
      ].join("\n"),
      { reply_markup: adminMenuKeyboard() }
    );
  };

  const showFirstRunHelpIfNeeded = async (chatId: number, adminTgUserId: string): Promise<void> => {
    const seen = await pool.query(
      `SELECT 1
       FROM audit_logs
       WHERE salon_id = $1
         AND action = 'admin_help_seen'
         AND payload_json->>'adminTelegramUserId' = $2
       LIMIT 1`,
      [salonId, adminTgUserId]
    );
    if (seen.rowCount) return;

    await renderHelp(chatId);
    await pool.query(
      "INSERT INTO audit_logs (salon_id, action, payload_json) VALUES ($1,'admin_help_seen',$2)",
      [salonId, JSON.stringify({ adminTelegramUserId: adminTgUserId, shownAt: new Date().toISOString() })]
    );
  };

  const renderAdmin30Days = async (chatId: number) => {
    const days = Array.from({ length: 30 }, (_, i) => dateKeyByOffset(i));
    const buttons: Array<{ text: string; callback_data: string }> = [];
    for (const d of days) {
      const countRes = await pool.query(
        `SELECT count(*)::int as cnt
         FROM appointments
         WHERE salon_id = $1
           AND status = 'booked'
           AND start_at >= $2::timestamptz
           AND start_at <= $3::timestamptz`,
        [salonId, `${d}T00:00:00.000Z`, `${d}T23:59:59.999Z`]
      );
      const cnt = Number(countRes.rows[0]?.cnt ?? 0);
      const label = new Intl.DateTimeFormat("ru-RU", {
        timeZone: salonTimezone,
        weekday: "short",
        day: "2-digit",
        month: "2-digit"
      }).format(new Date(`${d}T12:00:00.000Z`));
      buttons.push({ text: `${label} (${cnt})`, callback_data: `adm:day:${d}` });
    }
    const rows = chunkButtons(buttons, 2);
    rows.push([{ text: "Назад к записям", callback_data: "adm:section:bookings" }]);
    await sendTelegramMessage(botToken, chatId, "Выберите день для просмотра записей:", {
      reply_markup: { inline_keyboard: rows }
    });
  };

  const message = req.body?.message;
  if (message?.chat?.id && message?.from?.id) {
    const chatId = Number(message.chat.id);
    const fromId = String(message.from.id);
    const text = String(message.text ?? "").trim();
    const contactPhone = message.contact?.phone_number ? normalizeRuPhone(String(message.contact.phone_number)) : null;
    if (fromId !== adminTelegramUserId) {
      if (message.contact?.phone_number && !contactPhone) {
        await sendTelegramMessage(
          botToken,
          chatId,
          "Номер введен с ошибкой, повторите. Формат: 8XXXXXXXXXX или +7XXXXXXXXXX."
        );
      }
      await upsertTelegramClientProfile(salonId, message.from, contactPhone);
      if (contactPhone) {
        await sendTelegramMessage(botToken, chatId, "Телефон сохранен. Теперь можно записываться.", {
          reply_markup: { remove_keyboard: true }
        });
      }
    }

    if (fromId === adminTelegramUserId) {
      const pendingActionRes = await pool.query(
        "SELECT action_type, payload_json FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2",
        [salonId, fromId]
      );
      const pendingAction = pendingActionRes.rowCount ? pendingActionRes.rows[0] : null;
      if (pendingAction?.action_type === "pause_cancel_text" && !text.startsWith("/")) {
        const reason = text.trim();
        const start = String(pendingAction.payload_json?.startDate ?? "");
        const end = String(pendingAction.payload_json?.endDate ?? "");
        if (!start || !end) {
          await sendTelegramMessage(botToken, chatId, "Не найден период паузы. Повторите выбор.");
        } else {
          await setPauseOnly(start, end);
          const cancelled = await cancelBookingsInRangeWithMessage(start, end, reason);
          await sendTelegramMessage(
            botToken,
            chatId,
            `Пауза установлена: ${start} - ${end}.\nОтменено записей: ${cancelled}.`,
            { reply_markup: adminMenuKeyboard() }
          );
        }
        await pool.query("DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2", [
          salonId,
          fromId
        ]);
        return res.json({ ok: true, duplicate: false });
      } else if (pendingAction?.action_type === "cancel_reason" && !text.startsWith("/")) {
        const appointmentId = String(pendingAction.payload_json?.appointmentId ?? "");
        const reasonRaw = text.trim();
        const reason = reasonRaw === "-" ? "" : reasonRaw;
        if (!appointmentId) {
          await pool.query("DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2", [
            salonId,
            fromId
          ]);
        } else {
          const row = await pool.query(
            `SELECT id, client_name, client_telegram_user_id, start_at
             FROM appointments
             WHERE id = $1 AND salon_id = $2 AND status = 'booked'
             LIMIT 1`,
            [appointmentId, salonId]
          );
          if (!row.rowCount) {
            await sendTelegramMessage(botToken, chatId, "Запись уже недоступна для отмены.");
          } else {
            await cancelAppointmentForSalon({
              salonId,
              appointmentId,
              requestId: `adm-cancel-${salonId}-${appointmentId}-${Date.now()}`,
              actor: "admin"
            });
            const a = row.rows[0];
            const when = new Intl.DateTimeFormat("ru-RU", {
              timeZone: salonTimezone,
              weekday: "short",
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit"
            }).format(new Date(String(a.start_at)));
            await sendTelegramMessage(botToken, chatId, `Запись клиента ${a.client_name} на ${when} отменена.`);
            const clientTelegramId = Number(a.client_telegram_user_id);
            if (Number.isFinite(clientTelegramId)) {
              await sendTelegramMessage(
                botToken,
                clientTelegramId,
                `К сожалению, мастер отменил вашу запись на ${when}.${reason ? `\nПричина: ${reason}` : ""}\nНапишите "записаться", чтобы выбрать новое время.`
              );
            }
          }
          await pool.query("DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2", [
            salonId,
            fromId
          ]);
          return res.json({ ok: true, duplicate: false });
        }
      } else if (pendingAction?.action_type === "broadcast_text" && !text.startsWith("/")) {
        const messageText = text.trim();
        if (messageText.length < 3) {
          await sendTelegramMessage(botToken, chatId, "Текст слишком короткий. Введите минимум 3 символа.");
          return res.json({ ok: true, duplicate: false });
        }
        const clients = await pool.query(
          `SELECT DISTINCT telegram_user_id
           FROM telegram_clients
           WHERE salon_id = $1`,
          [salonId]
        );
        let sent = 0;
        let failed = 0;
        for (const c of clients.rows) {
          const tgId = Number(c.telegram_user_id);
          if (!Number.isFinite(tgId)) continue;
          try {
            await sendTelegramMessage(
              botToken,
              tgId,
              `Сообщение от салона "${salonName}":\n\n${messageText}`
            );
            sent += 1;
          } catch {
            failed += 1;
          }
        }
        await pool.query(
          "INSERT INTO audit_logs (salon_id, action, payload_json) VALUES ($1,'admin_broadcast',$2)",
          [salonId, JSON.stringify({ sent, failed, textLength: messageText.length })]
        );
        await pool.query("DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2", [
          salonId,
          fromId
        ]);
        await sendTelegramMessage(
          botToken,
          chatId,
          `Рассылка завершена.\nОтправлено: ${sent}\nОшибок: ${failed}`
        );
        return res.json({ ok: true, duplicate: false });
      }
      const normalized = text.toLowerCase();
      if (text === "/start" || normalized === "старт" || text === "/help") {
        await sendTelegramMessage(
          botToken,
          chatId,
          `Здравствуйте! Это бот мастера салона "${salonName}".`,
          { reply_markup: adminMenuKeyboard() }
        );
        await showFirstRunHelpIfNeeded(chatId, fromId);
        await renderBookingsHome(chatId);
      } else if (text === "/status") {
        await sendTelegramMessage(botToken, chatId, "Подключение активно. Бот работает корректно.");
      } else if (text === "/link") {
        await sendTelegramMessage(botToken, chatId, `Ссылка на запись для клиентов:\n${bookingUrl}`);
      } else if (text === "/today") {
        await renderAdminDay(chatId, dateKeyByOffset(0));
      } else {
        await sendTelegramMessage(botToken, chatId, "Выберите раздел.", { reply_markup: adminMenuKeyboard() });
      }
    } else {
      const profile = await getTelegramClientProfile(salonId, fromId);
      const hasPhone = Boolean(profile?.client_phone);
      const low = text.toLowerCase();
      const normalizedPhone = normalizeRuPhone(text);
      if (normalizedPhone) {
        await upsertTelegramClientProfile(salonId, message.from, normalizedPhone);
        await sendTelegramMessage(botToken, chatId, "Телефон сохранен. Теперь нажмите «Записаться».", {
          reply_markup: { remove_keyboard: true }
        });
        await renderDateChoices(chatId);
        return res.json({ ok: true, duplicate: false });
      }
      const looksLikePhoneAttempt = /[\d+]/.test(text) && !text.startsWith("/") && !low.includes("запис") && !low.includes("отмен");
      if (looksLikePhoneAttempt && !hasPhone) {
        await sendTelegramMessage(
          botToken,
          chatId,
          "Номер введен с ошибкой, повторите. Формат: 8XXXXXXXXXX или +7XXXXXXXXXX."
        );
      }
      if (text === "/start") {
        if (!hasPhone) {
          await sendTelegramMessage(
            botToken,
            chatId,
            `Здравствуйте! Это запись в "${salonName}". Сначала отправьте номер телефона, и после этого станет доступна запись.`
          );
        } else {
          const activeBooking = await getActiveTelegramBooking(salonId, fromId);
          if (activeBooking) {
            const when = new Intl.DateTimeFormat("ru-RU", {
              timeZone: salonTimezone,
              weekday: "short",
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit"
            }).format(new Date(activeBooking.start_at));
            await sendTelegramMessage(
              botToken,
              chatId,
              `У вас уже есть запись на ${when}. Новая запись будет доступна после отмены текущей.`,
              { reply_markup: { inline_keyboard: [[{ text: "Отменить запись", callback_data: `bk:cancel:${activeBooking.id}` }]] } }
            );
            return res.json({ ok: true, duplicate: false });
          }
          await sendTelegramMessage(
            botToken,
            chatId,
            `Здравствуйте! Это запись в "${salonName}". Нажмите кнопку ниже и выберите дату/время.`,
            { reply_markup: { inline_keyboard: [[{ text: "Записаться", callback_data: "bk:start" }]] } }
          );
        }
      } else if (low.includes("запис")) {
        if (!hasPhone) {
          await sendTelegramMessage(botToken, chatId, "Сначала отправьте номер телефона (один раз), затем запись станет доступна.");
        } else {
          const activeBooking = await getActiveTelegramBooking(salonId, fromId);
          if (activeBooking) {
            const when = new Intl.DateTimeFormat("ru-RU", {
              timeZone: salonTimezone,
              weekday: "short",
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit"
            }).format(new Date(activeBooking.start_at));
            await sendTelegramMessage(
              botToken,
              chatId,
              `У вас уже есть запись на ${when}. Сначала отмените ее, если хотите выбрать другое время.`,
              { reply_markup: { inline_keyboard: [[{ text: "Отменить запись", callback_data: `bk:cancel:${activeBooking.id}` }]] } }
            );
            return res.json({ ok: true, duplicate: false });
          }
          await renderDateChoices(chatId);
        }
      } else if (low.includes("отмен")) {
        const activeBooking = await getActiveTelegramBooking(salonId, fromId);
        if (!activeBooking) {
          await sendTelegramMessage(botToken, chatId, "У вас нет активной записи для отмены.");
        } else {
          const when = new Intl.DateTimeFormat("ru-RU", {
            timeZone: salonTimezone,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(activeBooking.start_at));
          await sendTelegramMessage(botToken, chatId, `Отменить запись на ${when}?`, {
            reply_markup: { inline_keyboard: [[{ text: "Отменить запись", callback_data: `bk:cancel:${activeBooking.id}` }]] }
          });
        }
      } else if (text === "/web") {
        await sendTelegramMessage(botToken, chatId, `Ссылка на веб-запись:\n${bookingUrl}`);
      } else {
        if (!hasPhone) {
          await sendTelegramMessage(botToken, chatId, "Сначала отправьте номер телефона, затем появится запись.");
        } else {
          await sendTelegramMessage(botToken, chatId, 'Нажмите "Записаться" или напишите "записаться".', {
            reply_markup: { inline_keyboard: [[{ text: "Записаться", callback_data: "bk:start" }]] }
          });
        }
      }
      if (!hasPhone) {
        await sendTelegramMessage(botToken, chatId, "Чтобы мастер видел ваш номер, поделитесь телефоном (один раз):", {
          reply_markup: {
            keyboard: [[{ text: "Поделиться телефоном", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        });
      }
    }
  }

  const callback = req.body?.callback_query;
  if (callback?.from?.id && callback?.message?.chat?.id && callback?.id) {
    const chatId = Number(callback.message.chat.id);
    const fromId = String(callback.from.id);
    const data = String(callback.data ?? "");
    await answerCallbackQuery(botToken, String(callback.id));

    if (fromId !== adminTelegramUserId) {
      const profile = await getTelegramClientProfile(salonId, fromId);
      if (!profile?.client_phone) {
        await sendTelegramMessage(botToken, chatId, "Сначала отправьте номер телефона, затем можно выбирать дату и время.", {
          reply_markup: {
            keyboard: [[{ text: "Поделиться телефоном", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
          }
        });
        return res.json({ ok: true, duplicate: false });
      }
      if (data === "bk:start") {
        const activeBooking = await getActiveTelegramBooking(salonId, fromId);
        if (activeBooking) {
          const when = new Intl.DateTimeFormat("ru-RU", {
            timeZone: salonTimezone,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(activeBooking.start_at));
          await sendTelegramMessage(
            botToken,
            chatId,
            `У вас уже есть запись на ${when}. Сначала отмените ее.`,
            { reply_markup: { inline_keyboard: [[{ text: "Отменить запись", callback_data: `bk:cancel:${activeBooking.id}` }]] } }
          );
          return res.json({ ok: true, duplicate: false });
        }
        await renderDateChoices(chatId);
      } else if (data.startsWith("bk:date:")) {
        await renderTimeChoices(chatId, data.replace("bk:date:", ""));
      } else if (data.startsWith("bk:slot:")) {
        const startMs = Number(data.replace("bk:slot:", ""));
        if (Number.isFinite(startMs)) {
          const startAt = new Date(startMs).toISOString();
          const label = new Intl.DateTimeFormat("ru-RU", {
            timeZone: salonTimezone,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(startAt));
          await sendTelegramMessage(botToken, chatId, `Подтвердите запись на ${label}`, {
            reply_markup: {
              inline_keyboard: [[{ text: "Подтвердить запись", callback_data: `bk:confirm:${startMs}` }]]
            }
          });
        }
      } else if (data.startsWith("bk:confirm:")) {
        const startMs = Number(data.replace("bk:confirm:", ""));
        if (Number.isFinite(startMs)) {
          const profile = await getTelegramClientProfile(salonId, fromId);
          if (!profile?.client_phone) {
            await sendTelegramMessage(botToken, chatId, "Сначала поделитесь телефоном (кнопка ниже), затем повторите запись.", {
              reply_markup: {
                keyboard: [[{ text: "Поделиться телефоном", request_contact: true }]],
                resize_keyboard: true,
                one_time_keyboard: true
              }
            });
          } else {
            const existingInWindow = await pool.query(
              `SELECT id, start_at
               FROM appointments
               WHERE salon_id = $1
                 AND client_telegram_user_id = $2
                 AND status = 'booked'
                 AND start_at >= now()
                 AND start_at < now() + interval '30 days'
               ORDER BY start_at ASC
               LIMIT 1`,
              [salonId, fromId]
            );
            if (existingInWindow.rowCount) {
              const when = new Intl.DateTimeFormat("ru-RU", {
                timeZone: salonTimezone,
                weekday: "short",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              }).format(new Date(String(existingInWindow.rows[0].start_at)));
              await sendTelegramMessage(
                botToken,
                chatId,
                `Ограничение: 1 запись на 30 дней. У вас уже есть запись на ${when}.`,
                {
                  reply_markup: {
                    inline_keyboard: [[{ text: "Отменить текущую запись", callback_data: `bk:cancel:${existingInWindow.rows[0].id}` }]]
                  }
                }
              );
              return res.json({ ok: true, duplicate: false });
            }
            const startAt = new Date(startMs).toISOString();
            try {
              const booking = await bookAppointmentForSalon({
                salonId,
                clientName: String(profile.client_name),
                clientPhone: String(profile.client_phone),
                clientTelegramUserId: fromId,
                source: "telegram",
                requestId: `tg-book-${salonId}-${fromId}-${startMs}`,
                slotStartAt: startAt
              });
              const label = new Intl.DateTimeFormat("ru-RU", {
                timeZone: salonTimezone,
                weekday: "short",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              }).format(new Date(startAt));
              await sendTelegramMessage(
                botToken,
                chatId,
                `Готово! Вы записаны на ${label}. Спасибо за запись, ждем вас с нетерпением!`,
                {
                reply_markup: { remove_keyboard: true }
                }
              );
              await notifySalonAdmin(
                salonId,
                `Новая запись из Telegram:\n- клиент: ${profile.client_name}\n- телефон: ${profile.client_phone}\n- время: ${label}`
              );
            } catch (error) {
              if (error instanceof ConflictError) {
                await sendTelegramMessage(botToken, chatId, "Этот слот уже заняли. Выберите другое время.");
                await renderDateChoices(chatId);
              } else {
                await sendTelegramMessage(botToken, chatId, "Не удалось создать запись. Попробуйте еще раз.");
              }
            }
          }
        }
      } else if (data.startsWith("bk:cancel:")) {
        const appointmentId = data.replace("bk:cancel:", "").trim();
        if (!appointmentId) return res.json({ ok: true, duplicate: false });
        const owned = await pool.query(
          `SELECT id, start_at
           FROM appointments
           WHERE id = $1
             AND salon_id = $2
             AND client_telegram_user_id = $3
             AND status = 'booked'
           LIMIT 1`,
          [appointmentId, salonId, fromId]
        );
        if (!owned.rowCount) {
          await sendTelegramMessage(botToken, chatId, "Эту запись уже нельзя отменить.");
          return res.json({ ok: true, duplicate: false });
        }
        try {
          await cancelAppointmentForSalon({
            salonId,
            appointmentId,
            requestId: `tg-cancel-${salonId}-${fromId}-${appointmentId}`,
            actor: "client"
          });
          const when = new Intl.DateTimeFormat("ru-RU", {
            timeZone: salonTimezone,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(String(owned.rows[0].start_at)));
          await sendTelegramMessage(botToken, chatId, `Запись на ${when} отменена.`);
          await notifySalonAdmin(salonId, `Клиент отменил запись на ${when}.`);
        } catch (error) {
          await sendTelegramMessage(botToken, chatId, `Не удалось отменить запись: ${(error as Error).message}`);
        }
      } else if (data.startsWith("rem:confirm:")) {
        const appointmentId = data.replace("rem:confirm:", "").trim();
        if (!appointmentId) return res.json({ ok: true, duplicate: false });
        const own = await pool.query(
          `SELECT id, start_at, client_confirmed_at
           FROM appointments
           WHERE id = $1
             AND salon_id = $2
             AND client_telegram_user_id = $3
             AND status = 'booked'
           LIMIT 1`,
          [appointmentId, salonId, fromId]
        );
        if (!own.rowCount) {
          await sendTelegramMessage(botToken, chatId, "Запись не найдена или уже неактивна.");
          return res.json({ ok: true, duplicate: false });
        }
        if (!own.rows[0].client_confirmed_at) {
          await pool.query("UPDATE appointments SET client_confirmed_at = now() WHERE id = $1", [appointmentId]);
          const when = new Intl.DateTimeFormat("ru-RU", {
            timeZone: salonTimezone,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(String(own.rows[0].start_at)));
          await sendTelegramMessage(botToken, chatId, `Отлично, планы подтверждены. Ждем вас ${when}.`);
          await notifySalonAdmin(salonId, `Клиент подтвердил визит на ${when}.`);
        } else {
          await sendTelegramMessage(botToken, chatId, "Планы уже подтверждены ранее.");
        }
      }
    } else {
      if (data === "adm:menu") {
        await sendTelegramMessage(botToken, chatId, "Меню мастера:", { reply_markup: adminMenuKeyboard() });
      } else if (data === "adm:section:bookings") {
        await renderBookingsHome(chatId);
      } else if (data === "adm:section:schedule") {
        await sendTelegramMessage(botToken, chatId, "График", { reply_markup: scheduleMenuKeyboard() });
      } else if (data === "adm:section:settings") {
        await sendTelegramMessage(botToken, chatId, "Настройки", { reply_markup: settingsMenuKeyboard() });
      } else if (data === "adm:section:help") {
        await renderHelp(chatId);
      } else if (data === "adm:schedule") {
        await showScheduleMonthPicker(chatId);
      } else if (data === "adm:workdays") {
        await sendTelegramMessage(botToken, chatId, "Рабочие дни: выберите режим работы", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Каждый день", callback_data: "adm:workdays:type:everyday" }],
              [{ text: "Через день", callback_data: "adm:workdays:type:everyother" }],
              [{ text: "Назад", callback_data: "adm:section:schedule" }]
            ]
          }
        });
      } else if (data === "adm:workdays:type:everyday" || data === "adm:workdays:type:everyother") {
        const typeKey = data === "adm:workdays:type:everyday" ? "everyday" : "everyother";
        const typeLabel = typeKey === "everyday" ? "каждый день" : "через день";
        await sendTelegramMessage(botToken, chatId, `Режим: ${typeLabel}.\nС какого дня начинаем?`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Сегодня", callback_data: `adm:workdays:start:${typeKey}:today` }],
              [{ text: "Завтра", callback_data: `adm:workdays:start:${typeKey}:tomorrow` }],
              [{ text: "Назад", callback_data: "adm:workdays" }]
            ]
          }
        });
      } else if (data.startsWith("adm:workdays:start:")) {
        const parts = data.split(":");
        const typeKey = parts[3] ?? "";
        const when = parts[4] ?? "";
        if (!["everyday", "everyother"].includes(typeKey) || !["today", "tomorrow"].includes(when)) {
          await sendTelegramMessage(botToken, chatId, "Некорректный параметр.");
        } else {
          const startDate = dayjs().tz(salonTimezone).add(when === "tomorrow" ? 1 : 0, "day").format("YYYY-MM-DD");
          for (let wd = 0; wd <= 6; wd++) {
            await pool.query(
              `INSERT INTO working_rules (salon_id, weekday, start_minute, end_minute, is_active)
               VALUES ($1,$2,600,1200,true)
               ON CONFLICT (salon_id, weekday) DO UPDATE SET is_active = true`,
              [salonId, wd]
            );
          }
          await pool.query(
            "UPDATE salon_work_patterns SET is_active = false, updated_at = now() WHERE salon_id = $1",
            [salonId]
          );
          if (typeKey === "everyother") {
            const endDate = dayjs(startDate).add(1, "year").format("YYYY-MM-DD");
            await pool.query(
              `INSERT INTO salon_work_patterns
                (salon_id, period_start, period_end, pattern_type, anchor_date, is_active, updated_at)
               VALUES ($1,$2::date,$3::date,'every_other_day',$2::date,true,now())`,
              [salonId, startDate, endDate]
            );
          }
          const typeLabel = typeKey === "everyday" ? "Каждый день" : "Через день";
          const whenLabel = when === "today" ? "с сегодня" : "с завтра";
          await sendTelegramMessage(
            botToken,
            chatId,
            `✅ График сохранён: ${typeLabel}, ${whenLabel} (${startDate}).`,
            { reply_markup: adminMenuKeyboard() }
          );
        }
      } else if (data === "adm:worktime") {
        await sendTelegramMessage(botToken, chatId, "Рабочее время", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "09:00 - 18:00", callback_data: "adm:worktime:set:540:1080" }],
              [{ text: "10:00 - 19:00", callback_data: "adm:worktime:set:600:1140" }],
              [{ text: "11:00 - 20:00", callback_data: "adm:worktime:set:660:1200" }],
              [{ text: "Назад", callback_data: "adm:section:schedule" }]
            ]
          }
        });
      } else if (data.startsWith("adm:worktime:set:")) {
        const parts = data.split(":");
        const startMinute = Number(parts[3] ?? "");
        const endMinute = Number(parts[4] ?? "");
        if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute) || endMinute <= startMinute) {
          await sendTelegramMessage(botToken, chatId, "Некорректный интервал времени.");
        } else {
          await pool.query(
            `UPDATE working_rules
             SET start_minute = $2, end_minute = $3
             WHERE salon_id = $1`,
            [salonId, startMinute, endMinute]
          );
          await sendTelegramMessage(botToken, chatId, `Рабочее время обновлено: ${minuteToHHMM(startMinute)} - ${minuteToHHMM(endMinute)}.`);
          await sendTelegramMessage(botToken, chatId, "График", { reply_markup: scheduleMenuKeyboard() });
        }
      } else if (data === "adm:duration") {
        await sendTelegramMessage(botToken, chatId, "Длительность записи", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "30 минут", callback_data: "adm:slot:set:30" }],
              [{ text: "60 минут", callback_data: "adm:slot:set:60" }],
              [{ text: "120 минут", callback_data: "adm:slot:set:120" }],
              [{ text: "Назад", callback_data: "adm:section:schedule" }]
            ]
          }
        });
      } else if (data === "adm:slot:menu") {
        await sendTelegramMessage(botToken, chatId, "Выберите сетку времени работы:", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "30 минут", callback_data: "adm:slot:set:30" },
                { text: "1 час", callback_data: "adm:slot:set:60" },
                { text: "2 часа", callback_data: "adm:slot:set:120" }
              ],
              [{ text: "Назад к меню", callback_data: "adm:menu" }]
            ]
          }
        });
      } else if (data.startsWith("adm:slot:set:")) {
        const slotMinutes = Number(data.replace("adm:slot:set:", "").trim());
        if (![30, 60, 120].includes(slotMinutes)) {
          await sendTelegramMessage(botToken, chatId, "Некорректное значение сетки.");
        } else {
          await pool.query(
            `INSERT INTO master_settings (salon_id, slot_duration_minutes, booking_horizon_days, cancel_cutoff_hours, timezone)
             VALUES (
               $1,
               $2,
               COALESCE((SELECT booking_horizon_days FROM master_settings WHERE salon_id = $1), 30),
               COALESCE((SELECT cancel_cutoff_hours FROM master_settings WHERE salon_id = $1), 2),
               COALESCE((SELECT timezone FROM master_settings WHERE salon_id = $1), $3)
             )
             ON CONFLICT (salon_id) DO UPDATE
             SET slot_duration_minutes = EXCLUDED.slot_duration_minutes`,
            [salonId, slotMinutes, config.timezone]
          );
          await sendTelegramMessage(botToken, chatId, `Сетка записи обновлена: ${slotMinutes} мин.`, {
            reply_markup: adminMenuKeyboard()
          });
          await notifySalonAdmin(salonId, `Настройки применены: сетка записи ${slotMinutes} мин.`);
        }
      } else if (data === "adm:clear-schedule:start") {
        await sendTelegramMessage(
          botToken,
          chatId,
          [
            "Вы хотите очистить график?",
            "",
            "Будет удалено:",
            "• рабочие дни",
            "• рабочее время",
            "• длительность записи",
            "• закрытые даты"
          ].join("\n"),
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Очистить", callback_data: "adm:clear-schedule:confirm" }],
                [{ text: "Отмена", callback_data: "adm:clear-schedule:cancel" }]
              ]
            }
          }
        );
      } else if (data === "adm:clear-schedule:cancel") {
        await sendTelegramMessage(botToken, chatId, "Очистка отменена.", { reply_markup: settingsMenuKeyboard() });
      } else if (data === "adm:clear-schedule:confirm") {
        await pool.query("UPDATE booking_pauses SET is_active = false, updated_at = now() WHERE salon_id = $1", [salonId]);
        await pool.query("UPDATE salon_work_patterns SET is_active = false, updated_at = now() WHERE salon_id = $1", [salonId]);
        await pool.query("DELETE FROM schedule_exceptions WHERE salon_id = $1", [salonId]);
        await pool.query("DELETE FROM working_rules WHERE salon_id = $1", [salonId]);
        for (let weekday = 0; weekday <= 6; weekday += 1) {
          await pool.query(
            `INSERT INTO working_rules (salon_id, weekday, start_minute, end_minute, is_active)
             VALUES ($1,$2,600,1200,false)`,
            [salonId, weekday]
          );
        }
        await pool.query(
          `INSERT INTO master_settings (salon_id, slot_duration_minutes, booking_horizon_days, cancel_cutoff_hours, timezone)
           VALUES ($1,60,30,2,$2)
           ON CONFLICT (salon_id) DO UPDATE
           SET slot_duration_minutes = 60,
               booking_horizon_days = 30,
               cancel_cutoff_hours = 2,
               timezone = COALESCE(master_settings.timezone, EXCLUDED.timezone)`,
          [salonId, config.timezone]
        );
        await pool.query(
          "DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2",
          [salonId, fromId]
        );
        await sendTelegramMessage(
          botToken,
          chatId,
          "График очищен.\nЗадайте рабочие дни и время, чтобы открыть запись для клиентов.",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Перейти в График", callback_data: "adm:section:schedule" }],
                [{ text: "В Настройки", callback_data: "adm:section:settings" }]
              ]
            }
          }
        );
      } else if (data.startsWith("adm:sch:month:")) {
        const mode = data.replace("adm:sch:month:", "").trim() === "next" ? "next" : "current";
        const monthRange = getMonthRange(mode);
        await saveScheduleActionState(fromId, { monthMode: mode, monthStart: monthRange.start, monthEnd: monthRange.end });
        await sendTelegramMessage(botToken, chatId, `Месяц ${monthRange.label}. Выберите шаблон:`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Четные даты", callback_data: "adm:sch:pattern:even_dates" }],
              [{ text: "Нечетные даты", callback_data: "adm:sch:pattern:odd_dates" }],
              [{ text: "Через день", callback_data: "adm:sch:pattern:every_other_day" }],
              [{ text: "Назад к меню", callback_data: "adm:menu" }]
            ]
          }
        });
      } else if (data.startsWith("adm:sch:pattern:")) {
        const patternType = data.replace("adm:sch:pattern:", "").trim();
        const st = await pool.query(
          "SELECT payload_json FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2",
          [salonId, fromId]
        );
        const prev = st.rowCount ? st.rows[0].payload_json : {};
        const monthStart = String(prev.monthStart ?? "");
        const monthEnd = String(prev.monthEnd ?? "");
        if (!monthStart || !monthEnd) {
          await sendTelegramMessage(botToken, chatId, "Сначала выберите месяц.");
        } else {
          const anchorDate = monthStart;
          await pool.query(
            "UPDATE salon_work_patterns SET is_active = false, updated_at = now() WHERE salon_id = $1 AND period_start = $2::date AND period_end = $3::date AND is_active = true",
            [salonId, monthStart, monthEnd]
          );
          await pool.query(
            `INSERT INTO salon_work_patterns
              (salon_id, period_start, period_end, pattern_type, anchor_date, is_active, updated_at)
             VALUES ($1,$2::date,$3::date,$4,$5::date,true,now())`,
            [salonId, monthStart, monthEnd, patternType, anchorDate]
          );
          await pool.query("DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2", [
            salonId,
            fromId
          ]);
          const labelMap: Record<string, string> = {
            even_dates: "Четные даты",
            odd_dates: "Нечетные даты",
            every_other_day: "Через день"
          };
          await sendTelegramMessage(
            botToken,
            chatId,
            `График сохранен: ${labelMap[patternType] || patternType}, период ${monthStart} - ${monthEnd}.`,
            { reply_markup: adminMenuKeyboard() }
          );
        }
      } else if (data === "adm:close-dates") {
        await sendTelegramMessage(botToken, chatId, "Закрыть даты", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Сегодня", callback_data: "adm:pause:start:today" }],
              [{ text: "Завтра", callback_data: "adm:pause:start:tomorrow" }],
              [{ text: "Выбрать вручную", callback_data: "adm:pause:pick:start" }],
              [{ text: "Назад", callback_data: "adm:section:settings" }]
            ]
          }
        });
      } else if (data === "adm:pause:start:today" || data === "adm:pause:start:tomorrow") {
        const start = data === "adm:pause:start:today" ? dateKeyByOffset(0) : dateKeyByOffset(1);
        await pool.query(
          `INSERT INTO telegram_admin_actions (salon_id, admin_telegram_user_id, action_type, payload_json, updated_at)
           VALUES ($1,$2,'pause_setup',$3,now())
           ON CONFLICT (salon_id, admin_telegram_user_id)
           DO UPDATE SET action_type='pause_setup', payload_json=EXCLUDED.payload_json, updated_at=now()`,
          [salonId, fromId, JSON.stringify({ startDate: start })]
        );
        const rows = pauseDateButtons("adm:pause:end:", 0, 35);
        rows.push([{ text: "Назад", callback_data: "adm:section:settings" }]);
        await sendTelegramMessage(botToken, chatId, `Начало: ${start}. Выберите конец:`, {
          reply_markup: { inline_keyboard: rows }
        });
      } else if (data === "adm:pause:pick:start") {
        const rows = pauseDateButtons("adm:pause:start:", 0, 28);
        rows.push([{ text: "Назад", callback_data: "adm:section:settings" }]);
        await sendTelegramMessage(botToken, chatId, "Выберите дату начала:", {
          reply_markup: { inline_keyboard: rows }
        });
      } else if (data.startsWith("adm:pause:start:")) {
        const start = data.replace("adm:pause:start:", "").trim();
        await pool.query(
          `INSERT INTO telegram_admin_actions (salon_id, admin_telegram_user_id, action_type, payload_json, updated_at)
           VALUES ($1,$2,'pause_setup',$3,now())
           ON CONFLICT (salon_id, admin_telegram_user_id)
           DO UPDATE SET action_type='pause_setup', payload_json=EXCLUDED.payload_json, updated_at=now()`,
          [salonId, fromId, JSON.stringify({ startDate: start })]
        );
        const rows = pauseDateButtons("adm:pause:end:", 0, 35);
        rows.push([{ text: "Назад к меню", callback_data: "adm:menu" }]);
        await sendTelegramMessage(botToken, chatId, `Начало паузы: ${start}. Теперь выберите дату окончания:`, {
          reply_markup: { inline_keyboard: rows }
        });
      } else if (data.startsWith("adm:pause:end:")) {
        const end = data.replace("adm:pause:end:", "").trim();
        const st = await pool.query(
          "SELECT action_type, payload_json FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2",
          [salonId, fromId]
        );
        const payload = st.rowCount ? st.rows[0].payload_json : {};
        const start = String(payload.startDate ?? "");
        if (!start) {
          await sendTelegramMessage(botToken, chatId, "Сначала выберите дату начала паузы.");
        } else if (end < start) {
          await sendTelegramMessage(botToken, chatId, "Дата окончания не может быть раньше даты начала. Выберите снова.");
        } else {
          const affectedCount = await countBookingsInRange(start, end);
          await pool.query(
            `INSERT INTO telegram_admin_actions (salon_id, admin_telegram_user_id, action_type, payload_json, updated_at)
             VALUES ($1,$2,'pause_confirm',$3,now())
             ON CONFLICT (salon_id, admin_telegram_user_id)
             DO UPDATE SET action_type='pause_confirm', payload_json=EXCLUDED.payload_json, updated_at=now()`,
            [salonId, fromId, JSON.stringify({ startDate: start, endDate: end, affectedCount })]
          );
          await sendTelegramMessage(
            botToken,
            chatId,
            `Период паузы: ${start} - ${end}.\nНайдено записей в периоде: ${affectedCount}.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Только закрыть новые записи", callback_data: "adm:pause:apply:block" }],
                  [{ text: "Отменить записи с сообщением", callback_data: "adm:pause:apply:notify" }],
                  [{ text: "Отмена", callback_data: "adm:pause:apply:cancel" }]
                ]
              }
            }
          );
        }
      } else if (data === "adm:pause:apply:block" || data === "adm:pause:apply:notify" || data === "adm:pause:apply:cancel") {
        const st = await pool.query(
          "SELECT action_type, payload_json FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2",
          [salonId, fromId]
        );
        const payload = st.rowCount ? st.rows[0].payload_json : {};
        const start = String(payload.startDate ?? "");
        const end = String(payload.endDate ?? "");
        const affectedCount = Number(payload.affectedCount ?? 0);
        if (!start || !end) {
          await sendTelegramMessage(botToken, chatId, "Нет данных по выбранному периоду. Повторите выбор паузы.", {
            reply_markup: adminMenuKeyboard()
          });
          await pool.query("DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2", [
            salonId,
            fromId
          ]);
        } else if (data === "adm:pause:apply:cancel") {
          await pool.query("DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2", [
            salonId,
            fromId
          ]);
          await sendTelegramMessage(botToken, chatId, "Пауза не применена.", { reply_markup: adminMenuKeyboard() });
        } else if (data === "adm:pause:apply:block") {
          await setPauseOnly(start, end);
          await pool.query("DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2", [
            salonId,
            fromId
          ]);
          await sendTelegramMessage(
            botToken,
            chatId,
            `Пауза установлена: ${start} - ${end}.\nСуществующие записи (${affectedCount}) не отменялись.`,
            { reply_markup: adminMenuKeyboard() }
          );
        } else {
          await pool.query(
            `INSERT INTO telegram_admin_actions (salon_id, admin_telegram_user_id, action_type, payload_json, updated_at)
             VALUES ($1,$2,'pause_cancel_text',$3,now())
             ON CONFLICT (salon_id, admin_telegram_user_id)
             DO UPDATE SET action_type='pause_cancel_text', payload_json=EXCLUDED.payload_json, updated_at=now()`,
            [salonId, fromId, JSON.stringify({ startDate: start, endDate: end, affectedCount })]
          );
          await sendTelegramMessage(
            botToken,
            chatId,
            "Введите текст, который получат клиенты при отмене записей в этом периоде."
          );
        }
      } else if (data === "adm:resume") {
        await pool.query("UPDATE booking_pauses SET is_active = false, updated_at = now() WHERE salon_id = $1 AND is_active = true", [
          salonId
        ]);
        await sendTelegramMessage(botToken, chatId, "Пауза снята. Запись снова открыта.", { reply_markup: adminMenuKeyboard() });
      } else if (data === "adm:broadcast:start") {
        await sendTelegramMessage(botToken, chatId, "Вы уверены, что хотите сделать рассылку всем клиентам?", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Да, продолжить", callback_data: "adm:broadcast:confirm" }],
              [{ text: "Нет, отмена", callback_data: "adm:broadcast:cancel" }]
            ]
          }
        });
      } else if (data === "adm:broadcast:confirm") {
        await pool.query(
          `INSERT INTO telegram_admin_actions (salon_id, admin_telegram_user_id, action_type, payload_json, updated_at)
           VALUES ($1,$2,'broadcast_text',$3,now())
           ON CONFLICT (salon_id, admin_telegram_user_id)
           DO UPDATE SET action_type='broadcast_text', payload_json=EXCLUDED.payload_json, updated_at=now()`,
          [salonId, fromId, JSON.stringify({ startedAt: new Date().toISOString() })]
        );
        await sendTelegramMessage(botToken, chatId, "Введите текст рассылки одним сообщением.");
      } else if (data === "adm:broadcast:cancel") {
        await pool.query("DELETE FROM telegram_admin_actions WHERE salon_id = $1 AND admin_telegram_user_id = $2", [
          salonId,
          fromId
        ]);
        await sendTelegramMessage(botToken, chatId, "Рассылка отменена.", { reply_markup: adminMenuKeyboard() });
      } else if (data === "adm:status") {
        await sendTelegramMessage(botToken, chatId, "Подключение активно. Бот работает корректно.");
      } else if (data === "adm:link") {
        await sendTelegramMessage(botToken, chatId, `Ссылка на запись для клиентов:\n${bookingUrl}`);
      } else if (data === "adm:today") {
        await renderAdminDay(chatId, dateKeyByOffset(0));
      } else if (data === "adm:tomorrow") {
        await renderAdminDay(chatId, dateKeyByOffset(1));
      } else if (data === "adm:after") {
        await renderAdminDay(chatId, dateKeyByOffset(2));
      } else if (data === "adm:days") {
        await renderAdmin30Days(chatId);
      } else if (data.startsWith("adm:day:")) {
        await renderAdminDay(chatId, data.replace("adm:day:", "").trim());
      } else if (data.startsWith("adm:block:start:")) {
        const slotMs = Number(data.replace("adm:block:start:", "").trim());
        if (!Number.isFinite(slotMs)) return res.json({ ok: true, duplicate: false });
        const slotStart = new Date(slotMs);
        if (slotStart <= new Date()) {
          await sendTelegramMessage(botToken, chatId, "Нельзя закрыть слот в прошлом.");
          return res.json({ ok: true, duplicate: false });
        }
        const when = new Intl.DateTimeFormat("ru-RU", {
          timeZone: salonTimezone,
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        }).format(slotStart);
        await sendTelegramMessage(
          botToken,
          chatId,
          `Закрыть слот ${when}?\nКлиенты не смогут записаться на это время.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔒 Закрыть слот", callback_data: `adm:block:confirm:${slotMs}` }],
                [{ text: "Отмена", callback_data: "adm:section:bookings" }]
              ]
            }
          }
        );
      } else if (data.startsWith("adm:block:confirm:")) {
        const slotMs = Number(data.replace("adm:block:confirm:", "").trim());
        if (!Number.isFinite(slotMs)) return res.json({ ok: true, duplicate: false });
        const slotStart = new Date(slotMs);
        if (slotStart <= new Date()) {
          await sendTelegramMessage(botToken, chatId, "Нельзя закрыть слот в прошлом.");
          return res.json({ ok: true, duplicate: false });
        }
        const settingsRow = await pool.query(
          "SELECT slot_duration_minutes FROM master_settings WHERE salon_id = $1",
          [salonId]
        );
        const slotDuration = Number(settingsRow.rows[0]?.slot_duration_minutes ?? 60);
        const slotEnd = new Date(slotMs + slotDuration * 60 * 1000);
        const when = new Intl.DateTimeFormat("ru-RU", {
          timeZone: salonTimezone,
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        }).format(slotStart);
        try {
          const blockId = crypto.randomUUID();
          await pool.query(
            `INSERT INTO appointments
             (id, salon_id, client_name, client_phone, source, status, start_at, end_at, is_admin_block)
             VALUES ($1,$2,'Закрыто','admin_block','web','booked',$3,$4,true)`,
            [blockId, salonId, slotStart.toISOString(), slotEnd.toISOString()]
          );
          await pool.query(
            "INSERT INTO audit_logs (salon_id, action, payload_json) VALUES ($1,'admin_block_slot',$2)",
            [salonId, JSON.stringify({ slotStart: slotStart.toISOString(), blockedBy: fromId })]
          );
          const dateKey = new Intl.DateTimeFormat("en-CA", {
            timeZone: salonTimezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
          }).format(slotStart);
          await sendTelegramMessage(
            botToken,
            chatId,
            `Слот ${when} закрыт 🔒\nКлиенты не могут записаться на это время.`
          );
          await renderAdminDay(chatId, dateKey);
        } catch (error: any) {
          if (error?.code === "23505") {
            await sendTelegramMessage(botToken, chatId, "Этот слот уже занят. Обновите расписание.");
          } else {
            await sendTelegramMessage(botToken, chatId, "Не удалось закрыть слот. Попробуйте ещё раз.");
          }
        }
      } else if (data.startsWith("adm:unblock:")) {
        const apptId = data.replace("adm:unblock:", "").trim();
        if (!apptId) return res.json({ ok: true, duplicate: false });
        const row = await pool.query(
          `SELECT id, start_at FROM appointments
           WHERE id = $1 AND salon_id = $2 AND status = 'booked' AND is_admin_block = true
           LIMIT 1`,
          [apptId, salonId]
        );
        if (!row.rowCount) {
          await sendTelegramMessage(botToken, chatId, "Блокировка не найдена или уже снята.");
        } else {
          await pool.query(
            "UPDATE appointments SET status='cancelled', cancelled_at=now(), cancelled_by='admin' WHERE id=$1",
            [apptId]
          );
          await pool.query(
            "INSERT INTO audit_logs (salon_id, action, payload_json) VALUES ($1,'admin_unblock_slot',$2)",
            [salonId, JSON.stringify({ appointmentId: apptId, unblockedBy: fromId })]
          );
          const when = new Intl.DateTimeFormat("ru-RU", {
            timeZone: salonTimezone,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(String(row.rows[0].start_at)));
          const dateKey = new Intl.DateTimeFormat("en-CA", {
            timeZone: salonTimezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
          }).format(new Date(String(row.rows[0].start_at)));
          await sendTelegramMessage(botToken, chatId, `Слот ${when} открыт ✅`);
          await renderAdminDay(chatId, dateKey);
        }
      } else if (data.startsWith("adm:appt:")) {
        const apptId = data.replace("adm:appt:", "").trim();
        const row = await pool.query(
          `SELECT id, client_name, client_phone, source, start_at, is_admin_block
           FROM appointments
           WHERE id = $1 AND salon_id = $2 AND status = 'booked'
           LIMIT 1`,
          [apptId, salonId]
        );
        if (!row.rowCount) {
          await sendTelegramMessage(botToken, chatId, "Запись не найдена.");
        } else {
          const a = row.rows[0];
          const when = new Intl.DateTimeFormat("ru-RU", {
            timeZone: salonTimezone,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(a.start_at));
          if (Boolean(a.is_admin_block)) {
            await sendTelegramMessage(
              botToken,
              chatId,
              `🔒 Слот закрыт вручную\nВремя: ${when}\nКлиенты не могут записаться на это время.`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "✅ Снять блокировку", callback_data: `adm:unblock:${a.id}` }],
                    [{ text: "Назад к записям", callback_data: "adm:section:bookings" }]
                  ]
                }
              }
            );
          } else {
            await sendTelegramMessage(
              botToken,
              chatId,
              `Клиент: ${a.client_name}\nВремя: ${when}\nКонтакт: ${a.client_phone}`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "Отменить запись", callback_data: `adm:cancel:${a.id}` }],
                    [{ text: "Назад к записям", callback_data: "adm:section:bookings" }]
                  ]
                }
              }
            );
          }
        }
      } else if (data.startsWith("adm:cancel:")) {
        const appointmentId = data.replace("adm:cancel:", "").trim();
        if (!appointmentId) return res.json({ ok: true, duplicate: false });
        const row = await pool.query(
          `SELECT id, client_name, start_at
           FROM appointments
           WHERE id = $1 AND salon_id = $2 AND status = 'booked'
           LIMIT 1`,
          [appointmentId, salonId]
        );
        if (!row.rowCount) {
          await sendTelegramMessage(botToken, chatId, "Эту запись уже нельзя отменить.");
        } else {
          const a = row.rows[0];
          const when = new Intl.DateTimeFormat("ru-RU", {
            timeZone: salonTimezone,
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(String(a.start_at)));
          await pool.query(
            `INSERT INTO telegram_admin_actions (salon_id, admin_telegram_user_id, action_type, payload_json, updated_at)
             VALUES ($1,$2,'cancel_reason',$3,now())
             ON CONFLICT (salon_id, admin_telegram_user_id)
             DO UPDATE SET action_type='cancel_reason', payload_json=EXCLUDED.payload_json, updated_at=now()`,
            [salonId, fromId, JSON.stringify({ appointmentId })]
          );
          await sendTelegramMessage(
            botToken,
            chatId,
            `Введите причину отмены для клиента (${a.client_name}, ${when}).\nЕсли без причины — отправьте "-" одним сообщением.`
          );
        }
      } else if (data === "adm:none") {
        await sendTelegramMessage(botToken, chatId, "Этот слот свободен.");
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

function chunkButtons<T>(buttons: T[], rowSize: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < buttons.length; i += rowSize) {
    rows.push(buttons.slice(i, i + rowSize));
  }
  return rows;
}

async function sendTelegramApi(botToken: string, method: string, payload: Record<string, unknown>): Promise<void> {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) throw new Error(`telegram ${method} http ${resp.status}`);
  const data: any = await resp.json();
  if (!data?.ok) throw new Error(`telegram ${method} failed`);
}

async function answerCallbackQuery(botToken: string, callbackQueryId: string): Promise<void> {
  try {
    await sendTelegramApi(botToken, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  } catch {
    // Ignore callback answer failures.
  }
}

async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  options?: { reply_markup?: Record<string, unknown> }
): Promise<void> {
  try {
    await sendTelegramApi(botToken, "sendMessage", { chat_id: chatId, text, ...(options ?? {}) });
  } catch {
    // Ignore send errors to keep webhook idempotent and fast.
  }
}

async function upsertTelegramClientProfile(
  salonId: string,
  from: any,
  phone: string | null
): Promise<void> {
  const telegramUserId = String(from?.id ?? "");
  if (!telegramUserId) return;
  const firstName = String(from?.first_name ?? "").trim();
  const lastName = String(from?.last_name ?? "").trim();
  const username = from?.username ? String(from.username) : null;
  const fullName = `${firstName} ${lastName}`.trim() || username || `Telegram ${telegramUserId}`;
  await pool.query(
    `INSERT INTO telegram_clients
      (salon_id, telegram_user_id, telegram_username, telegram_first_name, telegram_last_name, client_name, client_phone, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (salon_id, telegram_user_id)
     DO UPDATE SET
       telegram_username = EXCLUDED.telegram_username,
       telegram_first_name = EXCLUDED.telegram_first_name,
       telegram_last_name = EXCLUDED.telegram_last_name,
       client_name = EXCLUDED.client_name,
       client_phone = COALESCE(EXCLUDED.client_phone, telegram_clients.client_phone),
       updated_at = now()`,
    [salonId, telegramUserId, username, firstName || null, lastName || null, fullName, phone]
  );
}

async function getTelegramClientProfile(
  salonId: string,
  telegramUserId: string
): Promise<{ client_name: string; client_phone: string | null } | null> {
  const row = await pool.query(
    "SELECT client_name, client_phone FROM telegram_clients WHERE salon_id = $1 AND telegram_user_id = $2",
    [salonId, telegramUserId]
  );
  return row.rowCount ? row.rows[0] : null;
}

async function getActiveTelegramBooking(
  salonId: string,
  telegramUserId: string
): Promise<{ id: string; start_at: string } | null> {
  const row = await pool.query(
    `SELECT id, start_at
     FROM appointments
     WHERE salon_id = $1
       AND client_telegram_user_id = $2
       AND status = 'booked'
       AND start_at >= now()
     ORDER BY start_at ASC
     LIMIT 1`,
    [salonId, telegramUserId]
  );
  return row.rowCount ? row.rows[0] : null;
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

function minuteToHHMM(value: number): string {
  const h = Math.floor(value / 60)
    .toString()
    .padStart(2, "0");
  const m = (value % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function weekdayRu(weekday: number): string {
  const map = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  return map[weekday] ?? String(weekday);
}

function normalizeRuPhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-()]/g, "");
  if (/^\+7\d{10}$/.test(compact)) return compact;
  if (/^8\d{10}$/.test(compact)) return `+7${compact.slice(1)}`;
  if (/^7\d{10}$/.test(compact)) return `+7${compact.slice(1)}`;
  return null;
}

const adminSettingsBody = z.object({
  slotDurationMinutes: z.union([z.literal(30), z.literal(45), z.literal(60), z.literal(120)]),
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
  await notifySalonAdmin(
    req.admin!.salonId,
    [
      "Настройки салона обновлены:",
      `- длительность слота: ${parsed.data.slotDurationMinutes} мин`,
      `- горизонт записи: ${parsed.data.bookingHorizonDays} дн`,
      `- отмена не позже чем за: ${parsed.data.cancelCutoffHours} ч`,
      `- таймзона: ${parsed.data.timezone}`
    ].join("\n")
  );
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
  const activeRules = parsed.data.rules.filter((r) => r.isActive);
  const preview = activeRules
    .slice(0, 6)
    .map((r) => `${weekdayRu(r.weekday)} ${minuteToHHMM(r.startMinute)}-${minuteToHHMM(r.endMinute)}`)
    .join("; ");
  await notifySalonAdmin(
    req.admin!.salonId,
    activeRules.length
      ? `Рабочее расписание обновлено (${activeRules.length} активных дней):\n${preview}`
      : "Рабочее расписание обновлено: активных дней нет."
  );
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
  const closedCount = parsed.data.exceptions.filter((e) => e.isClosed).length;
  const customCount = parsed.data.exceptions.filter((e) => !e.isClosed).length;
  const preview = parsed.data.exceptions
    .slice(0, 5)
    .map((e) => {
      if (e.isClosed) return `${e.date} закрыто`;
      return `${e.date} ${minuteToHHMM(Number(e.customStartMinute ?? 0))}-${minuteToHHMM(Number(e.customEndMinute ?? 0))}`;
    })
    .join("; ");
  await notifySalonAdmin(
    req.admin!.salonId,
    parsed.data.exceptions.length
      ? `Исключения обновлены: ${closedCount} закрытых, ${customCount} с часами.\n${preview}`
      : "Исключения очищены: специальных дат нет."
  );
  res.json({ ok: true });
});

const blockSlotBody = z.object({ slotStartAt: z.string().datetime() });

app.post("/admin/slots/block", adminOnly, async (req: AuthedRequest, res) => {
  const parsed = blockSlotBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const salonId = req.admin!.salonId;
  const slotStart = new Date(parsed.data.slotStartAt);
  if (slotStart <= new Date()) {
    return res.status(400).json({ message: "Нельзя закрыть слот в прошлом" });
  }

  const settingsRow = await pool.query(
    "SELECT slot_duration_minutes FROM master_settings WHERE salon_id = $1",
    [salonId]
  );
  if (!settingsRow.rowCount) return res.status(400).json({ message: "Настройки салона не найдены" });
  const slotDuration = Number(settingsRow.rows[0].slot_duration_minutes);
  const slotEnd = new Date(slotStart.getTime() + slotDuration * 60 * 1000);

  const blockId = crypto.randomUUID();
  try {
    await withTx(async (client) => {
      await client.query(
        `INSERT INTO appointments
         (id, salon_id, client_name, client_phone, source, status, start_at, end_at, is_admin_block)
         VALUES ($1,$2,'Закрыто','admin_block','web','booked',$3,$4,true)`,
        [blockId, salonId, slotStart.toISOString(), slotEnd.toISOString()]
      );
      await client.query(
        "INSERT INTO audit_logs (salon_id, actor_admin_id, action, payload_json) VALUES ($1,$2,'admin_block_slot',$3)",
        [salonId, req.admin!.adminId, JSON.stringify({ slotStart: slotStart.toISOString() })]
      );
    });
  } catch (error: any) {
    if (error?.code === "23505") return res.status(409).json({ message: "Этот слот уже занят" });
    throw error;
  }
  res.status(201).json({ ok: true, id: blockId, slotStartAt: slotStart.toISOString(), slotEndAt: slotEnd.toISOString() });
});

app.delete("/admin/slots/block/:id", adminOnly, async (req: AuthedRequest, res) => {
  const salonId = req.admin!.salonId;
  const apptId = req.params.id;
  const row = await pool.query(
    "SELECT id FROM appointments WHERE id = $1 AND salon_id = $2 AND status = 'booked' AND is_admin_block = true",
    [apptId, salonId]
  );
  if (!row.rowCount) return res.status(404).json({ message: "Блокировка не найдена" });
  await withTx(async (client) => {
    await client.query(
      "UPDATE appointments SET status='cancelled', cancelled_at=now(), cancelled_by='admin' WHERE id=$1",
      [apptId]
    );
    await client.query(
      "INSERT INTO audit_logs (salon_id, actor_admin_id, action, payload_json) VALUES ($1,$2,'admin_unblock_slot',$3)",
      [salonId, req.admin!.adminId, JSON.stringify({ appointmentId: apptId })]
    );
  });
  res.json({ ok: true });
});

app.get("/admin/appointments", adminOnly, async (req: AuthedRequest, res) => {
  const date = String(req.query.date ?? "");
  if (!date) {
    return res.status(400).json({ message: "date query required" });
  }
  const result = await pool.query(
    `SELECT id, client_name, client_phone, source, status, start_at, end_at, is_admin_block
     FROM appointments
     WHERE salon_id = $1
       AND status = 'booked'
       AND date(start_at at time zone 'UTC') = $2::date
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
  scanAndNotify().catch((error) => console.error("initial reminder scan failed", error));
  setInterval(() => {
    scanAndNotify().catch((error) => console.error("reminder scan failed", error));
  }, 60_000);
});
