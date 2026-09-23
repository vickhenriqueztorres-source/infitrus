const NOTIFICATIONS_KEY = "ifx_notifications_v1";
const LAST_NOTIFICATION_KEY = "ifx_last_notification_id";

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (value) => resolve(value || {})));
}

async function notifySignal(signal) {
  if (!signal?.id || !["CALL", "PUT"].includes(signal.direction)) return;
  const ageMs = Date.now() - Number(signal.recordedAt || 0);
  if (ageMs < 0 || ageMs > 5000 || Number(signal.validRemainingSec) <= 0) return;
  const stored = await getStorage([NOTIFICATIONS_KEY, LAST_NOTIFICATION_KEY]);
  if (stored[NOTIFICATIONS_KEY] === false || stored[LAST_NOTIFICATION_KEY] === signal.id) return;
  const arrow = signal.direction === "CALL" ? "▲" : "▼";
  await chrome.notifications.create(`inflitrus-${signal.id}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/icon-128.png"),
    title: `Señal interceptada · ${signal.direction} ${arrow}`,
    message: `${signal.asset} · ${signal.timeframe} · Válida por ${signal.validRemainingSec}s`,
    priority: 2,
  });
  chrome.storage.local.set({ [LAST_NOTIFICATION_KEY]: signal.id });
}

function updateBadge(message) {
  if (message.visualState === "SENAL" && message.signalPhase === "live") {
    chrome.action.setBadgeText({ text: "•" });
    chrome.action.setBadgeBackgroundColor({ color: "#3FE0C5" });
  } else if (message.visualState === "BLOQUEADO" || message.visualState === "CALIBRANDO" || message.visualState === "CONECTANDO") {
    chrome.action.setBadgeText({ text: "•" });
    chrome.action.setBadgeBackgroundColor({ color: "#F2A93B" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

export function registerNotifications() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "IFX_SIGNAL") notifySignal(message.signal).catch(() => {});
    if (message?.type === "IFX_UI_STATE") updateBadge(message);
  });
}
