let token = localStorage.getItem("adminToken") || "";
const authMsg = document.getElementById("authMsg");
const registerMsg = document.getElementById("registerMsg");
const integrationMsg = document.getElementById("integrationMsg");
const settingsMsg = document.getElementById("settingsMsg");
const rulesMsg = document.getElementById("rulesMsg");
const exceptionsMsg = document.getElementById("exceptionsMsg");
const appointmentsMsg = document.getElementById("appointmentsMsg");
const inviteMsg = document.getElementById("inviteMsg");
const integrationCheckMsg = document.getElementById("integrationCheckMsg");
const integrationChecklistMsg = document.getElementById("integrationChecklistMsg");
const weeklyRulesEl = document.getElementById("weeklyRules");
const weekdayNames = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

function showTab(tab) {
  document.getElementById("loginCard").classList.toggle("hidden", tab !== "login");
  document.getElementById("registerCard").classList.toggle("hidden", tab !== "register");
}

document.getElementById("tabLogin").onclick = () => showTab("login");
document.getElementById("tabRegister").onclick = () => showTab("register");

function authHeader() {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function showIntegrationIfAuthed() {
  if (!token) return;
  const resp = await fetch("/admin/profile", { headers: { authorization: `Bearer ${token}` } });
  if (resp.ok) {
    showAdminPanels();
    authMsg.textContent = "Вы вошли. Можно настраивать Telegram.";
    authMsg.className = "ok";
    const profile = await resp.json();
    if (profile.settings) {
      document.getElementById("slotDuration").value = String(profile.settings.slot_duration_minutes ?? 30);
      document.getElementById("horizonDays").value = String(profile.settings.booking_horizon_days ?? 14);
      document.getElementById("cutoffHours").value = String(profile.settings.cancel_cutoff_hours ?? 2);
      document.getElementById("timezone").value = String(profile.settings.timezone ?? "Europe/Moscow");
    }
    if (profile.telegramIntegration) {
      document.getElementById("telegramUserId").value = profile.telegramIntegration.telegram_user_id || "";
    }
  }
}

function minuteToHHMM(value) {
  const h = Math.floor(value / 60).toString().padStart(2, "0");
  const m = (value % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function hhmmToMinute(value) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function buildWeeklyRuleEditor() {
  weeklyRulesEl.innerHTML = "";
  for (let weekday = 1; weekday <= 6; weekday += 1) {
    const row = document.createElement("div");
    row.className = "day-row";
    row.innerHTML = `
      <div>
        <label>${weekdayNames[weekday]}</label>
      </div>
      <div>
        <label>С</label>
        <input type="time" id="day-start-${weekday}" value="10:00" />
      </div>
      <div>
        <label>До</label>
        <input type="time" id="day-end-${weekday}" value="18:00" />
      </div>
      <label class="checkbox-wrap">
        <input type="checkbox" id="day-active-${weekday}" checked />
        Активен
      </label>
    `;
    weeklyRulesEl.appendChild(row);
  }
}

document.getElementById("loginBtn").onclick = async () => {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value.trim();
  const resp = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const data = await resp.json();
  if (!resp.ok) {
    authMsg.textContent = data.message || "Ошибка входа";
    authMsg.className = "err";
    return;
  }
  token = data.token;
  localStorage.setItem("adminToken", token);
  authMsg.textContent = "Успешный вход";
  authMsg.className = "ok";
  showAdminPanels();
};

document.getElementById("registerBtn").onclick = async () => {
  const salonName = document.getElementById("regSalonName").value.trim();
  const email = document.getElementById("regEmail").value.trim();
  const password = document.getElementById("regPassword").value.trim();
  const resp = await fetch("/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ salonName, email, password })
  });
  const data = await resp.json();
  if (!resp.ok) {
    registerMsg.textContent = data.message || "Ошибка регистрации";
    registerMsg.className = "err";
    return;
  }
  token = data.token;
  localStorage.setItem("adminToken", token);
  registerMsg.textContent = `Салон создан. salonId: ${data.salonId}`;
  registerMsg.className = "ok";
  showAdminPanels();
};

document.getElementById("acceptInviteBtn").onclick = async () => {
  const payload = {
    inviteToken: document.getElementById("inviteToken").value.trim(),
    salonName: document.getElementById("inviteSalonName").value.trim(),
    salonSlug: document.getElementById("inviteSalonSlug").value.trim() || undefined,
    email: document.getElementById("inviteEmail").value.trim(),
    password: document.getElementById("invitePassword").value.trim(),
    telegramBotToken: document.getElementById("inviteBotToken").value.trim(),
    telegramUserId: document.getElementById("inviteTelegramUserId").value.trim()
  };
  const resp = await fetch("/auth/accept-invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!resp.ok) {
    inviteMsg.textContent = data.message || "Ошибка активации";
    inviteMsg.className = "err";
    return;
  }
  token = data.token;
  localStorage.setItem("adminToken", token);
  inviteMsg.textContent = `Салон активирован: ${data.salonSlug}. Подключаем Telegram...`;
  inviteMsg.className = "ok";
  const telegramBotToken = payload.telegramBotToken;
  const telegramUserId = payload.telegramUserId;
  document.getElementById("botToken").value = telegramBotToken;
  document.getElementById("telegramUserId").value = telegramUserId;
  enterAdminMode();
  showAdminPanels();
  const setupOk = await runTelegramAutoSetup(telegramBotToken, telegramUserId, true);
  if (!setupOk) return;
  token = "";
  localStorage.removeItem("adminToken");
  document.getElementById("loginEmail").value = payload.email;
  document.getElementById("loginPassword").value = "";
  inviteMsg.textContent = "Активация завершена. Telegram подключен. Теперь войдите в админку.";
  inviteMsg.className = "ok";
  enterLoginMode();
};

document.getElementById("saveTelegramBtn").onclick = async () => {
  const telegramBotToken = document.getElementById("botToken").value.trim();
  const telegramUserId = document.getElementById("telegramUserId").value.trim();
  const resp = await fetch("/admin/integration/telegram", {
    method: "PUT",
    headers: authHeader(),
    body: JSON.stringify({ telegramBotToken, telegramUserId })
  });
  const data = await resp.json();
  if (!resp.ok) {
    integrationMsg.textContent = data.message || "Ошибка сохранения";
    integrationMsg.className = "err";
    return;
  }
  integrationMsg.textContent = "Интеграция Telegram сохранена";
  integrationMsg.className = "ok";
  const fullWebhook = `${window.location.origin}${data.webhookPath}`;
  document.getElementById("webhookPath").value = fullWebhook;
  document.getElementById("webhookSecret").value = data.webhookSecret || "";
};

document.getElementById("autoSetupTelegramBtn").onclick = async () => {
  const telegramBotToken = document.getElementById("botToken").value.trim();
  const telegramUserId = document.getElementById("telegramUserId").value.trim();
  const setupOk = await runTelegramAutoSetup(telegramBotToken, telegramUserId, false);
  if (setupOk) showAdminPanels();
};

document.getElementById("checkTelegramBtn").onclick = async () => {
  const resp = await fetch("/admin/integration/telegram/check", {
    headers: { authorization: `Bearer ${token}` }
  });
  const data = await resp.json();
  if (!resp.ok) {
    integrationCheckMsg.textContent = data.message || "Проверка не прошла";
    integrationCheckMsg.className = "err";
    return;
  }
  integrationCheckMsg.textContent = data.isWebhookCorrect
    ? `Все хорошо. Бот @${data.botUsername || "unknown"} подключен правильно.`
    : `Бот найден, но адрес подключения отличается. Ожидается: ${data.expectedWebhookUrl}`;
  integrationCheckMsg.className = data.isWebhookCorrect ? "ok" : "err";
};

document.getElementById("copySupportTemplateBtn").onclick = async () => {
  const botToken = document.getElementById("botToken").value.trim();
  const telegramUserId = document.getElementById("telegramUserId").value.trim();
  const webhookPath = document.getElementById("webhookPath").value.trim();
  const webhookSecret = document.getElementById("webhookSecret").value.trim();

  const maskedToken = botToken
    ? `${botToken.slice(0, 8)}...${botToken.slice(-6)}`
    : "не заполнен";

  const text = [
    "Здравствуйте, нужна помощь с подключением Telegram-бота.",
    "",
    `Email админа: ${document.getElementById("loginEmail").value.trim() || "не указан"}`,
    `Telegram User ID: ${telegramUserId || "не заполнен"}`,
    `Bot Token (маска): ${maskedToken}`,
    `Webhook Path: ${webhookPath || "не заполнен"}`,
    `Webhook Secret (маска): ${webhookSecret ? `${webhookSecret.slice(0, 6)}...` : "не заполнен"}`,
    "",
    "Проблема:",
    "- что именно не работает (подключение / проверка / сообщения не доходят).",
    "- когда началось.",
    "- какие шаги уже пробовали."
  ].join("\n");

  await navigator.clipboard.writeText(text);
  integrationCheckMsg.textContent = "Шаблон для поддержки скопирован";
  integrationCheckMsg.className = "ok";
};

document.getElementById("checkAllTelegramBtn").onclick = async () => {
  const issues = [];
  const botToken = document.getElementById("botToken").value.trim();
  const telegramUserId = document.getElementById("telegramUserId").value.trim();

  if (!botToken) issues.push("Не заполнен Bot Token.");
  if (!telegramUserId) issues.push("Не заполнен Telegram User ID.");
  if (!token) issues.push("Вы не вошли в аккаунт админа.");

  if (issues.length) {
    integrationChecklistMsg.textContent = `Нужно исправить: ${issues.join(" ")}`;
    integrationChecklistMsg.className = "err";
    return;
  }

  const checkResp = await fetch("/admin/integration/telegram/check", {
    headers: { authorization: `Bearer ${token}` }
  });
  const checkData = await checkResp.json();

  if (!checkResp.ok) {
    integrationChecklistMsg.textContent = `Проверка не пройдена: ${checkData.message || "неизвестная ошибка"}`;
    integrationChecklistMsg.className = "err";
    return;
  }

  if (!checkData.isWebhookCorrect) {
    integrationChecklistMsg.textContent =
      "Бот найден, но адрес подключения отличается. Нажмите 'Подключить бота автоматически', затем повторите проверку.";
    integrationChecklistMsg.className = "err";
    return;
  }

  integrationChecklistMsg.textContent = "Готово к работе: бот подключен и проверка пройдена.";
  integrationChecklistMsg.className = "ok";
};

document.getElementById("saveSettingsBtn").onclick = async () => {
  const payload = {
    slotDurationMinutes: Number(document.getElementById("slotDuration").value),
    bookingHorizonDays: Number(document.getElementById("horizonDays").value),
    cancelCutoffHours: Number(document.getElementById("cutoffHours").value),
    timezone: document.getElementById("timezone").value.trim()
  };
  const resp = await fetch("/admin/settings", {
    method: "PUT",
    headers: authHeader(),
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!resp.ok) {
    settingsMsg.textContent = data.message || "Ошибка сохранения настроек";
    settingsMsg.className = "err";
    return;
  }
  settingsMsg.textContent = "Настройки сохранены";
  settingsMsg.className = "ok";
};

document.getElementById("saveRulesBtn").onclick = async () => {
  try {
    const rules = [];
    for (let weekday = 1; weekday <= 6; weekday += 1) {
      const isActive = document.getElementById(`day-active-${weekday}`).checked;
      const startTime = document.getElementById(`day-start-${weekday}`).value;
      const endTime = document.getElementById(`day-end-${weekday}`).value;
      if (!isActive) {
        rules.push({ weekday, startMinute: 600, endMinute: 1080, isActive: false });
        continue;
      }
      const startMinute = hhmmToMinute(startTime);
      const endMinute = hhmmToMinute(endTime);
      if (startMinute >= endMinute) {
        throw new Error(`Некорректный диапазон у "${weekdayNames[weekday]}"`);
      }
      rules.push({ weekday, startMinute, endMinute, isActive: true });
    }
    const resp = await fetch("/admin/working-rules", {
      method: "PUT",
      headers: authHeader(),
      body: JSON.stringify({ rules })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || "Ошибка сохранения правил");
    rulesMsg.textContent = "Рабочие правила сохранены";
    rulesMsg.className = "ok";
  } catch (error) {
    rulesMsg.textContent = error.message || "Проверьте формат правил";
    rulesMsg.className = "err";
  }
};

document.getElementById("saveExceptionsBtn").onclick = async () => {
  try {
    const lines = document.getElementById("exceptionsText").value.split("\n").map((x) => x.trim()).filter(Boolean);
    const exceptions = lines.map((line) => {
      const [date, isClosedRaw, startRaw, endRaw] = line.split(",").map((v) => v.trim());
      return {
        date,
        isClosed: isClosedRaw === "true",
        customStartMinute: startRaw ? Number(startRaw) : null,
        customEndMinute: endRaw ? Number(endRaw) : null
      };
    });
    const resp = await fetch("/admin/exceptions", {
      method: "PUT",
      headers: authHeader(),
      body: JSON.stringify({ exceptions })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || "Ошибка сохранения исключений");
    exceptionsMsg.textContent = "Исключения сохранены";
    exceptionsMsg.className = "ok";
  } catch (error) {
    exceptionsMsg.textContent = error.message || "Проверьте формат исключений";
    exceptionsMsg.className = "err";
  }
};

document.getElementById("loadAppointmentsBtn").onclick = async () => {
  const date = document.getElementById("appointmentsDate").value;
  if (!date) {
    appointmentsMsg.textContent = "Выберите дату";
    appointmentsMsg.className = "err";
    return;
  }
  const resp = await fetch(`/admin/appointments?date=${encodeURIComponent(date)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const data = await resp.json();
  if (!resp.ok) {
    appointmentsMsg.textContent = data.message || "Ошибка загрузки записей";
    appointmentsMsg.className = "err";
    return;
  }
  appointmentsMsg.textContent = `Записей: ${data.count}`;
  appointmentsMsg.className = "ok";
  const list = document.getElementById("appointmentsList");
  list.innerHTML = "";
  for (const item of data.items) {
    const card = document.createElement("div");
    card.className = "card";
    const time = new Date(item.start_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    card.innerHTML = `<strong>${time}</strong><div class="muted">${item.client_name} (${item.client_phone}) - ${item.source}</div>`;
    list.appendChild(card);
  }
};

function showAdminPanels() {
  document.getElementById("integrationCard").classList.remove("hidden");
  document.getElementById("settingsCard").classList.remove("hidden");
  document.getElementById("rulesCard").classList.remove("hidden");
  document.getElementById("exceptionsCard").classList.remove("hidden");
  document.getElementById("appointmentsCard").classList.remove("hidden");
  document.getElementById("appointmentsDate").value = new Date().toISOString().slice(0, 10);
  buildWeeklyRuleEditor();
}

function enterInviteMode() {
  document.getElementById("authHeaderCard").classList.add("hidden");
  document.getElementById("loginCard").classList.add("hidden");
  document.getElementById("registerCard").classList.add("hidden");
  document.getElementById("inviteCard").classList.remove("hidden");
}

function enterAdminMode() {
  document.getElementById("authHeaderCard").classList.add("hidden");
  document.getElementById("loginCard").classList.add("hidden");
  document.getElementById("registerCard").classList.add("hidden");
  document.getElementById("inviteCard").classList.add("hidden");
}

function enterLoginMode() {
  document.getElementById("authHeaderCard").classList.remove("hidden");
  document.getElementById("loginCard").classList.remove("hidden");
  document.getElementById("registerCard").classList.add("hidden");
  document.getElementById("inviteCard").classList.add("hidden");
  document.getElementById("integrationCard").classList.add("hidden");
  document.getElementById("settingsCard").classList.add("hidden");
  document.getElementById("rulesCard").classList.add("hidden");
  document.getElementById("exceptionsCard").classList.add("hidden");
  document.getElementById("appointmentsCard").classList.add("hidden");
}

async function runTelegramAutoSetup(telegramBotToken, telegramUserId, silent) {
  const resp = await fetch("/admin/integration/telegram/auto-setup", {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify({ telegramBotToken, telegramUserId })
  });
  const data = await resp.json();
  if (!resp.ok) {
    integrationMsg.textContent = data.message || "Ошибка автонастройки";
    integrationMsg.className = "err";
    return false;
  }
  integrationMsg.textContent = silent
    ? "Салон активирован и бот подключен автоматически"
    : "Бот подключен автоматически";
  integrationMsg.className = "ok";
  document.getElementById("webhookPath").value = data.webhookUrl || "";
  document.getElementById("webhookSecret").value = data.webhookSecret || "";
  return true;
}

function preloadRulesFromText() {
  const defaults = [
    { weekday: 1, startMinute: 600, endMinute: 1080 },
    { weekday: 2, startMinute: 600, endMinute: 1080 },
    { weekday: 3, startMinute: 600, endMinute: 1080 },
    { weekday: 4, startMinute: 600, endMinute: 1080 },
    { weekday: 5, startMinute: 600, endMinute: 1080 }
  ];
  for (const rule of defaults) {
    const active = document.getElementById(`day-active-${rule.weekday}`);
    const start = document.getElementById(`day-start-${rule.weekday}`);
    const end = document.getElementById(`day-end-${rule.weekday}`);
    if (active && start && end) {
      active.checked = true;
      start.value = minuteToHHMM(rule.startMinute);
      end.value = minuteToHHMM(rule.endMinute);
    }
  }
}

buildWeeklyRuleEditor();
preloadRulesFromText();
showIntegrationIfAuthed();

const params = new URLSearchParams(window.location.search);
const inviteToken = params.get("invite");
if (inviteToken) {
  enterInviteMode();
  document.getElementById("inviteToken").value = inviteToken;
}
