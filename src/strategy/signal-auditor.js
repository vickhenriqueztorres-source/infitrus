/**
 * signal-auditor.js - Gravador e Auditor de Sinais em Tempo Real
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Armazenar cada sinal disparado em chrome.storage.local (oracle_signals_history).
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

    this._initStorage();
  }

  /**
   * Inicializa e carrega sinais prévios do chrome.storage.local
   * @private
   */
  _initStorage() {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        chrome.storage.local.get(["oracle_signals_history", "oracle_signals_stats"], (res) => {
          if (Array.isArray(res.oracle_signals_history)) {
            this.signals = res.oracle_signals_history;
          }
          if (res.oracle_signals_stats && typeof res.oracle_signals_stats === "object") {
            this.stats = { ...this.stats, ...res.oracle_signals_stats };
          }
        });
      } catch (_) {}
    }
  }

  /**
   * Grava um novo sinal disparado no histórico.
   *
   * @param {Object} signal
   * @param {string} signal.action - 'CALL' ou 'PUT'
   * @param {string} signal.symbol
   * @param {number} signal.timeframeSeconds
   * @param {number} signal.candleTimestamp
   * @param {number} signal.entryPrice
   * @param {number} signal.probability
   * @param {number} signal.ev
   * @param {number} signal.payout
   * @param {string} signal.label
   * @param {boolean} signal.isConfluence
   * @param {Object} [signal.confluence]
   * @param {string} [signal.primaryStrategyName]
   * @param {Array<string>} [signal.reasons]
   * @returns {Object|null}
   */
  recordSignal(signal) {
    if (!signal || signal.action === "WAIT" || !signal.candleTimestamp) {
      return null;
    }

    const id = `sig_${signal.symbol}_${signal.timeframeSeconds}_${signal.candleTimestamp}`;

    // Evita duplicata ou sinais conflitantes para a mesma vela
    if (this.signals.some((s) => s.id === id || (s.symbol === signal.symbol && s.timestamp === signal.candleTimestamp))) {
      return null;
    }

    const dateObj = new Date(signal.candleTimestamp * 1000);
    const timeFormatted = dateObj.toTimeString().split(" ")[0];
    const targetTimestamp = signal.candleTimestamp + (signal.timeframeSeconds || 60);

    const record = {
      id,
      timestamp: signal.candleTimestamp,
      timeFormatted,
      symbol: signal.symbol,
      timeframeSeconds: signal.timeframeSeconds,
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
      status: "PENDING", // PENDING -> SETTLED
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
   * Audita sinais pendentes quando uma nova vela fechada chega.
   *
   * @param {Array<{ timestamp: number, open: number, high: number, low: number, close: number, symbol?: string }>} closedCandles
   * @returns {Array<Object>} Lista de sinais que acabaram de ser liquidados nesta checagem
   */
  auditPendingSignals(closedCandles = []) {
    if (!closedCandles || closedCandles.length === 0) return [];

    const newlySettled = [];
    const candleMap = new Map();
    for (const c of closedCandles) {
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
          // A vela alvo de liquidação fechou!
          const closePrice = targetCandle.close;
          const entryPrice = sig.entryPrice;
          let result = "LOSS";
          let pnlUnits = -1.0;

          if (closePrice > entryPrice) {
            if (sig.direction === "CALL") {
              result = "WIN";
              pnlUnits = Number(sig.payout.toFixed(2));
            } else {
              result = "LOSS";
              pnlUnits = -1.0;
            }
          } else if (closePrice < entryPrice) {
            if (sig.direction === "PUT") {
              result = "WIN";
              pnlUnits = Number(sig.payout.toFixed(2));
            } else {
              result = "LOSS";
              pnlUnits = -1.0;
            }
          } else {
            result = "DOJI";
            pnlUnits = 0.0;
          }

          sig.status = "SETTLED";
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
   * Recalcula todas as estatísticas acumuladas
   * @private
   */
  _recomputeStats() {
    let total = this.signals.length;
    let settled = 0;
    let wins = 0;
    let losses = 0;
    let dojis = 0;
    let netProfitUnits = 0;

    const byStrategy = {};
    const bySubStrategy = {};
    const byConfluence = {};

    for (const s of this.signals) {
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
   * Persiste no chrome.storage.local
   * @private
   */
  _persistStorage() {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      try {
        chrome.storage.local.set({
          oracle_signals_history: this.signals,
          oracle_signals_stats: this.stats,
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
