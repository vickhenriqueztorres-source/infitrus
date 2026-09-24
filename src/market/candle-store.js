/**
 * candle-store.js - Armazenamento de Séries Temporais e Regras de Fechamento
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Manter séries ordenadas por ativo e timeframe: [symbol, timeframeSeconds].
 * - Substituir o modelo simples de empilhamento por máquina de ingestão determinística:
 *     1. Mesmo timestamp: atualiza vela aberta existente (UPDATED).
 *     2. Próximo timestamp contíguo: fecha a vela anterior (closed=true) e insere nova (NEW_CANDLE).
 *     3. Timestamp atrasado: descarta e sinaliza (OUT_OF_ORDER).
 *     4. Timestamp com salto temporal: registra lacuna e sinaliza (DATA_GAP).
 * - Prevenir vazamento de memória com buffer circular/limite configurável (default 500).
 * - Notificar assinantes sobre fechamento de vela e gaps.
 */

import { isValidCandle, validateCandle } from "./candle-validator.js";
import { rec } from "../diagnostics/flight-recorder.js";

/**
 * @typedef {Object} IngestResult
 * @property {"INITIALIZED" | "UPDATED" | "NEW_CANDLE" | "DATA_GAP" | "OUT_OF_ORDER" | "INVALID_DATA"} status
 * @property {import("./candle-normalizer.js").Candle} [candle]
 * @property {import("./candle-normalizer.js").Candle} [closedCandle]
 * @property {number} [gapFrom]
 * @property {number} [gapTo]
 * @property {string[]} [errors]
 */

export class CandleStore {
  /**
   * @param {Object|number|string} [configOrTabId={}]
   * @param {number} [configOrTabId.maxCandlesPerSeries=500] - Limite máximo de velas mantidas por série
   * @param {number} [configOrTabId.freezeDelay=3000] - Tempo de espera até congelar vela fechada (ms)
   * @param {number|string} [configOrTabId.tabId] - ID da aba vinculada
   */
  constructor(configOrTabId = {}) {
    let config = {};
    let tabId = null;
    if (typeof configOrTabId === "object" && configOrTabId !== null) {
      config = configOrTabId;
      tabId = config.tabId || null;
    } else if (typeof configOrTabId === "number" || typeof configOrTabId === "string") {
      tabId = configOrTabId;
    }

    this.tabId = tabId;
    this.maxCandlesPerSeries = config.maxCandlesPerSeries || 500;
    this.FREEZE_DELAY = config.freezeDelay !== undefined ? config.freezeDelay : 3000;
    /** @type {Map<string, import("./candle-normalizer.js").Candle[]>} */
    this.series = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** @type {Map<string, Object>} */
    this.candles = new Map();
    /** @type {Map<string, any>} */
    this.freezeTimers = new Map();
  }

