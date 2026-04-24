import dayjs from "dayjs";
import crypto from "node:crypto";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { PoolClient } from "pg";
import { config } from "../config";
import { withTx } from "../db";
import { BookingSource } from "../types";
import { trackEvent } from "./controlTower";

dayjs.extend(utc);
dayjs.extend(timezone);

export interface SlotView {
  startAt: string;
  endAt: string;
  available: boolean;
}

export async function getAvailability(masterId: string, from: string, to: string): Promise<SlotView[]> {
  const fromDate = dayjs.tz(from, config.timezone);
  const toDate = dayjs.tz(to, config.timezone);
  const maxTo = dayjs().tz(config.timezone).startOf("day").add(config.bookingHorizonDays, "day");
  const boundedTo = toDate.isAfter(maxTo) ? maxTo : toDate;

  const settingsRow = await withTx(async (client) => {
    const res = await client.query(
      "SELECT slot_duration_minutes, booking_horizon_days, timezone FROM master_settings WHERE master_id = $1",
      [masterId]
    );
    if (!res.rowCount) {
      throw new Error("master_settings not configured");
    }
    return res.rows[0];
  });

  const slotDuration = Number(settingsRow.slot_duration_minutes);
  const rulesRes = await withTx((client) =>
    client.query(
      "SELECT weekday, start_minute, end_minute, is_active FROM working_rules WHERE master_id = $1 AND is_active = true",
      [masterId]
    )
  );
  const exRes = await withTx((client) =>
    client.query(
      "SELECT date::text, is_closed, custom_start_minute, custom_end_minute FROM schedule_exceptions WHERE master_id = $1",
      [masterId]
    )
  );
  const apptRes = await withTx((client) =>
    client.query(
      "SELECT start_at, end_at FROM appointments WHERE master_id = $1 AND status = 'booked' AND start_at >= $2 AND start_at < $3",
      [masterId, fromDate.utc().toDate(), boundedTo.utc().toDate()]
    )
  );

  const rulesByWeekday = new Map<number, { startMinute: number; endMinute: number }[]>();
  for (const r of rulesRes.rows) {
    const list = rulesByWeekday.get(Number(r.weekday)) ?? [];
    list.push({ startMinute: Number(r.start_minute), endMinute: Number(r.end_minute) });
    rulesByWeekday.set(Number(r.weekday), list);
  }

  const exByDate = new Map<string, { isClosed: boolean; customStartMinute: number | null; customEndMinute: number | null }>();
  for (const ex of exRes.rows) {
    exByDate.set(ex.date, {
      isClosed: Boolean(ex.is_closed),
      customStartMinute: ex.custom_start_minute === null ? null : Number(ex.custom_start_minute),
      customEndMinute: ex.custom_end_minute === null ? null : Number(ex.custom_end_minute)
    });
  }

  const occupied = new Set(apptRes.rows.map((r) => dayjs(r.start_at).toISOString()));
  const slots: SlotView[] = [];
  let cursor = fromDate.startOf("day");
  while (cursor.isBefore(boundedTo.endOf("day"))) {
    const weekday = cursor.day();
    const dateKey = cursor.format("YYYY-MM-DD");
    const exception = exByDate.get(dateKey);

    let windows = rulesByWeekday.get(weekday) ?? [];
    if (exception?.isClosed) {
      windows = [];
    } else if (exception && exception.customStartMinute !== null && exception.customEndMinute !== null) {
      windows = [{ startMinute: exception.customStartMinute, endMinute: exception.customEndMinute }];
    }

    for (const win of windows) {
      let minute = win.startMinute;
      while (minute + slotDuration <= win.endMinute) {
        const start = cursor.startOf("day").add(minute, "minute");
        const end = start.add(slotDuration, "minute");
        if (start.isAfter(dayjs())) {
          const startIso = start.utc().toISOString();
          slots.push({ startAt: startIso, endAt: end.utc().toISOString(), available: !occupied.has(startIso) });
        }
        minute += slotDuration;
      }
    }
    cursor = cursor.add(1, "day");
  }
  return slots;
}

