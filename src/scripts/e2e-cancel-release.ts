import crypto from "node:crypto";

type Slot = { startAt: string; endAt: string; available: boolean };

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const salonId = process.env.SALON_ID ?? "";

if (!salonId) {
  console.error("SALON_ID is required. Example: SALON_ID=<id> npm run test:e2e:cancel-release");
  process.exit(1);
}

async function fetchAvailability(): Promise<Slot[]> {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const resp = await fetch(`${baseUrl}/availability?salonId=${encodeURIComponent(salonId)}&from=${from}&to=${to}`);
  if (!resp.ok) throw new Error(`availability failed: ${resp.status}`);
  const data = await resp.json();
  return data.slots ?? [];
}

async function main(): Promise<void> {
  const beforeSlots = await fetchAvailability();
  const slot = beforeSlots.find((s) => s.available);
  if (!slot) throw new Error("no available slot for test");

  const bookResp = await fetch(`${baseUrl}/book`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      salonId,
      clientName: "Cancel Release User",
      clientPhone: "+70000000888",
      source: "web",
      requestId: crypto.randomUUID(),
      slotStartAt: slot.startAt
    })
  });
  const bookData = await bookResp.json();
  if (bookResp.status !== 201 || !bookData.id) {
    throw new Error(`booking failed: ${bookResp.status} ${JSON.stringify(bookData)}`);
  }

  const afterBookSlots = await fetchAvailability();
  const sameSlotAfterBook = afterBookSlots.find((s) => s.startAt === slot.startAt);
  if (!sameSlotAfterBook || sameSlotAfterBook.available) {
    throw new Error("expected slot to be unavailable after booking");
  }

  const cancelResp = await fetch(`${baseUrl}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      salonId,
      appointmentId: bookData.id,
      requestId: crypto.randomUUID(),
      actor: "admin"
    })
  });
  const cancelData = await cancelResp.json();
  if (cancelResp.status !== 200) {
    throw new Error(`cancel failed: ${cancelResp.status} ${JSON.stringify(cancelData)}`);
  }

  const afterCancelSlots = await fetchAvailability();
  const sameSlotAfterCancel = afterCancelSlots.find((s) => s.startAt === slot.startAt);
  if (!sameSlotAfterCancel || !sameSlotAfterCancel.available) {
    throw new Error("expected slot to become available after cancel");
  }

  console.log("PASSED: cancel releases slot and makes it available again.");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
