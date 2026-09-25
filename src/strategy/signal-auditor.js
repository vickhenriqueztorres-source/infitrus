/**
 * signal-auditor.js - Gravador e Auditor de Sinais em Tempo Real
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Armazenar cada sinal disparado em chrome.storage.local (ifx:tab:<tabId>:signals).
 * - Monitorar o fechamento da vela seguinte (t + 1) e auditar automaticamente:
 *     C_{t+1} > C_t e CALL => WIN (+Payout)
 *     C_{t+1} < C_t e PUT  => WIN (+Payout)
 *     C_{t+1} == C_t       => DOJI (0.00)
 *     Divergente           => LOSS (-1.00)
 * - Manter estatísticas acumuladas em tempo real:
 *     Win Rate global (%)
 *     Assertividade por estratégia individual
 *     Assertividade de confluências (2/5, 3/5, 4/5, 5/5)
 *     Lucro teórico acumulado em unidades
 */

import { signalStore } from "../storage/signal-store.js";

export class SignalAuditor {
  constructor(options = {}) {
    this.maxStoredSignals = options.maxStoredSignals || 150;
    this.signals = [];
    this.stats = {
      total: 0,
      settled: 0,
      wins: 0,
      losses: 0,
      dojis: 0,
      winRate: 0,
      netProfitUnits: 0,
      byStrategy: {},
      bySubStrategy: {},
      byConfluence: {},
    };

    this.tabId = null;
  }