export async function getAvailabilityForSalon(salonId: string, from: string, to: string): Promise<SlotView[]> {
  const fromDate = dayjs.tz(from, config.timezone);
  const toDate = dayjs.tz(to, config.timezone);
  const maxTo = dayjs().tz(config.timezone).startOf("day").add(config.bookingHorizonDays, "day");
  const boundedTo = toDate.isAfter(maxTo) ? maxTo : toDate;

  const settingsRes = await withTx((client) =>
    client.query(
      "SELECT slot_duration_minutes, booking_horizon_days, timezone FROM master_settings WHERE salon_id = $1",
      [salonId]
    )
  );
  if (!settingsRes.rowCount) {
    throw new Error("salon settings not configured");
  }
  const settings = settingsRes.rows[0];
  const slotDuration = Number(settings.slot_duration_minutes);
  const zone = String(settings.timezone || config.timezone);

  const rulesRes = await withTx((client) =>
    client.query(
      "SELECT weekday, start_minute, end_minute, is_active FROM working_rules WHERE salon_id = $1",
      [salonId]
    )
  );
  const exRes = await withTx((client) =>
    client.query(
      "SELECT date::text, is_closed, custom_start_minute, custom_end_minute FROM schedule_exceptions WHERE salon_id = $1",
      [salonId]
    )
  );
  const apptRes = await withTx((client) =>
    client.query(
      "SELECT start_at FROM appointments WHERE salon_id = $1 AND status = 'booked' AND start_at >= $2 AND start_at < $3",
      [salonId, fromDate.utc().toDate(), boundedTo.utc().toDate()]
    )
  );
  const pausesRes = await withTx((client) =>
    client.query(
      `SELECT start_date::text, end_date::text
       FROM booking_pauses
       WHERE salon_id = $1
         AND is_active = true
         AND start_date <= $3::date
         AND end_date >= $2::date`,
      [salonId, fromDate.format("YYYY-MM-DD"), boundedTo.format("YYYY-MM-DD")]
    )
  );
  const patternsRes = await withTx((client) =>
    client.query(
      `SELECT period_start::text, period_end::text, pattern_type, anchor_date::text
       FROM salon_work_patterns
       WHERE salon_id = $1
         AND is_active = true
         AND period_start <= $3::date
         AND period_end >= $2::date`,
      [salonId, fromDate.format("YYYY-MM-DD"), boundedTo.format("YYYY-MM-DD")]
    )
  );

  const rulesByWeekday = new Map<number, { startMinute: number; endMinute: number }[]>();
  for (const r of rulesRes.rows) {
    if (!Boolean(r.is_active)) continue;
    const list = rulesByWeekday.get(Number(r.weekday)) ?? [];
    list.push({ startMinute: Number(r.start_minute), endMinute: Number(r.end_minute) });
    rulesByWeekday.set(Number(r.weekday), list);
  }
  // Safety fallback: if no working rules configured, expose a default daily window.
  // This keeps booking available after reset/onboarding until the master sets a custom schedule.
  if (!rulesRes.rowCount) {
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      rulesByWeekday.set(weekday, [{ startMinute: 10 * 60, endMinute: 20 * 60 }]);
    }
  }

  const exByDate = new Map<string, { isClosed: boolean; customStartMinute: number | null; customEndMinute: number | null }>();
  for (const ex of exRes.rows) {
    exByDate.set(ex.date, {
      isClosed: Boolean(ex.is_closed),
      customStartMinute: ex.custom_start_minute === null ? null : Number(ex.custom_start_minute),
      customEndMinute: ex.custom_end_minute === null ? null : Number(ex.custom_end_minute)
    });
  }

  const occupied = new Set(apptRes.rows.map((r) => dayjs(r.start_at).toISOString()));
  const pausedDates = new Set<string>();
  for (const p of pausesRes.rows) {
    let d = dayjs(String(p.start_date));
    const end = dayjs(String(p.end_date));
    while (d.isBefore(end.add(1, "day"), "day")) {
      pausedDates.add(d.format("YYYY-MM-DD"));
      d = d.add(1, "day");
    }
  }
  const slots: SlotView[] = [];
  let cursor = fromDate.tz(zone).startOf("day");
  while (cursor.isBefore(boundedTo.tz(zone).endOf("day"))) {
    const weekday = cursor.day();
    const dateKey = cursor.format("YYYY-MM-DD");
    if (pausedDates.has(dateKey)) {
      cursor = cursor.add(1, "day");
      continue;
    }
    const dayPattern = patternsRes.rows.find((p) => {
      return dateKey >= String(p.period_start) && dateKey <= String(p.period_end);
    });
    if (dayPattern) {
      const dayNum = Number(dateKey.slice(-2));
      if (dayPattern.pattern_type === "even_dates" && dayNum % 2 !== 0) {
        cursor = cursor.add(1, "day");
        continue;
      }
      if (dayPattern.pattern_type === "odd_dates" && dayNum % 2 === 0) {
        cursor = cursor.add(1, "day");
        continue;
      }
      if (dayPattern.pattern_type === "every_other_day") {
        const anchor = dayjs(String(dayPattern.anchor_date || dayPattern.period_start));
        const diff = cursor.startOf("day").diff(anchor.startOf("day"), "day");
        if (diff % 2 !== 0) {
          cursor = cursor.add(1, "day");
          continue;
        }
      }
    }
    const exception = exByDate.get(dateKey);
    let windows = rulesByWeekday.get(weekday) ?? [];
    if (exception?.isClosed) {
      windows = [];
    } else if (exception && exception.customStartMinute !== null && exception.customEndMinute !== null) {
      windows = [{ startMinute: exception.customStartMinute, endMinute: exception.customEndMinute }];
    }

    for (const win of windows) {
      let minute = win.startMinute;
      while (minute + slotDuration <= win.endMinute) {
        const start = cursor.startOf("day").add(minute, "minute");
        const end = start.add(slotDuration, "minute");
        if (start.isAfter(dayjs())) {
          const startIso = start.utc().toISOString();
          slots.push({ startAt: startIso, endAt: end.utc().toISOString(), available: !occupied.has(startIso) });
        }
        minute += slotDuration;
      }
    }
    cursor = cursor.add(1, "day");
  }
  return slots;
}

