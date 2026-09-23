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
   * @param {Object} [config={}]
   * @param {number} [config.maxCandlesPerSeries=500] - Limite máximo de velas mantidas por série
   */
  constructor(config = {}) {
    this.maxCandlesPerSeries = config.maxCandlesPerSeries || 500;
    /** @type {Map<string, import("./candle-normalizer.js").Candle[]>} */
    this.series = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
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
      list.push({ ...candle });
      const result = { status: "INITIALIZED", candle: list[0] };
      this._emit(key, "initialized", result);
      return result;
    }

    // Caso 2: Mesmo timestamp -> Atualização da vela aberta existente
    if (candle.timestamp === last.timestamp) {
      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      if (candle.volume !== undefined) {
        last.volume = candle.volume;
      }
      last.receivedAt = candle.receivedAt;
      // Se a atualização indicar explicitamente fechamento, honra
      if (candle.closed) {
        last.closed = true;
      }

      const result = { status: "UPDATED", candle: last };
      this._emit(key, "updated", result);
      return result;
    }

    // Caso 3: Próximo candle sequencial contíguo
    const expectedNextTimestamp = last.timestamp + candle.timeframeSeconds;
    if (candle.timestamp === expectedNextTimestamp) {
      last.closed = true;
      const closedCandleCopy = { ...last };

      const newCandle = { ...candle, closed: Boolean(candle.closed) };
      list.push(newCandle);

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
      last.closed = true;
      const closedCandleCopy = { ...last };

      const newCandle = { ...candle, closed: Boolean(candle.closed) };
      list.push(newCandle);

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

    // Caso 5: Timestamp menor que o último (OUT_OF_ORDER)
    return {
      status: "OUT_OF_ORDER",
      candle,
      lastTimestamp: last.timestamp,
      candleTimestamp: candle.timestamp,
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
