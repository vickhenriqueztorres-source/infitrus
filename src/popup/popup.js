import { audioAlertManager } from "../utils/audio-alerts.js";
import { createViewModel } from "../ui/view-model.js";
import { WaveRenderer } from "../ui/wave.js";

const ACTIVE_KEY = "ifx_active_v1";
const NOTIFICATIONS_KEY = "ifx_notifications_v1";
let wave;

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (result) => resolve(result || {})));
}

function sendToB2Tabs(message) {
  chrome.tabs.query({ url: ["https://traderoom.b2trading.io/*", "https://chart.b2trading.io/*"] }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id == null) return;
      try {
        const pending = chrome.tabs.sendMessage(tab.id, message);
        pending?.catch?.(() => {});
      } catch (_) {}
    });
  });
}

function renderState(data = {}) {
  const vm = createViewModel(data, data.candleTimer || {}, { now: Date.now() });
  const stateCopy = {
    CONECTANDO: "Activo · Buscando la transmisión…",
    CALIBRANDO: "Activo · Calibrando datos…",
    ESCANEANDO: "Activo · Escuchando el mercado…",
    SENAL: "Activo · Frecuencia fijada.",
    BLOQUEADO: "Activo · Datos bloqueados.",
  }[vm.visualState];
  document.getElementById("status-copy").textContent = stateCopy;
  document.getElementById("asset").textContent = vm.asset;
  document.getElementById("timeframe").textContent = vm.timeframe;
  document.getElementById("feed-copy").textContent = vm.context.feed === "Estable" ? "Datos estables" : vm.context.feed === "Sin datos" ? "Sin datos" : "Datos inestables";
  const statusDot = document.getElementById("status-dot");
  statusDot.className = `dot ${vm.statusDot}`;
  const feedDot = document.getElementById("feed-dot");
  feedDot.className = `dot ${vm.context.feed === "Estable" ? "teal" : "amber"}`;
  wave?.destroy();
  wave = new WaveRenderer(document.getElementById("popup-wave"), { state: vm.wave });
}

async function initialize() {
  const stored = await getStorage(["oracleMarketState", "oracle_sound_enabled", ACTIVE_KEY, NOTIFICATIONS_KEY]);
  document.getElementById("active-toggle").checked = stored[ACTIVE_KEY] !== false;
  document.getElementById("sound-toggle").checked = stored.oracle_sound_enabled === undefined ? audioAlertManager.isSoundEnabled() : Boolean(stored.oracle_sound_enabled);
  document.getElementById("notification-toggle").checked = stored[NOTIFICATIONS_KEY] !== false;
  renderState(stored.oracleMarketState || {});

  document.getElementById("active-toggle").addEventListener("change", (event) => {
    chrome.storage.local.set({ [ACTIVE_KEY]: event.target.checked });
    sendToB2Tabs({ type: "ORACLE_TOGGLE_PANEL" });
  });
  document.getElementById("sound-toggle").addEventListener("change", (event) => {
    audioAlertManager.setSoundEnabled(event.target.checked);
  });
  document.getElementById("notification-toggle").addEventListener("change", (event) => {
    chrome.storage.local.set({ [NOTIFICATIONS_KEY]: event.target.checked });
  });
  document.getElementById("open-traderoom").addEventListener("click", () => {
    chrome.tabs.query({ url: "https://traderoom.b2trading.io/*" }, (tabs) => {
      if (tabs[0]?.id != null) chrome.tabs.update(tabs[0].id, { active: true });
      else chrome.tabs.create({ url: "https://traderoom.b2trading.io/" });
      window.close();
    });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.oracleMarketState?.newValue) renderState(changes.oracleMarketState.newValue);
  });
}

document.addEventListener("DOMContentLoaded", initialize);
