/**
 * remote-config-manager.js - Gerenciador de Configurações Remotas em Tempo Real (OTA)
 * Inflitrus Signals — B2Trading
 *
 * Funcionalidades:
 * 1. Sincronização periódica com a URL Cloudflare Worker (HTTPS + CDN global).
 * 2. Cache local em chrome.storage.local ("ifx:remote_config:v1") com tolerância total a falhas offline.
 * 3. Interruptor de emergência (Kill-Switch) para pausar sinais instantaneamente em dias de notícias.
 * 4. Ajuste dinâmico de parâmetros quantitativos (minEdge, minPayout, minQuality).
 * 5. Lista de pares permitidos e bloqueados remotamente.
 * 6. Pesos e status das famílias/subestratégias em tempo de execução.
 * 7. Banners e anúncios de sistema exibidos no Side Panel.
 */

export const REMOTE_CONFIG_STORAGE_KEY = "ifx:remote_config:v1";
export const DEFAULT_CONFIG_URL = "https://bold-credit-d896.brendacostatrader.workers.dev/";

export const DEFAULT_FALLBACK_CONFIG = Object.freeze({
  version: "1.0.0",
  updatedAt: new Date(0).toISOString(),
  system: {
    killSwitch: false,
    killSwitchReason: "Mercado em alta volatilidade devido a notícias. Sinais em pausa preventiva.",
    announcement: null,
  },
  parameters: {
    minEdge: 0.025,
    minPayout: 0.78,
    minQuality: 0.60,
  },
  market: {
    allowedPairs: [
      "EURUSD_OTC",
      "GBPUSD_OTC",
      "USDJPY_OTC",
      "AUDUSD_OTC",
    ],
    blockedPairs: [],
  },
  strategies: {
    families: {
      MOMENTUM: { enabled: true, weight: 1.2 },
      REVERSAL: { enabled: true, weight: 0.9 },
      MICROSTRUCTURE: { enabled: true, weight: 1.4 },
      VOLATILITY: { enabled: false, weight: 0.0 },
      ANALOGY: { enabled: true, weight: 1.0 },
    },
    subStrategies: {
      IMPULSE_CONTINUATION: { status: "ACTIVE", weight: 1.3 },
      WICK_REJECTION: { status: "SHADOW", weight: 0.5 },
      SQUEEZE_BREAKOUT: { status: "MUTED", weight: 0.0 },
    },
  },
});

export class RemoteConfigManager {
  constructor(options = {}) {
    this.configUrl = options.configUrl || DEFAULT_CONFIG_URL;
    this.pollIntervalMs = options.pollIntervalMs || 180_000; // 3 minutos
    this._cachedConfig = { ...DEFAULT_FALLBACK_CONFIG };
    this._listeners = new Set();
    this._pollTimer = null;
    this._isFetching = false;
    this._lastFetchTimeMs = 0;

    this._initStorageListener();
  }