export async function bookAppointment(params: {
  masterId: string;
  clientName: string;
  clientPhone: string;
  source: BookingSource;
  requestId: string;
  slotStartAt: string;
}): Promise<{ id: string; status: "booked" }> {
  return withTx(async (client) => {
    const idem = await getIdempotentResponse(client, params.requestId, "book");
    if (idem) {
      return idem as { id: string; status: "booked" };
    }

    const settings = await client.query(
      "SELECT slot_duration_minutes, booking_horizon_days FROM master_settings WHERE master_id = $1 FOR UPDATE",
      [params.masterId]
    );
    if (!settings.rowCount) {
      throw new Error("master_settings not configured");
    }
    const slotDuration = Number(settings.rows[0].slot_duration_minutes);
    const slotStart = dayjs(params.slotStartAt);
    const slotEnd = slotStart.add(slotDuration, "minute");
    const horizonEnd = dayjs().add(Number(settings.rows[0].booking_horizon_days), "day");
    if (slotStart.isAfter(horizonEnd)) {
      throw new Error("slot outside booking horizon");
    }
    if (slotStart.isBefore(dayjs())) {
      throw new Error("slot in the past");
    }

    const appointmentId = crypto.randomUUID();
    try {
      await client.query(
        `INSERT INTO appointments 
          (id, master_id, client_name, client_phone, source, status, start_at, end_at)
         VALUES ($1,$2,$3,$4,$5,'booked',$6,$7)`,
        [
          appointmentId,
          params.masterId,
          params.clientName,
          params.clientPhone,
          params.source,
          slotStart.toDate(),
          slotEnd.toDate()
        ]
      );
    } catch (error: any) {
      if (error?.code === "23505") {
        throw new ConflictError("slot_unavailable");
      }
      throw error;
    }

    const response = { id: appointmentId, status: "booked" as const };
    trackEvent("booking_created", { masterId: params.masterId, slotStartAt: params.slotStartAt, clientName: params.clientName, requestId: params.requestId, source: params.source });
    await saveIdempotentResponse(client, params.requestId, "book", response);
    return response;
  });
}