  /**
   * Registra log no flight recorder unificado.
   * @private
   */
  _logFlight(eventType, payload) {
    if (typeof rec === "function") {
      rec(eventType, payload, { tabId: this.tabId });
    }
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: "FLIGHT_RECORDER_LOG",
          eventType,
          payload,
          tabId: this.tabId,
        }).catch(() => {});
      } catch (_) {}
    }
  }

  /**
   * Marca candle como fechado e inicia timer de congelamento.
   * Só congela após N segundos sem novos ticks.
   * @param {Object} candle
   */
  markCandleClosed(candle) {
    if (!candle) return;
    const tf = candle.timeframe || candle.timeframeSeconds || 60;
    const key = this.getSeriesKey(candle.symbol, tf);

    // Se já havia timer para este canal, consolida o anterior como congelado
    if (this.freezeTimers.has(key)) {
      const prevEntry = this.freezeTimers.get(key);
      const prevTimerId = prevEntry?.timerId || prevEntry;
      clearTimeout(prevTimerId);
      this.freezeTimers.delete(key);
      const prev = prevEntry?.candle || this.candles.get(key);
      if (prev) {
        prev.frozen = true;
      }
    }

    candle.closed = true;
    candle.frozen = false;

    const timerId = setTimeout(() => {
      candle.frozen = true;
      this.freezeTimers.delete(key);

      this._logFlight("CANDLE_FROZEN", {
        symbol: candle.symbol,
        timeframe: tf,
        timestamp: candle.timestamp,
      });
    }, this.FREEZE_DELAY);

    if (timerId && typeof timerId.unref === "function") {
      timerId.unref();
    }

    this.freezeTimers.set(key, { timerId, candle });
  }

  /**
   * Se chegar tick novo no candle "quase congelado", cancela congelamento e reabre candle.
   * @param {string} symbol
   * @param {number|string} timeframe
   */
  cancelFreezeTimer(symbol, timeframe) {
    const key = this.getSeriesKey(symbol, timeframe);
    if (this.freezeTimers.has(key)) {
      const entry = this.freezeTimers.get(key);
      const timerId = entry?.timerId || entry;
      clearTimeout(timerId);
      this.freezeTimers.delete(key);

      let candle = entry?.candle || this.candles.get(key);
      if (!candle) {
        const list = this.series.get(key);
        if (list && list.length > 0) candle = list[list.length - 1];
      }
      if (candle && candle.closed && !candle.frozen) {
        candle.closed = false;
        this._logFlight("CANDLE_REOPENED", {
          symbol,
          timeframe,
          timestamp: candle.timestamp,
          reason: "TICK_DURANTE_FREEZE_TIMER",
        });
      }
    }
  }

  /**
   * Aplica tick com janela de tolerância estrita.
   * Rejeita ticks que tentem reabrir candle já fechado + margem.
   * @param {Object} tick
   * @returns {{ action: "CREATED" | "UPDATED" | "REJECTED", candle?: Object, reason?: string }}
   */
  applyTick(tick) {
    const { symbol, timeframe, timestamp, open, high, low, close } = tick;
    const tf = timeframe || tick.timeframeSeconds || 60;
    const key = this.getSeriesKey(symbol, tf);

    let candle = this.candles.get(key);
    if (!candle) {
      candle = {
        symbol,
        timeframe: tf,
        timeframeSeconds: tf,
        timestamp: Math.floor(timestamp / 60) * 60,
        open,
        high,
        low,
        close,
        closed: false,
        frozen: false,
      };
      this.candles.set(key, candle);
      return { action: "CREATED", candle };
    }

    const isSeconds = (timestamp > 1000000 && timestamp < 1e11) || (candle.timestamp > 1000000 && candle.timestamp < 1e11);
    const tfNum = typeof tf === "number" ? tf : (Number(tf) || 60);
    const limitOld = isSeconds ? candle.timestamp + tfNum : candle.timestamp + 60000;
    const candleCloseTime = isSeconds ? candle.timestamp + tfNum : candle.timestamp + (tfNum * 1000);
    const tolerance = isSeconds ? 2 : 2000;

    // REGRA 1: Rejeitar ticks que pertençam a candle já fechado
    // Tolerância: no máximo até candle.timestamp + 60s
    if (timestamp <= limitOld) {
      this._logFlight("TICK_REJECTED_OUT_OF_ORDER", {
        symbol,
        timeframe: tf,
        tickTimestamp: timestamp,
        candleTimestamp: candle.timestamp,
        reason: "TICK_ANTIGO_CANDLE_FECHADO",
      });
      return { action: "REJECTED", reason: "TICK_ANTIGO_CANDLE_FECHADO" };
    }

    // REGRA 2: Margem de tolerância (+2s após fechamento)
    // Ticks até +2s ainda são aceitos no candle atual; após +2s, novo candle OBRIGATÓRIO
    if (timestamp > candleCloseTime + tolerance) {
      this._logFlight("TICK_REJECTED_OUT_OF_ORDER", {
        symbol,
        timeframe: tf,
        tickTimestamp: timestamp,
        candleTimestamp: candle.timestamp,
        candleCloseTime,
        reason: "TICK_MUITO_ATRASADO",
      });
      return { action: "REJECTED", reason: "TICK_MUITO_ATRASADO" };
    }

    // Se passou pelas guardas, atualiza candle
    candle.high = Math.max(candle.high, high);
    candle.low = Math.min(candle.low, low);
    candle.close = close;

    return { action: "UPDATED", candle };
  }

  /**
   * Gera a chave única de série.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @returns {string}
   */
  getSeriesKey(symbol, timeframeSeconds) {
    return `${String(symbol).trim().toUpperCase()}:${Number(timeframeSeconds)}`;
  }

  /**
   * Ingestão determinística de um candle na série correta.
   *
   * @param {import("./candle-normalizer.js").Candle} candle
   * @returns {IngestResult}
   */
  ingest(candle) {
    // 1. Validação prévia de coerência matemática e integridade
    const validation = validateCandle(candle);
    if (!validation.valid) {
      return { status: "INVALID_DATA", errors: validation.errors };
    }

    const key = this.getSeriesKey(candle.symbol, candle.timeframeSeconds);
    if (!this.series.has(key)) {
      this.series.set(key, []);
    }

    const list = this.series.get(key);
    const last = list.length > 0 ? list[list.length - 1] : null;

    // Caso 1: Primeiro candle da série
    if (!last) {
      const isClosed = Boolean(candle.closed);
      const firstCandle = {
        ...candle,
        closed: isClosed,
        frozen: Boolean(candle.frozen),
      };
      list.push(firstCandle);
      this.candles.set(key, firstCandle);
      const result = { status: "INITIALIZED", candle: list[0] };
      this._emit(key, "initialized", result);
      return result;
    }

    // Caso 2: Mesmo timestamp -> Atualização da vela aberta existente
    if (candle.timestamp === last.timestamp) {
      // Se a vela já estiver congelada, rejeita qualquer mutação retroativa
      if (last.frozen) {
        this._logFlight("TICK_REJECTED_OUT_OF_ORDER", {
          symbol: candle.symbol,
          timeframe: candle.timeframeSeconds,
          tickTimestamp: candle.timestamp,
          candleTimestamp: last.timestamp,
          reason: "CANDLE_ALREADY_FROZEN",
        });
        return {
          status: "OUT_OF_ORDER",
          candle,
          lastTimestamp: last.timestamp,
          candleTimestamp: candle.timestamp,
          frozen: true,
        };
      }

      // Se chegar tick novo no candle "quase congelado" (timer ativo), cancela timer e reabre
      this.cancelFreezeTimer(candle.symbol, candle.timeframeSeconds);

      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      if (candle.volume !== undefined) {
        last.volume = candle.volume;
      }
      last.receivedAt = candle.receivedAt;
      last.closed = false;
      last.frozen = false;

      const result = { status: "UPDATED", candle: last };
      this._emit(key, "updated", result);
      return result;
    }

    // Caso 3: Próximo candle sequencial contíguo
    const expectedNextTimestamp = last.timestamp + candle.timeframeSeconds;
    if (candle.timestamp === expectedNextTimestamp) {
      this.markCandleClosed(last);
      const closedCandleCopy = { ...last };

      const isNewClosed = Boolean(candle.closed);
      const newCandle = {
        ...candle,
        closed: isNewClosed,
        frozen: Boolean(candle.frozen),
      };
      list.push(newCandle);
      this.candles.set(key, newCandle);

      // Limite de memória da série
      if (list.length > this.maxCandlesPerSeries) {
        list.shift();
      }

      const result = {
        status: "NEW_CANDLE",
        closedCandle: closedCandleCopy,
        candle: newCandle,
      };

      this._emit(key, "candle_closed", closedCandleCopy);
      this._emit(key, "new_candle", result);
      return result;
    }

    // Caso 4: Lacuna temporal (DATA_GAP)
    if (candle.timestamp > expectedNextTimestamp) {
      this.markCandleClosed(last);
      const closedCandleCopy = { ...last };

      const isNewClosed = Boolean(candle.closed);
      const newCandle = {
        ...candle,
        closed: isNewClosed,
        frozen: Boolean(candle.frozen),
      };
      list.push(newCandle);
      this.candles.set(key, newCandle);

      if (list.length > this.maxCandlesPerSeries) {
        list.shift();
      }

      const result = {
        status: "DATA_GAP",
        closedCandle: closedCandleCopy,
        candle: newCandle,
        gapFrom: expectedNextTimestamp,
        gapTo: candle.timestamp - candle.timeframeSeconds,
      };

      this._emit(key, "data_gap", result);
      return result;
    }

    // Caso 5: Timestamp menor que o último (OUT_OF_ORDER / BACKLOG)
    this._logFlight("TICK_REJECTED_OUT_OF_ORDER", {
      symbol: candle.symbol,
      timeframe: candle.timeframeSeconds,
      tickTimestamp: candle.timestamp,
      candleTimestamp: last.timestamp,
      reason: "TIMESTAMP_MENOR_QUE_ULTIMO",
    });
    return {
      status: "OUT_OF_ORDER",
      candle,
      lastTimestamp: last.timestamp,
      candleTimestamp: candle.timestamp,
      frozen: Boolean(last.frozen),
    };
  }

  /**
   * Ingestão em lote de velas (ideal para carga inicial de histórico REST).
   *
   * @param {import("./candle-normalizer.js").Candle[]} candles
   * @returns {IngestResult[]}
   */
  ingestBatch(candles) {
    if (!Array.isArray(candles)) return [];
    return candles.map((c) => this.ingest(c));
  }

  /**
   * Retorna a última vela registrada (aberta ou fechada).
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @returns {import("./candle-normalizer.js").Candle|null}
   */
  getLast(symbol, timeframeSeconds) {
    const list = this.series.get(this.getSeriesKey(symbol, timeframeSeconds));
    if (!list || list.length === 0) return null;
    return { ...list[list.length - 1] };
  }

  /**
   * Retorna a última vela confirmada/fechada.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @returns {import("./candle-normalizer.js").Candle|null}
   */
  getLastClosed(symbol, timeframeSeconds) {
    const list = this.series.get(this.getSeriesKey(symbol, timeframeSeconds));
    if (!list || list.length === 0) return null;

    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].closed) {
        return { ...list[i] };
      }
    }
    return null;
  }

  /**
   * Retorna a última vela congelada (imediata e imutável).
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @returns {import("./candle-normalizer.js").Candle|null}
   */
  getLastFrozen(symbol, timeframeSeconds) {
    const list = this.series.get(this.getSeriesKey(symbol, timeframeSeconds));
    if (!list || list.length === 0) return null;

    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].frozen) {
        return { ...list[i] };
      }
    }
    return null;
  }

  /**
   * Retorna até N velas da série.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} [count=100]
   * @returns {import("./candle-normalizer.js").Candle[]}
   */
  getCandles(symbol, timeframeSeconds, count = 100) {
    const list = this.series.get(this.getSeriesKey(symbol, timeframeSeconds));
    if (!list || list.length === 0) return [];
    const slice = list.slice(-count);
    return slice.map((c) => ({ ...c }));
  }

  /**
   * Retorna apenas as velas fechadas da série.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} [count=100]
   * @returns {import("./candle-normalizer.js").Candle[]}
   */
  getClosedCandles(symbol, timeframeSeconds, count = 100) {
    const list = this.series.get(this.getSeriesKey(symbol, timeframeSeconds));
    if (!list || list.length === 0) return [];
    return list
      .filter((c) => c.closed)
      .slice(-count)
      .map((c) => ({ ...c }));
  }

  /**
   * Verifica se a série possui quantidade mínima de velas fechadas para análise.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} [minCount=30]
   * @returns {boolean}
   */
  hasSufficientData(symbol, timeframeSeconds, minCount = 30) {
    const closed = this.getClosedCandles(symbol, timeframeSeconds, minCount);
    return closed.length >= minCount;
  }

  /**
   * Verifica se o store está pronto para análise.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} [minCount=10]
   * @returns {boolean}
   */
  isReady(symbol, timeframeSeconds, minCount = 10) {
    return this.hasSufficientData(symbol, timeframeSeconds, minCount);
  }

  /**
   * Limpa a série em memória.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   */
  clear(symbol, timeframeSeconds) {
    const key = this.getSeriesKey(symbol, timeframeSeconds);
    this.series.delete(key);
  }

  /**
   * Inscreve um ouvinte de eventos na série especificada.
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {Function} callback
   * @returns {Function} Função de cancelamento (unsubscribe)
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
   * Emite eventos para ouvintes registrados.
   * @private
   */
  _emit(key, eventType, data) {
    const set = this.listeners.get(key);
    if (!set || set.size === 0) return;
    for (const cb of set) {
      try {
        cb(eventType, data);
      } catch (err) {
        console.error(`[CandleStore] Erro no ouvinte de ${key}:`, err);
      }
    }
  }
}
