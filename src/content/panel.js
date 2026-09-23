/**
 * Panel de señales Inflitrus.
 * Capa visual de solo lectura: consume el estado existente y nunca calcula ni ejecuta operaciones.
 */

import { logger } from "../utils/logger.js";
import { audioAlertManager } from "../utils/audio-alerts.js";
import { candleTimer } from "../utils/candle-timer.js";
import { createViewModel } from "../ui/view-model.js";
import { loadPanelFonts } from "../ui/fonts.js";
import { WaveRenderer } from "../ui/wave.js";
import { inflitrusSound } from "../ui/sound.js";
import { expandedMarkup, compactMarkup } from "../ui/components/layout.js";
import { readOnboardingState, completeOnboarding, onboardingMarkup } from "../ui/components/first-run.js";

const POSITION_KEY = "ifx_panel_position_v1";

function storageGet(keys) {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.storage?.local) return resolve({});
    chrome.storage.local.get(keys, (value) => resolve(value || {}));
  });
}

function storageSet(value) {
  if (!globalThis.chrome?.storage?.local) return;
  try { chrome.storage.local.set(value); } catch (_) {}
}

export class DiagnosticPanel {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.root = null;
    this.wave = null;
    // La interfaz visible vive en el Side Panel nativo de Chrome para no cubrir la plataforma.
    this.visible = false;
    this.collapsed = false;
    this.openTab = "system";
    this.settingsOpen = false;
    this.payoutOpen = false;
    this.debug = typeof location !== "undefined" && new URLSearchParams(location.search).get("ifx-debug") === "1";
    this.debugState = null;
    this.onboardingComplete = true;
    this.onboardingStep = 0;
    this.isSoundEnabled = audioAlertManager.isSoundEnabled();
    this.timerState = candleTimer.getState();
    this.logs = logger.getLogs();
    this.renderTimer = 0;
    this.lastVisualState = null;
    this.lastBadgeKey = null;
    this.lastSignalId = null;
    this.currentData = {
      frameStatus: "conectado",
      wsStatus: "esperando…",
      symbol: "---",
      timeframe: "1 minuto",
      historyCount: 0,
      lastCandleTime: "--:--:--",
      lastPrice: "0.00000",
      gaps: 0,
      state: "BOOTING",
      quantAction: "WAIT",
      quantProbability: 0.5,
      quantEV: 0,
      edge: 0,
      quality: 0.5,
      strategiesResults: [],
      quantReasons: [],
      signalsHistory: [],
      stats: { total: 0, settled: 0, wins: 0, losses: 0, dojis: 0, winRate: 0, netProfitUnits: 0 },
      payout: 0.8,
      signal: "WAIT",
      signalReasons: [],
      indicators: { ema9: null, ema21: null, rsi14: null },
    };

    candleTimer.start();
    this.unsubscribeTimer = candleTimer.subscribe((state) => {
      this.timerState = state;
      this.scheduleRender();
    });
    this.unsubscribeLogger = logger.subscribe((_entry, logs) => {
      this.logs = logs;
      if (this.openTab === "system") this.scheduleRender();
    });

