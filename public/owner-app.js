const msg = document.getElementById("ownerMsg");
const invitesMsg = document.getElementById("invitesMsg");
const invitesList = document.getElementById("invitesList");
const statsMsg = document.getElementById("statsMsg");
const statsGrid = document.getElementById("statsGrid");
const healthMsg = document.getElementById("healthMsg");
const healthGrid = document.getElementById("healthGrid");

function statusLabel(status) {
  if (status === "used") return "Использован";
  if (status === "expired") return "Истек";
  if (status === "revoked") return "Отозван";
  return "Активен";
}

async function revokeInvite(token) {
  const platformKey = document.getElementById("platformKey").value.trim();
  if (!platformKey) {
    msg.textContent = "Введите platform key";
    msg.className = "err";
    return;
  }
  const resp = await fetch(`/platform/invites/${encodeURIComponent(token)}/revoke`, {
    method: "POST",
    headers: { "x-platform-key": platformKey }
  });
  const data = await resp.json();
  if (!resp.ok) {
    msg.textContent = data.message || "Не удалось отозвать инвайт";
    msg.className = "err";
    return;
  }
  msg.textContent = `Инвайт ${token} отозван`;
  msg.className = "ok";
  await loadInvites();
}

async function loadInvites() {
  const platformKey = document.getElementById("platformKey").value.trim();
  if (!platformKey) {
    invitesMsg.textContent = "Введите platform key и нажмите Обновить";
    invitesMsg.className = "err";
    return;
  }
  const resp = await fetch("/platform/invites", {
    headers: { "x-platform-key": platformKey }
  });
  const data = await resp.json();
  if (!resp.ok) {
    invitesMsg.textContent = data.message || "Ошибка загрузки инвайтов";
    invitesMsg.className = "err";
    return;
  }
  const statusFilter = document.getElementById("statusFilter").value;
  const searchFilter = document.getElementById("searchFilter").value.trim().toLowerCase();
  const filtered = data.items.filter((item) => {
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (!searchFilter) return true;
    const hay = `${item.token} ${item.note || ""}`.toLowerCase();
    return hay.includes(searchFilter);
  });

  invitesList.innerHTML = "";
  for (const item of filtered) {
    const card = document.createElement("div");
    card.className = "card";
    const absoluteUrl = `${window.location.origin}${item.inviteUrl}`;
    const usedInfo = item.usedAt ? `<div class="muted">usedAt: ${new Date(item.usedAt).toLocaleString("ru-RU")}</div>` : "";
    const revokedInfo = item.revokedAt ? `<div class="muted">revokedAt: ${new Date(item.revokedAt).toLocaleString("ru-RU")}</div>` : "";
    const salonInfo = item.usedBySalonId ? `<div class="muted">salonId: ${item.usedBySalonId}</div>` : "";
    card.innerHTML = `
      <div><strong>${statusLabel(item.status)}</strong></div>
      <div class="muted">token: ${item.token}</div>
      <div class="muted">expires: ${new Date(item.expiresAt).toLocaleString("ru-RU")}</div>
      ${item.note ? `<div class="muted">note: ${item.note}</div>` : ""}
      ${usedInfo}
      ${revokedInfo}
      ${salonInfo}
      <div class="muted">link: ${absoluteUrl}</div>
    `;
    if (item.status === "active") {
      const revokeBtn = document.createElement("button");
      revokeBtn.className = "secondary";
      revokeBtn.textContent = "Отозвать инвайт";
      revokeBtn.onclick = () => revokeInvite(item.token);
      card.appendChild(revokeBtn);
    }
    invitesList.appendChild(card);
  }
  invitesMsg.textContent = `Инвайтов: ${filtered.length} из ${data.items.length}`;
  invitesMsg.className = "ok";
}

function metricCard(title, value) {
  return `<div class="card"><div class="muted">${title}</div><div><strong>${value}</strong></div></div>`;
}