export async function cancelAppointment(params: {
  appointmentId: string;
  requestId: string;
  actor: "client" | "admin";
}): Promise<{ id: string; status: "cancelled" }> {
  return withTx(async (client) => {
    const idem = await getIdempotentResponse(client, params.requestId, "cancel");
    if (idem) {
      return idem as { id: string; status: "cancelled" };
    }

    const row = await client.query(
      "SELECT id, start_at, status FROM appointments WHERE id = $1 FOR UPDATE",
      [params.appointmentId]
    );
    if (!row.rowCount) {
      throw new Error("appointment not found");
    }
    if (row.rows[0].status === "cancelled") {
      const already = { id: params.appointmentId, status: "cancelled" as const };
      await saveIdempotentResponse(client, params.requestId, "cancel", already);
      return already;
    }

    const startsAt = dayjs(row.rows[0].start_at);
    if (params.actor === "client" && startsAt.diff(dayjs(), "hour", true) < config.cancelCutoffHours) {
      throw new Error("cancel cutoff reached");
    }

    await client.query(
      "UPDATE appointments SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE id = $1",
      [params.appointmentId, params.actor]
    );

    const response = { id: params.appointmentId, status: "cancelled" as const };
    trackEvent("booking_cancelled", { appointmentId: params.appointmentId, actor: params.actor });
    await saveIdempotentResponse(client, params.requestId, "cancel", response);
    return response;
  });
}

export async function getBooking(appointmentId: string): Promise<any> {
  return withTx(async (client) => {
    const row = await client.query(
      "SELECT id, master_id, client_name, client_phone, source, status, start_at, end_at FROM appointments WHERE id = $1",
      [appointmentId]
    );
    return row.rows[0] ?? null;
  });
}

export class ConflictError extends Error {}

export async function bookAppointmentForSalon(params: {
  salonId: string;
  clientName: string;
  clientPhone: string;
  clientTelegramUserId?: string;
  source: BookingSource;
  requestId: string;
  slotStartAt: string;
}): Promise<{ id: string; status: "booked" }> {
  return withTx(async (client) => {
    const idem = await getIdempotentResponseBySalon(client, params.requestId, params.salonId, "book");
    if (idem) return idem as { id: string; status: "booked" };

    const settings = await client.query(
      "SELECT slot_duration_minutes, booking_horizon_days FROM master_settings WHERE salon_id = $1 FOR UPDATE",
      [params.salonId]
    );
    if (!settings.rowCount) throw new Error("salon settings not configured");
    const slotDuration = Number(settings.rows[0].slot_duration_minutes);
    const slotStart = dayjs(params.slotStartAt);
    const slotEnd = slotStart.add(slotDuration, "minute");
    const horizonEnd = dayjs().add(Number(settings.rows[0].booking_horizon_days), "day");
    if (slotStart.isAfter(horizonEnd) || slotStart.isBefore(dayjs())) {
      throw new Error("slot outside allowed range");
    }
    const pauseRes = await client.query(
      `SELECT id
       FROM booking_pauses
       WHERE salon_id = $1
         AND is_active = true
         AND $2::date BETWEEN start_date AND end_date
       LIMIT 1`,
      [params.salonId, slotStart.format("YYYY-MM-DD")]
    );
    if (pauseRes.rowCount) {
      throw new Error("booking paused for this date");
    }
    const patternRes = await client.query(
      `SELECT period_start::text, period_end::text, pattern_type, anchor_date::text
       FROM salon_work_patterns
       WHERE salon_id = $1
         AND is_active = true
         AND $2::date BETWEEN period_start AND period_end
       LIMIT 1`,
      [params.salonId, slotStart.format("YYYY-MM-DD")]
    );
    if (patternRes.rowCount) {
      const p = patternRes.rows[0];
      const dayNum = Number(slotStart.format("DD"));
      if (p.pattern_type === "even_dates" && dayNum % 2 !== 0) throw new Error("date disabled by work pattern");
      if (p.pattern_type === "odd_dates" && dayNum % 2 === 0) throw new Error("date disabled by work pattern");
      if (p.pattern_type === "every_other_day") {
        const anchor = dayjs(String(p.anchor_date || p.period_start));
        const diff = slotStart.startOf("day").diff(anchor.startOf("day"), "day");
        if (diff % 2 !== 0) throw new Error("date disabled by work pattern");
      }
    }

    const appointmentId = crypto.randomUUID();
    try {
      await client.query(
        `INSERT INTO appointments
         (id, salon_id, client_name, client_phone, client_telegram_user_id, source, status, start_at, end_at)
         VALUES ($1,$2,$3,$4,$5,$6,'booked',$7,$8)`,
        [
          appointmentId,
          params.salonId,
          params.clientName,
          params.clientPhone,
          params.clientTelegramUserId ?? null,
          params.source,
          slotStart.toDate(),
          slotEnd.toDate()
        ]
      );
    } catch (error: any) {
      if (error?.code === "23505") throw new ConflictError("slot_unavailable");
      throw error;
    }
    const response = { id: appointmentId, status: "booked" as const };
    trackEvent("booking_created", { salonId: params.salonId, slotStartAt: params.slotStartAt, clientName: params.clientName, requestId: params.requestId, source: params.source, telegramUserId: params.clientTelegramUserId });
    await saveIdempotentResponseBySalon(client, params.requestId, params.salonId, "book", response);
    return response;
  });
}

