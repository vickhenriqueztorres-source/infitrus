/**
 * data-quality.js - Máquina de Estados de Sincronização e Qualidade do Feed
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Controlar a máquina de estados determinística por ativo/timeframe:
 *     BOOTING -> SYNCING_HISTORY -> SYNCING_REALTIME -> READY
 *     Transições para: DATA_GAP, STALE, RECONNECTING
 * - Garantir o princípio sagrado do PRD: "NENHUM SINAL FORA DO ESTADO READY".
 * - Detectar perda de dados (stale feed > 15s) e lacunas temporais (gaps).
 * - Monitorar contadores de anomalias (out of order, gaps, reconexões).
 */

export const MarketState = Object.freeze({
  BOOTING: "BOOTING",
  SYNCING_HISTORY: "SYNCING_HISTORY",
  SYNCING_REALTIME: "SYNCING_REALTIME",
  READY: "READY",
  STALE: "STALE",
  DATA_GAP: "DATA_GAP",
  RECONNECTING: "RECONNECTING",
});

/**
 * @typedef {Object} QualityReport
 * @property {string} symbol
 * @property {number} timeframeSeconds
 * @property {string} state - Um dos valores de MarketState
 * @property {boolean} isReady - True apenas se o estado for READY
 * @property {number} lastDataReceivedAt - Timestamp em ms da última mensagem
 * @property {number} dataAgeSeconds - Idade do último dado em segundos
 * @property {number} historyBarsLoaded - Quantidade de barras históricas carregadas
 * @property {number} gapCount - Total de gaps detectados
 * @property {number} outOfOrderCount - Total de dados fora de ordem descartados
 * @property {string|null} lastError - Último motivo de erro ou alerta
 */