async function loadStats() {
  const platformKey = document.getElementById("platformKey").value.trim();
  if (!platformKey) {
    statsMsg.textContent = "Введите platform key и нажмите Обновить";
    statsMsg.className = "err";
    return;
  }
  const resp = await fetch("/platform/stats", { headers: { "x-platform-key": platformKey } });
  const data = await resp.json();
  if (!resp.ok) {
    statsMsg.textContent = data.message || "Ошибка загрузки статистики";
    statsMsg.className = "err";
    return;
  }
  statsGrid.innerHTML = [
    metricCard("Салонов всего", data.salons.total),
    metricCard("Новых за 7 дней", data.salons.new_last_7_days),
    metricCard("Подписки trial", data.subscriptions.trial_count),
    metricCard("Подписки active", data.subscriptions.active_count),
    metricCard("Подписки past_due", data.subscriptions.past_due_count),
    metricCard("Инвайты active", data.invites.invites_active),
    metricCard("Инвайты used", data.invites.invites_used),
    metricCard("Инвайты revoked", data.invites.invites_revoked),
    metricCard("Записей всего (booked)", data.bookings.booked_total),
    metricCard("Записей за 30 дней", data.bookings.booked_last_30_days)
  ].join("");
  statsMsg.textContent = "Статистика обновлена";
  statsMsg.className = "ok";
}

async function loadHealth() {
  const resp = await fetch("/metrics");
  const data = await resp.json();
  if (!resp.ok) {
    healthMsg.textContent = "Не удалось получить технический статус";
    healthMsg.className = "err";
    return;
  }
  const c = data.counters || {};
  healthGrid.innerHTML = [
    metricCard("База данных", data.db || "unknown"),
    metricCard("HTTP запросов", c.http_requests_total ?? 0),
    metricCard("HTTP ошибок", c.http_errors_total ?? 0),
    metricCard("Успешных броней", c.book_success_total ?? 0),
    metricCard("Конфликтов броней", c.book_conflict_total ?? 0),
    metricCard("Успешных отмен", c.cancel_success_total ?? 0),
    metricCard("Telegram webhook", c.telegram_webhook_total ?? 0),
    metricCard("Дубликаты webhook", c.telegram_webhook_duplicate_total ?? 0)
  ].join("");
  healthMsg.textContent = `Проверено: ${new Date(data.now).toLocaleString("ru-RU")}`;
  healthMsg.className = "ok";
}

document.getElementById("createInviteBtn").onclick = async () => {
  const platformKey = document.getElementById("platformKey").value.trim();
  const ttlHours = Number(document.getElementById("ttlHours").value);
  const note = document.getElementById("note").value.trim();
  if (!platformKey) {
    msg.textContent = "Введите platform key";
    msg.className = "err";
    return;
  }
  const resp = await fetch("/platform/invites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-platform-key": platformKey
    },
    body: JSON.stringify({ ttlHours, note: note || undefined })
  });
  const data = await resp.json();
  if (!resp.ok) {
    msg.textContent = data.message || "Ошибка создания инвайта";
    msg.className = "err";
    return;
  }
  const absoluteUrl = `${window.location.origin}${data.inviteUrl}`;
  document.getElementById("inviteTokenOut").value = data.token;
  document.getElementById("inviteUrlOut").value = absoluteUrl;
  msg.textContent = "Инвайт создан";
  msg.className = "ok";
  await loadInvites();
};

document.getElementById("copyInviteBtn").onclick = async () => {
  const url = document.getElementById("inviteUrlOut").value;
  if (!url) {
    msg.textContent = "Сначала создайте инвайт";
    msg.className = "err";
    return;
  }
  await navigator.clipboard.writeText(url);
  msg.textContent = "Ссылка скопирована";
  msg.className = "ok";
};

document.getElementById("refreshInvitesBtn").onclick = async () => {
  await loadInvites();
};
document.getElementById("refreshStatsBtn").onclick = async () => {
  await loadStats();
};
document.getElementById("refreshHealthBtn").onclick = async () => {
  await loadHealth();
};

document.getElementById("statusFilter").onchange = () => {
  loadInvites().catch(() => {});
};
document.getElementById("searchFilter").oninput = () => {
  loadInvites().catch(() => {});
};
