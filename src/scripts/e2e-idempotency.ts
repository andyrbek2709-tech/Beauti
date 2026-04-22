import crypto from "node:crypto";

type Slot = { startAt: string; endAt: string; available: boolean };

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const salonId = process.env.SALON_ID ?? "";

if (!salonId) {
  console.error("SALON_ID is required. Example: SALON_ID=<id> npm run test:e2e:idempotency");
  process.exit(1);
}

async function main(): Promise<void> {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const availabilityResp = await fetch(
    `${baseUrl}/availability?salonId=${encodeURIComponent(salonId)}&from=${from}&to=${to}`
  );
  if (!availabilityResp.ok) throw new Error(`availability request failed: ${availabilityResp.status}`);
  const availabilityData = await availabilityResp.json();
  const targetSlot: Slot | undefined = (availabilityData.slots ?? []).find((s: Slot) => s.available);
  if (!targetSlot) throw new Error("no available slots for test");

  const requestId = crypto.randomUUID();
  const payload = {
    salonId,
    clientName: "Idempotency User",
    clientPhone: "+70000000999",
    source: "web",
    requestId,
    slotStartAt: targetSlot.startAt
  };

  const firstResp = await fetch(`${baseUrl}/book`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const firstBody = await firstResp.json();
  if (firstResp.status !== 201) {
    throw new Error(`first request failed: ${firstResp.status} ${JSON.stringify(firstBody)}`);
  }

  const secondResp = await fetch(`${baseUrl}/book`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const secondBody = await secondResp.json();
  if (secondResp.status !== 201) {
    throw new Error(`second request should be idempotent 201, got: ${secondResp.status} ${JSON.stringify(secondBody)}`);
  }

  if (!firstBody.id || firstBody.id !== secondBody.id) {
    throw new Error("idempotency failed: repeated request returned a different booking id");
  }

  await fetch(`${baseUrl}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      salonId,
      appointmentId: firstBody.id,
      requestId: crypto.randomUUID(),
      actor: "admin"
    })
  });

  console.log("PASSED: idempotency works, duplicate request returned same booking.");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