  /**
   * Configura o tabId da aba para isolamento estrito de storage
   * @param {number|string} tabId
   */
  setTabId(tabId) {
    if (!tabId) return;
    this.tabId = Number(tabId);

    // Consulta transacional durável no SW com fallback local
    const fetchFromSW = typeof chrome !== "undefined" && chrome.runtime?.sendMessage
      ? new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: "GET_SIGNALS", limit: 150, tabId: this.tabId }, (resp) => {
              if (chrome.runtime.lastError || !resp?.ok || !Array.isArray(resp.signals)) resolve(null);
              else resolve(resp.signals);
            });
          } catch (_) {
            resolve(null);
          }
        })
      : Promise.resolve(null);

    fetchFromSW.then(async (swSigs) => {
      if (Array.isArray(swSigs) && swSigs.length > 0) {
        this.signals = swSigs;
        this._recomputeStats();
        return;
      }
      const sigs = await signalStore.getSignals(150, { tabId: this.tabId });
      if (Array.isArray(sigs) && sigs.length > 0) {
        this.signals = sigs;
        this._recomputeStats();
      } else if (typeof chrome !== "undefined" && chrome.storage?.local) {
        try {
          const key = `ifx:tab:${this.tabId}:signals`;
          chrome.storage.local.get([key], (res) => {
            if (Array.isArray(res?.[key])) {
              this.signals = res[key];
              this._recomputeStats();
            }
          });
        } catch (_) {}
      }
    }).catch(() => {});
  }

  /**
   * Grava um novo sinal disparado no histórico.
   *
   * @param {Object} signal
   * @param {string} [signal.id]
   * @param {string} signal.action - 'CALL' ou 'PUT'
   * @param {string} signal.symbol
   * @param {number} [signal.timeframeSeconds=60]
   * @param {number} [signal.candleTimestamp]
   * @param {number} [signal.timestamp]
   * @param {number} [signal.targetTimestamp]
   * @param {number} [signal.entryPrice]
   * @param {number} [signal.probability]
   * @param {number} [signal.ev]
   * @param {number} [signal.payout]
   * @param {string} [signal.label]
   * @param {boolean} [signal.isConfluence]
   * @param {Object} [signal.confluence]
   * @param {string} [signal.primaryStrategyName]
   * @param {string} [signal.subStrategy]
   * @param {string} [signal.correlationGroup]
   * @param {Array<string>} [signal.reasons]
   * @returns {Object|null}
   */
  recordSignal(signal) {
    if (!signal || signal.action === "WAIT") {
      return null;
    }

    const candleTs = signal.candleTimestamp || signal.timestamp;
    if (!candleTs) return null;

    const tf = signal.timeframeSeconds || 60;
    const id = signal.id || `sig_${signal.symbol}_${tf}_${candleTs}`;
    const targetTimestamp = signal.targetTimestamp || (candleTs + tf);

    // Evita duplicata por id ou candle do mesmo símbolo
    if (this.signals.some((s) => s.id === id || (s.symbol === signal.symbol && s.timestamp === candleTs))) {
      return null;
    }

    const dateObj = new Date(candleTs * 1000);
    const timeFormatted = dateObj.toTimeString().split(" ")[0];

    const record = {
      id,
      timestamp: candleTs,
      timeFormatted,
      symbol: signal.symbol,
      timeframeSeconds: tf,
      direction: signal.action,
      label: signal.label,
      isConfluence: Boolean(signal.isConfluence),
      confluenceCount: signal.confluence?.count || 1,
      confluenceTotal: signal.confluence?.total || 5,
      strategyName: signal.isConfluence
        ? `Confluência (${signal.confluence.count}/${signal.confluence.total})`
        : signal.primaryStrategyName || "Ensemble M1",
      subStrategy: signal.subStrategy || null,
      correlationGroup: signal.correlationGroup || null,
      entryPrice: signal.entryPrice,
      probability: signal.probability,
      conservativeProbability: signal.conservativeProbability || signal.probability,
      ev: signal.ev,
      edge: signal.edge || 0,
      quality: signal.quality || 0,
      payout: signal.payout || 0.80,
      targetTimestamp,
      status: "PENDING", // PENDING -> SETTLED / CANCELLED
      closePrice: null,
      result: null, // WIN, LOSS, DOJI
      pnlUnits: null,
      reasons: signal.reasons || [],
      recordedAt: Date.now(),
    };

    this.signals.unshift(record);
    if (this.signals.length > this.maxStoredSignals) {
      this.signals.pop();
    }

    this._recomputeStats();
    this._persistStorage();
    return record;
  }

  /**
   * Liquida formalmente um sinal com resultado observado.
   *
   * @param {string} id
   * @param {Object} outcome
   * @param {string} outcome.result - 'WIN', 'LOSS', 'DOJI'
   * @param {number} [outcome.entryPrice]
   * @param {number} [outcome.closePrice]
   * @returns {Object|null}
   */
  settle(id, { result, entryPrice, closePrice } = {}) {
    const sig = this.signals.find((s) => s.id === id);
    if (!sig || sig.status !== "PENDING") return null;

    sig.status = "SETTLED";
    if (entryPrice != null) sig.entryPrice = entryPrice;
    if (closePrice != null) sig.closePrice = closePrice;
    sig.result = result;

    if (result === "WIN") {
      sig.pnlUnits = Number((sig.payout || 0.80).toFixed(2));
    } else if (result === "LOSS") {
      sig.pnlUnits = -1.0;
    } else {
      sig.pnlUnits = 0.0;
    }

    sig.settledAt = Date.now();
    this._recomputeStats();
    this._persistStorage();
    return sig;
  }

  /**
   * Cancela um sinal (ex: feed instável ou cancelamento antes da entrada).
   * Não entra nas estatísticas do placar.
   *
   * @param {string} id
   * @param {string} [reason]
   * @returns {Object|null}
   */
  cancel(id, reason = null) {
    const sig = this.signals.find((s) => s.id === id);
    if (!sig) return null;

    sig.status = "CANCELLED";
    sig.reason = reason;
    sig.cancelledAt = Date.now();
    this._recomputeStats();
    this._persistStorage();
    return sig;
  }

  /**
   * Fallback de recuperação para auditoria de sinais pendentes (ex: reconexão).
   * Usa APENAS velas fechadas (closed !== false).
   *
   * @param {Array<{ timestamp: number, open?: number, high?: number, low?: number, close: number, symbol?: string, closed?: boolean }>} closedCandles
   * @param {number} [nowSec=null]
   * @returns {Array<Object>} Lista de sinais recém-liquidados
   */
  auditPendingSignals(closedCandles = [], nowSec = null) {
    if (!closedCandles || closedCandles.length === 0) return [];

    const currentTimeSec = nowSec ?? (Date.now() / 1000);
    const newlySettled = [];
    const candleMap = new Map();

    for (const c of closedCandles) {
      if (c.closed === false) continue; // Descarta estritamente velas em formação

      if (c.symbol) {
        candleMap.set(`${c.symbol.toUpperCase()}_${c.timestamp}`, c);
      }
      candleMap.set(String(c.timestamp), c);
    }

    for (const sig of this.signals) {
      if (sig.status === "PENDING") {
        const symKey = `${(sig.symbol || "").toUpperCase()}_${sig.targetTimestamp}`;
        const targetCandle = candleMap.get(symKey) || candleMap.get(String(sig.targetTimestamp));

        if (targetCandle && (!targetCandle.symbol || targetCandle.symbol.toUpperCase() === (sig.symbol || "").toUpperCase())) {
          const entryPrice = targetCandle.open ?? sig.entryPrice;
          const closePrice = targetCandle.close;
          let result = "LOSS";
          let pnlUnits = -1.0;

          if (closePrice > entryPrice) {
            if (sig.direction === "CALL") {
              result = "WIN";
              pnlUnits = Number((sig.payout || 0.80).toFixed(2));
            } else {
              result = "LOSS";
              pnlUnits = -1.0;
            }
          } else if (closePrice < entryPrice) {
            if (sig.direction === "PUT") {
              result = "WIN";
              pnlUnits = Number((sig.payout || 0.80).toFixed(2));
            } else {
              result = "LOSS";
              pnlUnits = -1.0;
            }
          } else {
            result = "DOJI";
            pnlUnits = 0.0;
          }

          sig.status = "SETTLED";
          sig.entryPrice = entryPrice;
          sig.closePrice = closePrice;
          sig.result = result;
          sig.pnlUnits = pnlUnits;
          sig.settledAt = Date.now();

          newlySettled.push(sig);
        }
      }
    }

    if (newlySettled.length > 0) {
      this._recomputeStats();
      this._persistStorage();
    }

    return newlySettled;
  }

  /**
   * Recalcula todas as estatísticas acumuladas ignorando sinais CANCELLED.
   * @private
   */
  _recomputeStats() {
    const activeSignals = this.signals.filter((s) => s.status !== "CANCELLED");
    let total = activeSignals.length;
    let settled = 0;
    let wins = 0;
    let losses = 0;
    let dojis = 0;
    let netProfitUnits = 0;

    const byStrategy = {};
    const bySubStrategy = {};
    const byConfluence = {};

    for (const s of activeSignals) {
      if (s.status === "SETTLED") {
        settled++;
        if (s.result === "WIN") wins++;
        else if (s.result === "LOSS") losses++;
        else if (s.result === "DOJI") dojis++;

        netProfitUnits += s.pnlUnits || 0;

        // Por estratégia
        const stratKey = s.strategyName;
        if (!byStrategy[stratKey]) byStrategy[stratKey] = { wins: 0, losses: 0, dojis: 0, total: 0 };
        byStrategy[stratKey].total++;
        if (s.result === "WIN") byStrategy[stratKey].wins++;
        else if (s.result === "LOSS") byStrategy[stratKey].losses++;
        else byStrategy[stratKey].dojis++;

        // Por subestratégia específica
        const subKey = s.subStrategy || s.strategyName;
        if (!bySubStrategy[subKey]) bySubStrategy[subKey] = { wins: 0, losses: 0, dojis: 0, total: 0 };
        bySubStrategy[subKey].total++;
        if (s.result === "WIN") bySubStrategy[subKey].wins++;
        else if (s.result === "LOSS") bySubStrategy[subKey].losses++;
        else bySubStrategy[subKey].dojis++;

        // Por confluência
        const confKey = s.isConfluence ? `Confluência ${s.confluenceCount}/5` : "Individual (1/5)";
        if (!byConfluence[confKey]) byConfluence[confKey] = { wins: 0, losses: 0, dojis: 0, total: 0 };
        byConfluence[confKey].total++;
        if (s.result === "WIN") byConfluence[confKey].wins++;
        else if (s.result === "LOSS") byConfluence[confKey].losses++;
        else byConfluence[confKey].dojis++;
      }
    }

    // Win Rate excluindo dojis
    const validCount = wins + losses;
    const winRate = validCount > 0 ? (wins / validCount) * 100 : 0;

    this.stats = {
      total,
      settled,
      wins,
      losses,
      dojis,
      winRate: Number(winRate.toFixed(1)),
      netProfitUnits: Number(netProfitUnits.toFixed(2)),
      byStrategy,
      bySubStrategy,
      byConfluence,
    };
  }

  /**
   * Persiste sinais transacionalmente no IndexedDB (R3) com fallback transitório para os últimos 10
   * @private
   */
  async _persistStorage() {
    const signals = this.signals.slice(0, 150);
    for (const signal of signals) {
      const chave = signal.id || `${signal.symbol}:${signal.timeframeSeconds || signal.timeframe || 60}:${signal.candleTimestamp || signal.timestamp}:${signal.strategyVersion || "1.0.0"}`;
      const record = {
        ...signal,
        id: chave,
        tabId: this.tabId,
        committed: true,
      };

      // Gravação local imediata
      try {
        await signalStore.putSignal(record);
      } catch (_) {}

      // Gravação durável no contexto da extensão via SW
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
          chrome.runtime.sendMessage({
            type: "ORACLE_RECORD_SIGNAL",
            signal: record,
          }, () => {});
        } catch (_) {}
      }
    }

    // Fallback opcional apenas para os últimos 10 sinais (conforme R3)
    if (typeof chrome !== "undefined" && chrome.storage?.local && this.tabId) {
      try {
        chrome.storage.local.set({
          [`ifx:tab:${this.tabId}:signals`]: this.signals.slice(0, 10),
        });
      } catch (_) {}
    }
  }

  getSignals() {
    return [...this.signals];
  }

  getStats() {
    return { ...this.stats };
  }

  clear() {
    this.signals = [];
    this.stats = {
      total: 0,
      settled: 0,
      wins: 0,
      losses: 0,
      dojis: 0,
      winRate: 0,
      netProfitUnits: 0,
      byStrategy: {},
      bySubStrategy: {},
      byConfluence: {},
    };
    this._persistStorage();
  }
}

export const signalAuditor = new SignalAuditor();
