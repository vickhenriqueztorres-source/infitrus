/**
 * logger.js - Sistema Central de Logs e Auditoria em Tempo Real
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Registrar eventos com tags semânticas ([FEED], [SINAL], [INDICADOR], [ESTADO], [WS], [HISTÓRICO]).
 * - Exibir logs formatados e coloridos no DevTools Console (F12).
 * - Manter buffer circular em memória dos últimos 80 eventos para exibição visual na extensão.
 * - Sincronizar logs com chrome.storage.local para alimentar Sidebar, Popup e Side Panel com isolamento por ativo e aba.
 */

export class LogManager {
  constructor(options = {}) {
    this.maxLogs = options.maxLogs || 80;
    this.logs = [];
    this.listeners = new Set();
    this._syncTimeout = null;
    this.context = {
      symbol: null,
      tabId: null,
    };
  }

  setContext(ctx = {}) {
    this.context = { ...this.context, ...ctx };
  }

  add(tag, message, level = "info", meta = {}) {
    const id = meta.id || `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // Se o log já existe com o mesmo ID, não adiciona novamente
    if (this.logs.some((l) => l.id === id)) {
      return null;
    }

    const now = new Date();
    const timeStr =
      now.toTimeString().split(" ")[0] +
      "." +
      String(now.getMilliseconds()).padStart(3, "0");

    const entry = {
      id,
      time: timeStr,
      timeMs: Date.now(),
      tag: tag.toUpperCase(),
      message,
      level, // 'info', 'success', 'warn', 'error'
      symbol: meta.symbol || this.context?.symbol || null,
      tabId: meta.tabId || this.context?.tabId || null,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    if (!meta.skipConsole) {
      this.logToConsole(entry);
    }

    for (const listener of this.listeners) {
      try {
        listener(entry, this.logs);
      } catch (_) {}
    }

    this.scheduleStorageSync();
    return entry;
  }

  info(tag, message, meta) {
    return this.add(tag, message, "info", meta);
  }

  success(tag, message, meta) {
    return this.add(tag, message, "success", meta);
  }

  warn(tag, message, meta) {
    return this.add(tag, message, "warn", meta);
  }

  error(tag, message, meta) {
    return this.add(tag, message, "error", meta);
  }

  logToConsole(entry) {
    const tagStyles = {
      FEED: "color: #38BDF8; font-weight: bold;",
      INDICADOR: "color: #C084FC; font-weight: bold;",
      SINAL:
        entry.level === "success"
          ? "color: #4ADE80; font-weight: 800;"
          : entry.level === "error"
          ? "color: #F87171; font-weight: 800;"
          : "color: #FBBF24; font-weight: 800;",
      ESTADO: "color: #FB923C; font-weight: bold;",
      HISTÓRICO: "color: #94A3B8; font-weight: bold;",
      WS: "color: #38BDF8; font-weight: bold;",
      STORE: "color: #34D399; font-weight: bold;",
      ERRO: "color: #EF4444; font-weight: bold;",
      SISTEMA: "color: #A3E635; font-weight: bold;",
    };

    const style = tagStyles[entry.tag] || "color: #38BDF8; font-weight: bold;";
    const prefix = `[OracleQuant ${entry.tag}${entry.symbol ? ` - ${entry.symbol}` : ""}]`;

    if (entry.level === "error") {
      console.error(`%c${prefix}%c ${entry.message}`, style, "color: inherit;");
    } else if (entry.level === "warn") {
      console.warn(`%c${prefix}%c ${entry.message}`, style, "color: inherit;");
    } else {
      console.log(`%c${prefix}%c ${entry.message}`, style, "color: inherit;");
    }
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getLogs() {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
    for (const listener of this.listeners) {
      try {
        listener(null, this.logs);
      } catch (_) {}
    }
    this.scheduleStorageSync(true);
  }

  scheduleStorageSync(immediate = false) {
    if (this._syncTimeout && !immediate) return;
    if (this._syncTimeout) clearTimeout(this._syncTimeout);

    const doSync = () => {
      this._syncTimeout = null;
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        try {
          // 1. Grava chave isolada da aba se disponível
          if (this.context?.tabId) {
            chrome.storage.local.set({ [`oracle_logs_tab_${this.context.tabId}`]: this.logs });
          }

          // 2. Mescla no log global compartilhado preservando logs de outras abas/ativos
          chrome.storage.local.get(["oracle_logs"], (res) => {
            const existing = Array.isArray(res?.oracle_logs) ? res.oracle_logs : [];
            const map = new Map();
            existing.forEach((e) => map.set(e.id, e));
            this.logs.forEach((e) => map.set(e.id, e));
            const merged = Array.from(map.values())
              .sort((a, b) => (a.timeMs || 0) - (b.timeMs || 0))
              .slice(-120);
            chrome.storage.local.set({ oracle_logs: merged });
          });
        } catch (_) {}
      }
    };

    if (immediate) {
      doSync();
    } else {
      this._syncTimeout = setTimeout(doSync, 300);
    }
  }
}

export const logger = new LogManager();
