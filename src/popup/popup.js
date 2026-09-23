import { audioAlertManager } from "../utils/audio-alerts.js";
import { createViewModel } from "../ui/view-model.js";
import { WaveRenderer } from "../ui/wave.js";
import { selectTabView } from "../ui/tab-view-selector.js";

const ACTIVE_KEY = "ifx_active_v1";
const NOTIFICATIONS_KEY = "ifx_notifications_v1";
let wave;
let boundTabId = null;
let boundWindowId = null;

function getStorage(keys) {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.storage?.local) return resolve({});
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function sendToBoundTab(message) {
  if (boundTabId == null) return;
  try {
    const pending = chrome.tabs.sendMessage(boundTabId, message);
    pending?.catch?.(() => {});
  } catch (_) {}
}

function renderState(data = {}) {
  const vm = createViewModel(data, data.candleTimer || {}, { now: Date.now() });
  const stateCopy = {
    CONECTANDO: "Activo · Buscando la transmisión…",
    CALIBRANDO: "Activo · Calibrando datos…",
    ESCANEANDO: "Activo · Escuchando el mercado…",
    SENAL: "Activo · Frecuencia fijada.",
    BLOQUEADO: "Activo · Datos bloqueados.",
  }[vm.visualState] || "Activo · Observador Quant";

  const copyEl = document.getElementById("status-copy");
  if (copyEl) copyEl.textContent = stateCopy;

  const assetEl = document.getElementById("asset");
  if (assetEl) assetEl.textContent = vm.asset;

  const tfEl = document.getElementById("timeframe");
  if (tfEl) tfEl.textContent = vm.timeframe;

  const feedCopy = document.getElementById("feed-copy");
  if (feedCopy) {
    feedCopy.textContent = vm.context?.feed === "Estable" ? "Datos estables" : vm.context?.feed === "Sin datos" ? "Sin datos" : "Datos inestables";
  }

  const statusDot = document.getElementById("status-dot");
  if (statusDot) statusDot.className = `dot ${vm.statusDot || "amber"}`;

  const feedDot = document.getElementById("feed-dot");
  if (feedDot) feedDot.className = `dot ${vm.context?.feed === "Estable" ? "teal" : "amber"}`;

  wave?.destroy();
  const canvas = document.getElementById("popup-wave");
  if (canvas) {
    wave = new WaveRenderer(canvas, { state: vm.wave });
  }
}

async function refreshPopupState() {
  if (!boundTabId) return;
  const stateKey = `ifx:tab:${boundTabId}:state`;
  const soundKey = boundWindowId ? `ifx:window:${boundWindowId}:sound` : null;
  const keys = [stateKey, ACTIVE_KEY, NOTIFICATIONS_KEY];
  if (soundKey) keys.push(soundKey);

  const stored = await getStorage(keys);
  if (soundKey && stored[soundKey] !== undefined) {
    audioAlertManager.setSoundEnabled(Boolean(stored[soundKey]));
    const soundToggle = document.getElementById("sound-toggle");
    if (soundToggle) soundToggle.checked = Boolean(stored[soundKey]);
  }
  const view = selectTabView(stored, boundTabId);
  renderState(view.state || {});
}

async function initialize() {
  try {
    if (typeof chrome !== "undefined" && chrome.windows?.getCurrent) {
      const currentWin = await chrome.windows.getCurrent();
      boundWindowId = currentWin?.id || null;
      if (boundWindowId && chrome.tabs?.query) {
        const tabs = await chrome.tabs.query({ active: true, windowId: boundWindowId });
        boundTabId = tabs?.[0]?.id || null;
      }
    }
  } catch (_) {}

  const soundKey = boundWindowId ? `ifx:window:${boundWindowId}:sound` : null;
  const stored = await getStorage([ACTIVE_KEY, NOTIFICATIONS_KEY, ...(soundKey ? [soundKey] : [])]);
  const activeToggle = document.getElementById("active-toggle");
  if (activeToggle) activeToggle.checked = stored[ACTIVE_KEY] !== false;

  const soundToggle = document.getElementById("sound-toggle");
  if (soundToggle) {
    soundToggle.checked = soundKey && stored[soundKey] !== undefined ? Boolean(stored[soundKey]) : audioAlertManager.isSoundEnabled();
  }

  const notifToggle = document.getElementById("notification-toggle");
  if (notifToggle) notifToggle.checked = stored[NOTIFICATIONS_KEY] !== false;

  await refreshPopupState();

  activeToggle?.addEventListener("change", (event) => {
    chrome.storage.local.set({ [ACTIVE_KEY]: event.target.checked });
    sendToBoundTab({ type: "ORACLE_TOGGLE_PANEL" });
  });

  soundToggle?.addEventListener("change", (event) => {
    const enabled = event.target.checked;
    audioAlertManager.setSoundEnabled(enabled);
    if (soundKey) {
      chrome.storage.local.set({ [soundKey]: enabled });
    }
  });

  notifToggle?.addEventListener("change", (event) => {
    chrome.storage.local.set({ [NOTIFICATIONS_KEY]: event.target.checked });
  });

  document.getElementById("open-traderoom")?.addEventListener("click", () => {
    chrome.tabs.query({ url: "https://traderoom.b2trading.io/*" }, (tabs) => {
      if (tabs[0]?.id != null) chrome.tabs.update(tabs[0].id, { active: true });
      else chrome.tabs.create({ url: "https://traderoom.b2trading.io/" });
      window.close();
    });
  });

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !boundTabId) return;
      const tabStateKey = `ifx:tab:${boundTabId}:state`;
      if (changes[tabStateKey]?.newValue) {
        renderState(changes[tabStateKey].newValue);
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", initialize);
