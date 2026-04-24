// Control Tower integration — fire-and-forget, never throws
import { randomUUID } from "node:crypto";

const CT_URL = process.env.CONTROL_TOWER_API_URL;
const TENANT_ID = "tenant-main";
const PROJECT_ID = "beauty-booking";

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "x-tenant-id": TENANT_ID,
};

async function post(path: string, body: Record<string, unknown>): Promise<void> {
  if (!CT_URL) return;
  try {
    const res = await fetch(`${CT_URL}${path}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[CT] ${path} → HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[CT] ${path} error: ${(err as Error).message}`);
  }
}

export function trackEvent(
  eventType: string,
  payload: Record<string, unknown> = {}
): void {
  void post("/ingestion/events", {
    eventId: randomUUID(),
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    eventType,
    eventCategory: "product",
    occurredAt: new Date().toISOString(),
    userId: payload.telegramUserId
      ? String(payload.telegramUserId)
      : undefined,
    payload,
  });
}

export function trackTransaction(
  amount: number,
  currency = "KZT",
  payload: Record<string, unknown> = {}
): void {
  if (!amount || amount <= 0) return;
  void post("/ingestion/transactions", {
    transactionId: randomUUID(),
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    amount,
    currency,
    status: "succeeded",
    occurredAt: new Date().toISOString(),
    userId: payload.telegramUserId ? String(payload.telegramUserId) : undefined,
    payload,
  });
}