export class DataQualityTracker {
  /**
   * @param {Object} [config={}]
   * @param {number} [config.staleTimeoutMs=15000] - Tempo limite em ms sem dados para declarar STALE
   * @param {number} [config.minHistoryBars=20] - Mínimo de velas históricas para liberar SYNCING_REALTIME
   */
  constructor(config = {}) {
    this.staleTimeoutMs = config.staleTimeoutMs || 15000;
    this.minHistoryBars = config.minHistoryBars || 20;

    /** @type {Map<string, Object>} */
    this.records = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * Chave única da série.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @returns {string}
   */
  getSeriesKey(symbol, timeframeSeconds) {
    return `${String(symbol).trim().toUpperCase()}:${Number(timeframeSeconds)}`;
  }

  /**
   * Obtém ou inicializa o registro de estado de uma série.
   * @private
   */
  _getOrCreateRecord(symbol, timeframeSeconds) {
    const key = this.getSeriesKey(symbol, timeframeSeconds);
    if (!this.records.has(key)) {
      this.records.set(key, {
        symbol: String(symbol).trim().toUpperCase(),
        timeframeSeconds: Number(timeframeSeconds),
        state: MarketState.BOOTING,
        lastDataReceivedAt: 0,
        historyBarsLoaded: 0,
        gapCount: 0,
        outOfOrderCount: 0,
        lastError: null,
      });
    }
    return this.records.get(key);
  }

  /**
   * Retorna o estado atual da série.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @returns {string}
   */
  getState(symbol, timeframeSeconds) {
    const rec = this._getOrCreateRecord(symbol, timeframeSeconds);
    return rec.state;
  }

  /**
   * Indica se o sistema está em estado de operação plena (READY).
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @returns {boolean}
   */
  isReady(symbol, timeframeSeconds) {
    return this.getState(symbol, timeframeSeconds) === MarketState.READY;
  }

  /**
   * Notifica que a carga de histórico foi solicitada/iniciada.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   */
  onStartHistorySync(symbol, timeframeSeconds) {
    const rec = this._getOrCreateRecord(symbol, timeframeSeconds);
    this._transitionTo(rec, MarketState.SYNCING_HISTORY, "Iniciando carga de histórico");
  }

  /**
   * Notifica conclusão da carga de histórico REST.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} barsCount
   */
  onHistoryLoaded(symbol, timeframeSeconds, barsCount) {
    const rec = this._getOrCreateRecord(symbol, timeframeSeconds);
    rec.historyBarsLoaded = barsCount;
    rec.lastDataReceivedAt = Date.now();

    if (barsCount >= this.minHistoryBars) {
      this._transitionTo(
        rec,
        MarketState.SYNCING_REALTIME,
        `Histórico suficiente carregado (${barsCount} barras)`
      );
    } else {
      rec.lastError = `Histórico insuficiente (${barsCount}/${this.minHistoryBars} barras)`;
      this._transitionTo(rec, MarketState.SYNCING_HISTORY, rec.lastError);
    }
  }

  /**
   * Trata o resultado de uma ingestão em tempo real do CandleStore.
   *
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {import("./candle-store.js").IngestResult} ingestResult
   * @param {number} [now=Date.now()]
   */
  onRealtimeUpdate(symbol, timeframeSeconds, ingestResult, now = Date.now()) {
    const rec = this._getOrCreateRecord(symbol, timeframeSeconds);
    rec.lastDataReceivedAt = now;

    if (!ingestResult) return;

    // Caso de Lacuna (DATA_GAP)
    if (ingestResult.status === "DATA_GAP") {
      rec.gapCount += 1;
      rec.lastError = `Gap detectado: ${ingestResult.gapFrom} até ${ingestResult.gapTo}`;
      this._transitionTo(rec, MarketState.DATA_GAP, rec.lastError);
      return;
    }

    // Caso de dados fora de ordem
    if (ingestResult.status === "OUT_OF_ORDER") {
      rec.outOfOrderCount += 1;
      rec.lastError = `Dado descartado fora de ordem: timestamp ${ingestResult.candleTimestamp}`;
      return;
    }

    // Caso de dado inválido
    if (ingestResult.status === "INVALID_DATA") {
      rec.lastError = `Dado inválido rejeitado: ${ingestResult.errors?.join("; ")}`;
      return;
    }

    // Transição de SYNCING_HISTORY, SYNCING_REALTIME, BOOTING ou RECONNECTING para READY após conciliação
    if (
      rec.state === MarketState.SYNCING_HISTORY ||
      rec.state === MarketState.SYNCING_REALTIME ||
      rec.state === MarketState.BOOTING ||
      rec.state === MarketState.RECONNECTING
    ) {
      if (
        ingestResult.status === "UPDATED" ||
        ingestResult.status === "NEW_CANDLE" ||
        ingestResult.status === "INITIALIZED"
      ) {
        this._transitionTo(rec, MarketState.READY, "Feed de tempo real conciliado e ativo");
      }
    } else if (rec.state === MarketState.STALE) {
      // Recuperação de STALE
      this._transitionTo(rec, MarketState.READY, "Feed retomado após inatividade");
    }
  }

  /**
   * Verificação periódica de inatividade (Heartbeat check).
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} [now=Date.now()]
   */
  checkStale(symbol, timeframeSeconds, now = Date.now()) {
    const rec = this._getOrCreateRecord(symbol, timeframeSeconds);
    if (rec.state === MarketState.READY) {
      const ageMs = now - rec.lastDataReceivedAt;
      if (ageMs > this.staleTimeoutMs) {
        this._transitionTo(
          rec,
          MarketState.STALE,
          `Inatividade no feed: ${Math.round(ageMs / 1000)}s sem novas mensagens`
        );
      }
    }
  }

  /**
   * Notifica queda de rede ou desconexão do WebSocket.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   */
  onDisconnect(symbol, timeframeSeconds) {
    const rec = this._getOrCreateRecord(symbol, timeframeSeconds);
    this._transitionTo(rec, MarketState.RECONNECTING, "WebSocket desconectado");
  }

  /**
   * Notifica reconexão da rede/socket, exigindo nova ressincronização.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   */
  onReconnect(symbol, timeframeSeconds) {
    const rec = this._getOrCreateRecord(symbol, timeframeSeconds);
    this._transitionTo(rec, MarketState.SYNCING_HISTORY, "Reconectado; sincronizando histórico");
  }

  /**
   * Gera relatório detalhado da qualidade e estado da série.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} [now=Date.now()]
   * @returns {QualityReport}
   */
  getReport(symbol, timeframeSeconds, now = Date.now()) {
    const rec = this._getOrCreateRecord(symbol, timeframeSeconds);
    const ageSeconds = rec.lastDataReceivedAt > 0 ? Math.round((now - rec.lastDataReceivedAt) / 1000) : -1;

    return {
      symbol: rec.symbol,
      timeframeSeconds: rec.timeframeSeconds,
      state: rec.state,
      isReady: rec.state === MarketState.READY,
      lastDataReceivedAt: rec.lastDataReceivedAt,
      dataAgeSeconds: ageSeconds,
      historyBarsLoaded: rec.historyBarsLoaded,
      gapCount: rec.gapCount,
      outOfOrderCount: rec.outOfOrderCount,
      lastError: rec.lastError,
    };
  }

  /**
   * Assina notificações de mudança de estado da série.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {Function} callback
   * @returns {Function} Unsubscribe
   */
  subscribe(symbol, timeframeSeconds, callback) {
    const key = this.getSeriesKey(symbol, timeframeSeconds);
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    const set = this.listeners.get(key);
    set.add(callback);

    return () => {
      set.delete(callback);
      if (set.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  /**
   * Executa a transição de estado se houver alteração.
   * @private
   */
  _transitionTo(rec, newState, reason) {
    const oldState = rec.state;
    if (oldState === newState) return;

    rec.state = newState;
    const key = this.getSeriesKey(rec.symbol, rec.timeframeSeconds);
    const set = this.listeners.get(key);
    if (set) {
      for (const cb of set) {
        try {
          cb({ oldState, newState, reason, report: this.getReport(rec.symbol, rec.timeframeSeconds) });
        } catch (err) {
          console.error(`[DataQuality] Erro no listener de ${key}:`, err);
        }
      }
    }
  }
}
