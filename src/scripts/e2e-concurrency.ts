import crypto from "node:crypto";

type Slot = {
  startAt: string;
  endAt: string;
  available: boolean;
};

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const salonId = process.env.SALON_ID ?? "";
const parallelAttempts = Number(process.env.PARALLEL_ATTEMPTS ?? 10);

if (!salonId) {
  console.error("SALON_ID is required. Example: SALON_ID=<id> npm run test:e2e:race");
  process.exit(1);
}

async function main(): Promise<void> {
  const from = new Date().toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const to = toDate.toISOString().slice(0, 10);

  const availabilityResp = await fetch(
    `${baseUrl}/availability?salonId=${encodeURIComponent(salonId)}&from=${from}&to=${to}`
  );
  if (!availabilityResp.ok) {
    throw new Error(`availability request failed: ${availabilityResp.status}`);
  }
  const availabilityData = await availabilityResp.json();
  const slots: Slot[] = availabilityData.slots ?? [];
  const targetSlot = slots.find((slot) => slot.available);
  if (!targetSlot) {
    throw new Error("no available slots for test");
  }

  const requests = Array.from({ length: parallelAttempts }, (_, index) => {
    const requestId = crypto.randomUUID();
    return fetch(`${baseUrl}/book`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        salonId,
        clientName: `E2E User ${index + 1}`,
        clientPhone: `+70000000${String(index).padStart(2, "0")}`,
        source: "web",
        requestId,
        slotStartAt: targetSlot.startAt
      })
    });
  });

  const results = await Promise.all(requests);
  const payloads = await Promise.all(results.map(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })));

  const success = payloads.filter((x) => x.status === 201);
  const conflicts = payloads.filter((x) => x.status === 409);
  const others = payloads.filter((x) => x.status !== 201 && x.status !== 409);

  console.log(`Target slot: ${targetSlot.startAt}`);
  console.log(`Attempts: ${parallelAttempts}`);
  console.log(`Success: ${success.length}`);
  console.log(`Conflicts: ${conflicts.length}`);
  console.log(`Other statuses: ${others.length}`);

  if (success.length !== 1) {
    console.error("FAILED: expected exactly one successful booking.");
    process.exit(1);
  }
  if (conflicts.length < 1) {
    console.error("FAILED: expected at least one 409 conflict.");
    process.exit(1);
  }
  if (others.length > 0) {
    console.error("FAILED: unexpected statuses found.");
    console.error(JSON.stringify(others, null, 2));
    process.exit(1);
  }

  const bookingId = success[0].body?.id;
  if (bookingId) {
    await fetch(`${baseUrl}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        salonId,
        appointmentId: bookingId,
        requestId: crypto.randomUUID(),
        actor: "admin"
      })
    });
  }

  console.log("PASSED: concurrency protection is working.");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
