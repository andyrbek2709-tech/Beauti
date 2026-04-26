const slotsEl = document.getElementById("slots");
const selectedSlotEl = document.getElementById("selectedSlot");
const bookMsg = document.getElementById("bookMsg");
const availabilityMsg = document.getElementById("availabilityMsg");

let selectedSlot = null;
const today = new Date();
const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
document.getElementById("fromDate").value = today.toISOString().slice(0, 10);
document.getElementById("toDate").value = in30Days.toISOString().slice(0, 10);
const params = new URLSearchParams(window.location.search);
const salonIdFromQuery = params.get("salonId");
if (salonIdFromQuery) {
  document.getElementById("salonId").value = salonIdFromQuery;
}

document.getElementById("loadSlots").addEventListener("click", async () => {
  const salonId = document.getElementById("salonId").value.trim();
  const from = document.getElementById("fromDate").value;
  const to = document.getElementById("toDate").value;
  if (!salonId || !from || !to) {
    availabilityMsg.textContent = "Заполните salon id и период дат";
    availabilityMsg.className = "err";
    return;
  }
  availabilityMsg.textContent = "Загрузка...";
  availabilityMsg.className = "muted";
  const resp = await fetch(`/availability?salonId=${encodeURIComponent(salonId)}&from=${from}&to=${to}`);
  const data = await resp.json();
  slotsEl.innerHTML = "";
  selectedSlot = null;
  selectedSlotEl.textContent = "не выбран";
  const availableSlots = (data.slots || []).filter((s) => s.available);
  for (const slot of availableSlots) {
    const btn = document.createElement("button");
    btn.className = "slot";
    btn.textContent = new Date(slot.startAt).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    btn.onclick = () => {
      selectedSlot = slot.startAt;
      for (const el of slotsEl.querySelectorAll(".slot")) el.classList.remove("selected");
      btn.classList.add("selected");
      selectedSlotEl.textContent = btn.textContent;
    };
    slotsEl.appendChild(btn);
  }
  availabilityMsg.textContent = `Доступно слотов: ${availableSlots.length}`;
  availabilityMsg.className = "ok";
});

document.getElementById("bookBtn").addEventListener("click", async () => {
  const salonId = document.getElementById("salonId").value.trim();
  const clientName = document.getElementById("clientName").value.trim();
  const clientPhone = document.getElementById("clientPhone").value.trim();
  if (!salonId || !clientName || !clientPhone || !selectedSlot) {
    bookMsg.textContent = "Заполните данные и выберите время";
    bookMsg.className = "err";
    return;
  }
  const requestId = crypto.randomUUID();
  const resp = await fetch("/book", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      salonId,
      clientName,
      clientPhone,
      source: "web",
      requestId,
      slotStartAt: selectedSlot
    })
  });
  const data = await resp.json();
  if (!resp.ok) {
    bookMsg.textContent = data.code === "slot_unavailable" ? "Этот слот уже занят. Выберите другое время." : (data.message || "Ошибка записи");
    bookMsg.className = "err";
    return;
  }
  bookMsg.textContent = `Успешно! Номер записи: ${data.id}`;
  bookMsg.className = "ok";
});