  _initStorageListener() {
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[REMOTE_CONFIG_STORAGE_KEY]?.newValue) {
          this._cachedConfig = this._sanitizeConfig(changes[REMOTE_CONFIG_STORAGE_KEY].newValue);
          this._notifyListeners();
        }
      });
    }
  }

  _sanitizeConfig(raw) {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_FALLBACK_CONFIG };
    return {
      version: String(raw.version || "1.0.0"),
      updatedAt: String(raw.updatedAt || new Date().toISOString()),
      system: {
        killSwitch: Boolean(raw.system?.killSwitch),
        killSwitchReason: String(raw.system?.killSwitchReason || DEFAULT_FALLBACK_CONFIG.system.killSwitchReason),
        announcement: raw.system?.announcement ? String(raw.system.announcement) : null,
      },
      parameters: {
        minEdge: Number.isFinite(Number(raw.parameters?.minEdge)) && Number(raw.parameters?.minEdge) > 0 ? Number(raw.parameters.minEdge) : DEFAULT_FALLBACK_CONFIG.parameters.minEdge,
        minPayout: Number.isFinite(Number(raw.parameters?.minPayout)) && Number(raw.parameters?.minPayout) > 0 ? Number(raw.parameters.minPayout) : DEFAULT_FALLBACK_CONFIG.parameters.minPayout,
        minQuality: Number.isFinite(Number(raw.parameters?.minQuality)) && Number(raw.parameters?.minQuality) > 0 ? Number(raw.parameters.minQuality) : DEFAULT_FALLBACK_CONFIG.parameters.minQuality,
      },
      market: {
        allowedPairs: Array.isArray(raw.market?.allowedPairs) ? raw.market.allowedPairs.map(String) : [...DEFAULT_FALLBACK_CONFIG.market.allowedPairs],
        blockedPairs: Array.isArray(raw.market?.blockedPairs) ? raw.market.blockedPairs.map(String) : [],
      },
      strategies: {
        families: raw.strategies?.families && typeof raw.strategies.families === "object" ? raw.strategies.families : { ...DEFAULT_FALLBACK_CONFIG.strategies.families },
        subStrategies: raw.strategies?.subStrategies && typeof raw.strategies.subStrategies === "object" ? raw.strategies.subStrategies : { ...DEFAULT_FALLBACK_CONFIG.strategies.subStrategies },
      },
    };
  }

  startPolling() {
    if (this._pollTimer) return;
    this.refreshFromNetwork().catch(() => {});
    this._pollTimer = setInterval(() => {
      this.refreshFromNetwork().catch(() => {});
    }, this.pollIntervalMs);
    if (this._pollTimer && typeof this._pollTimer.unref === "function") {
      this._pollTimer.unref();
    }
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async loadFromStorage(customStorage = null) {
    const store = customStorage || (typeof chrome !== "undefined" ? chrome.storage?.local : null);
    if (!store?.get) return this._cachedConfig;

    try {
      const data = await new Promise((resolve) => {
        const res = store.get([REMOTE_CONFIG_STORAGE_KEY], (items) => resolve(items || {}));
        if (res instanceof Promise) res.then(resolve).catch(() => resolve({}));
      });
      if (data && data[REMOTE_CONFIG_STORAGE_KEY]) {
        this._cachedConfig = this._sanitizeConfig(data[REMOTE_CONFIG_STORAGE_KEY]);
        this._notifyListeners();
      }
    } catch (_) {}

    return this._cachedConfig;
  }

  async refreshFromNetwork(customFetch = null) {
    if (this._isFetching) return this._cachedConfig;
    this._isFetching = true;

    const fetcher = customFetch || globalThis.fetch;
    if (!fetcher) {
      this._isFetching = false;
      return this._cachedConfig;
    }

    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 6000) : null;
      if (timeoutId && typeof timeoutId.unref === "function") {
        timeoutId.unref();
      }

      const url = `${this.configUrl}${this.configUrl.includes("?") ? "&" : "?"}_ts=${Date.now()}`;
      const res = await fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller?.signal,
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (res && res.ok) {
        const json = await res.json();
        const sanitized = this._sanitizeConfig(json);
        this._cachedConfig = sanitized;
        this._lastFetchTimeMs = Date.now();

        // Persiste no storage local
        if (typeof chrome !== "undefined" && chrome.storage?.local?.set) {
          try {
            chrome.storage.local.set({ [REMOTE_CONFIG_STORAGE_KEY]: sanitized });
          } catch (_) {}
        }

        this._notifyListeners();
      }
    } catch (_) {
      // Falhas de rede são toleradas silenciosamente usando o cache offline existente
    } finally {
      this._isFetching = false;
    }

    return this._cachedConfig;
  }

  getConfig() {
    return { ...this._cachedConfig };
  }

  isKillSwitchActive() {
    return Boolean(this._cachedConfig.system?.killSwitch);
  }

  getKillSwitchReason() {
    return this._cachedConfig.system?.killSwitchReason || "Pausa técnica de mercado.";
  }

  getAnnouncement() {
    return this._cachedConfig.system?.announcement || null;
  }

  getMinEdge(defaultFallback = 0.025) {
    const val = this._cachedConfig.parameters?.minEdge;
    return Number.isFinite(val) ? val : defaultFallback;
  }

  getMinPayout(defaultFallback = 0.78) {
    const val = this._cachedConfig.parameters?.minPayout;
    return Number.isFinite(val) ? val : defaultFallback;
  }

  getMinQuality(defaultFallback = 0.60) {
    const val = this._cachedConfig.parameters?.minQuality;
    return Number.isFinite(val) ? val : defaultFallback;
  }

  isPairBlocked(symbol) {
    if (!symbol) return false;
    const cleanSym = String(symbol).trim().toUpperCase();
    const blocked = this._cachedConfig.market?.blockedPairs || [];
    return blocked.some((b) => String(b).trim().toUpperCase() === cleanSym);
  }

  isPairAllowed(symbol) {
    if (this.isPairBlocked(symbol)) return false;
    const allowed = this._cachedConfig.market?.allowedPairs;
    if (!allowed || !Array.isArray(allowed) || allowed.length === 0) return true;
    const cleanSym = String(symbol).trim().toUpperCase();
    return allowed.some((a) => String(a).trim().toUpperCase() === cleanSym);
  }

  getFamilyConfig(familyName) {
    if (!familyName) return { enabled: true, weight: 1.0 };
    const fams = this._cachedConfig.strategies?.families || {};
    return fams[familyName] || { enabled: true, weight: 1.0 };
  }

  getSubStrategyConfig(subStrategyName) {
    if (!subStrategyName) return { status: "ACTIVE", weight: 1.0 };
    const subs = this._cachedConfig.strategies?.subStrategies || {};
    return subs[subStrategyName] || { status: "ACTIVE", weight: 1.0 };
  }

  onUpdate(callback) {
    if (typeof callback === "function") {
      this._listeners.add(callback);
    }
    return () => this._listeners.delete(callback);
  }

  subscribe(callback) {
    return this.onUpdate(callback);
  }

  _notifyListeners() {
    const cfg = this.getConfig();
    for (const cb of this._listeners) {
      try {
        cb(cfg);
      } catch (_) {}
    }
  }
}

export const remoteConfigManager = new RemoteConfigManager();