export async function cancelAppointmentForSalon(params: {
  salonId: string;
  appointmentId: string;
  requestId: string;
  actor: "client" | "admin";
}): Promise<{ id: string; status: "cancelled" }> {
  return withTx(async (client) => {
    const idem = await getIdempotentResponseBySalon(client, params.requestId, params.salonId, "cancel");
    if (idem) return idem as { id: string; status: "cancelled" };
    const row = await client.query(
      "SELECT id, start_at, status FROM appointments WHERE id = $1 AND salon_id = $2 FOR UPDATE",
      [params.appointmentId, params.salonId]
    );
    if (!row.rowCount) throw new Error("appointment not found");
    if (row.rows[0].status === "cancelled") {
      const response = { id: params.appointmentId, status: "cancelled" as const };
      await saveIdempotentResponseBySalon(client, params.requestId, params.salonId, "cancel", response);
      return response;
    }
    if (params.actor === "client") {
      const settings = await client.query("SELECT cancel_cutoff_hours FROM master_settings WHERE salon_id = $1", [params.salonId]);
      const cutoff = Number(settings.rows[0]?.cancel_cutoff_hours ?? config.cancelCutoffHours);
      if (dayjs(row.rows[0].start_at).diff(dayjs(), "hour", true) < cutoff) throw new Error("cancel cutoff reached");
    }
    await client.query(
      "UPDATE appointments SET status='cancelled', cancelled_at=now(), cancelled_by=$3 WHERE id=$1 AND salon_id=$2",
      [params.appointmentId, params.salonId, params.actor]
    );
    const response = { id: params.appointmentId, status: "cancelled" as const };
    trackEvent("booking_cancelled", { salonId: params.salonId, appointmentId: params.appointmentId, actor: params.actor });
    await saveIdempotentResponseBySalon(client, params.requestId, params.salonId, "cancel", response);
    return response;
  });
}

export async function getBookingForSalon(salonId: string, appointmentId: string): Promise<any> {
  const row = await withTx((client) =>
    client.query(
      "SELECT id, salon_id, client_name, client_phone, source, status, start_at, end_at FROM appointments WHERE id = $1 AND salon_id = $2",
      [appointmentId, salonId]
    )
  );
  return row.rows[0] ?? null;
}

async function getIdempotentResponse(
  client: PoolClient,
  requestId: string,
  operation: "book" | "cancel"
): Promise<unknown | null> {
  const row = await client.query(
    "SELECT response_json FROM idempotency_keys WHERE request_id = $1 AND operation = $2",
    [requestId, operation]
  );
  if (!row.rowCount) {
    return null;
  }
  return row.rows[0].response_json;
}

async function saveIdempotentResponse(
  client: PoolClient,
  requestId: string,
  operation: "book" | "cancel",
  payload: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (request_id, operation, response_json)
     VALUES ($1,$2,$3)
     ON CONFLICT (request_id, operation) DO UPDATE SET response_json = EXCLUDED.response_json`,
    [requestId, operation, JSON.stringify(payload)]
  );
}

async function getIdempotentResponseBySalon(
  client: PoolClient,
  requestId: string,
  salonId: string,
  operation: "book" | "cancel"
): Promise<unknown | null> {
  const row = await client.query(
    "SELECT response_json FROM idempotency_keys WHERE request_id = $1 AND salon_id = $2 AND operation = $3",
    [requestId, salonId, operation]
  );
  return row.rowCount ? row.rows[0].response_json : null;
}

async function saveIdempotentResponseBySalon(
  client: PoolClient,
  requestId: string,
  salonId: string,
  operation: "book" | "cancel",
  payload: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (request_id, salon_id, operation, response_json)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (request_id, salon_id, operation)
     DO UPDATE SET response_json = EXCLUDED.response_json`,
    [requestId, salonId, operation, JSON.stringify(payload)]
  );
}