    if (globalThis.chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        if (Array.isArray(changes.oracle_logs?.newValue)) {
          this.logs = changes.oracle_logs.newValue;
          if (this.openTab === "system") this.scheduleRender();
        }
        if (changes.oracle_sound_enabled) {
          this.isSoundEnabled = Boolean(changes.oracle_sound_enabled.newValue);
          this.scheduleRender();
        }
      });
    }

    if (typeof window !== "undefined" && window === window.top) this.init();
  }

  async init() {
    if (typeof document === "undefined" || this.host) return;
    this.host = document.createElement("inflitrus-panel");
    this.host.id = "inflitrus-panel-root";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = '<div style="width:320px;height:120px;border-radius:16px;background:#0B1A1F;border:1px solid rgba(138,155,163,.18)"></div>';
    this.applyHostStyle();
    this.mount();
    this.setupMutationObserver();
    this.setupMessageListener();

    const [stored, onboardingComplete, styles] = await Promise.all([
      storageGet([POSITION_KEY, "oracle_sound_enabled", "oracle_logs"]),
      readOnboardingState(),
      this.loadStyles(),
    ]);
    const position = stored?.[POSITION_KEY] || {};
    this.collapsed = Boolean(position.collapsed);
    this.isSoundEnabled = stored.oracle_sound_enabled === undefined ? audioAlertManager.isSoundEnabled() : Boolean(stored.oracle_sound_enabled);
    if (Array.isArray(stored.oracle_logs) && stored.oracle_logs.length) {
      const currentIds = new Set(this.logs.map((entry) => entry.id));
      this.logs = [...stored.oracle_logs.filter((entry) => !currentIds.has(entry.id)), ...this.logs].slice(-80);
    }
    this.onboardingComplete = onboardingComplete;
    await loadPanelFonts({ debug: this.debug });

    this.shadow.innerHTML = `<style>${styles}</style><div id="ifx-root"></div>`;
    this.root = this.shadow.getElementById("ifx-root");
    this.root.addEventListener("click", (event) => this.handleClick(event));
    this.applyHostStyle();
    this.render();
  }

  async loadStyles() {
    try {
      const urls = ["src/ui/tokens.css", "src/ui/base.css"].map((path) => chrome.runtime.getURL(path));
      const responses = await Promise.all(urls.map((url) => fetch(url)));
      return (await Promise.all(responses.map((response) => response.text()))).join("\n");
    } catch (error) {
      if (this.debug) console.warn("[inflitrus] CSS de respaldo activo", error);
      return ":host{font-family:system-ui;color:#E6EEF0}.ifx-panel{background:#0B1A1F;padding:16px}";
    }
  }

  mount() {
    const container = document.documentElement || document.body;
    if (container && this.host && !container.contains(this.host)) container.appendChild(this.host);
  }

  applyHostStyle() {
    if (!this.host) return;
    this.host.style.cssText = "all:initial;display:none!important;";
  }

  preferences() {
    return {
      collapsed: this.collapsed,
      soundEnabled: this.isSoundEnabled,
      openTab: this.openTab,
      settingsOpen: this.settingsOpen,
      payoutOpen: this.payoutOpen,
    };
  }

  scheduleRender() {
    if (!this.root || this.renderTimer) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = 0;
      this.render();
    }, 100);
  }

  render() {
    if (!this.root) return;
    const vm = createViewModel(this.currentData, this.timerState, { debug: this.debug, debugState: this.debugState });
    this.wave?.destroy();
    this.wave = null;
    this.root.innerHTML = this.collapsed ? compactMarkup(vm) : expandedMarkup(vm, this.preferences(), this.logs);
    if (!this.onboardingComplete && !this.collapsed) this.root.insertAdjacentHTML("beforeend", onboardingMarkup(this.onboardingStep));
    const canvas = this.root.querySelector("[data-wave]");
    if (canvas) this.wave = new WaveRenderer(canvas, { state: vm.wave, compact: this.collapsed, paused: false });
    this.handleStateEffects(vm);
    this.applyHostStyle();
  }

  handleStateEffects(vm) {
    if (!this.debug) {
      if (vm.visualState === "BLOQUEADO" && this.lastVisualState !== "BLOQUEADO") inflitrusSound.blocked();
      if ((vm.visualState === "ESCANEANDO" || vm.visualState === "SENAL") && ["CONECTANDO", "CALIBRANDO", "BLOQUEADO"].includes(this.lastVisualState)) inflitrusSound.connected();
      if (vm.signal?.phase === "live" && vm.signal.id !== this.lastSignalId) {
        this.lastSignalId = vm.signal.id;
        try {
          chrome.runtime.sendMessage({ type: "IFX_SIGNAL", signal: { id: vm.signal.id, direction: vm.signal.direction, asset: vm.asset, timeframe: vm.timeframe, validRemainingSec: vm.signal.validRemainingSec, recordedAt: vm.signal.recordedAt } });
        } catch (_) {}
      }
      const badgeKey = `${vm.visualState}:${vm.technicalState}:${vm.signal?.phase || "none"}`;
      if (badgeKey !== this.lastBadgeKey) {
        this.lastBadgeKey = badgeKey;
        try { chrome.runtime.sendMessage({ type: "IFX_UI_STATE", visualState: vm.visualState, technicalState: vm.technicalState, signalPhase: vm.signal?.phase || null }); } catch (_) {}
      }
    }
    this.lastVisualState = vm.visualState;
  }

  handleClick(event) {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    const action = trigger.dataset.action;
    if (action === "toggle-settings") this.settingsOpen = !this.settingsOpen;
    if (action === "toggle-collapse") {
      this.collapsed = !this.collapsed;
      this.settingsOpen = false;
      this.payoutOpen = false;
      this.persistPosition();
    }
    if (action === "toggle-sound") {
      this.isSoundEnabled = audioAlertManager.toggleSound();
      this.settingsOpen = false;
    }
    if (action === "toggle-payout") this.payoutOpen = !this.payoutOpen;
    if (action === "set-payout") {
      const payout = Number(trigger.dataset.value);
      if (Number.isFinite(payout)) window.postMessage({ type: "ORACLE_SET_PAYOUT", payout }, "*");
      this.payoutOpen = false;
    }
    if (action === "toggle-tab") this.openTab = this.openTab === trigger.dataset.value ? null : trigger.dataset.value;
    if (action === "open-market") this.openTab = "market";
    if (action === "copy-logs") this.copyLogs(trigger);
    if (action === "clear-logs") logger.clear();
    if (action === "debug-state") this.debugState = trigger.dataset.value || null;
    if (action === "onboarding-next") {
      if (this.onboardingStep < 2) this.onboardingStep += 1;
      else {
        this.onboardingComplete = true;
        completeOnboarding();
      }
    }
    this.render();
  }

  copyLogs(button) {
    if (!this.logs.length || !navigator.clipboard) return;
    const text = this.logs.map((entry) => `[${entry.time}] [${entry.tag}] ${entry.message}`).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      const textNode = Array.from(button.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.textContent = "Copiado";
    }).catch(() => {});
  }

  persistPosition() {
    storageSet({ [POSITION_KEY]: { collapsed: this.collapsed } });
  }

  setupMessageListener() {
    if (!globalThis.chrome?.runtime?.onMessage) return;
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "ORACLE_CLEAR_LOGS") logger.clear();
    });
  }

  update(newData = {}) {
    if (newData.candleTimestamp) candleTimer.syncServerTime(newData.candleTimestamp);
    this.currentData = { ...this.currentData, ...newData };
    this.scheduleRender();
  }

  setupMutationObserver() {
    const target = document.documentElement || document.body;
    if (!target) return;
    this.observer = new MutationObserver(() => {
      if (this.host && !target.contains(this.host)) target.appendChild(this.host);
    });
    this.observer.observe(target, { childList: true });
  }
}
