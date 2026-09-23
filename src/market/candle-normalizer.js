/**
 * candle-normalizer.js - Normalizador de Feeds de Mercado
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Converter dados heterogêneos (REST history e WebSocket streaming) para o modelo padrão Candle.
 * - Extrair símbolos tanto de 'pair' (produção) quanto de 'symbol' (legado/fallback).
 * - Extrair OHLCV de envelopes 'messages' com 'name: tick' e payloads diretos.
 * - Converter OBRIGATORIAMENTE timestamps de milissegundos para segundos.
 * - Classificar a origem entre "history" e "websocket".
 */

/**
 * @typedef {Object} Candle
 * @property {string} symbol - Ativo padronizado em maiúsculas (ex: "EURUSD")
 * @property {number} timeframeSeconds - Resolução em segundos (ex: 60)
 * @property {number} timestamp - Timestamp em segundos epoch UTC alinhado
 * @property {number} open - Preço de abertura
 * @property {number} high - Preço de máxima
 * @property {number} low - Preço de mínima
 * @property {number} close - Preço de fechamento
 * @property {number} [volume] - Volume negociado
 * @property {"history" | "websocket" | "aggregated"} source - Origem dos dados
 * @property {boolean} closed - Se a vela está fechada/confirmada
 * @property {number} receivedAt - Timestamp local de recepção em ms
 */

/**
 * Normaliza um timestamp para segundos inteiros.
 * Detecta se a entrada está em milissegundos (ex: > 1e11) e divide por 1000.
 *
 * @param {number|string} rawTime
 * @returns {number} Timestamp em segundos epoch
 */
export function normalizeTimestampToSeconds(rawTime) {
  const num = Number(rawTime);
  if (!Number.isFinite(num) || num <= 0) {
    return NaN;
  }
  // Se for maior que 100 bilhões (ex: 1727010180000), está em milissegundos
  if (num > 1e11) {
    return Math.floor(num / 1000);
  }
  return Math.floor(num);
}

/**
 * Alinha um timestamp em segundos à grade do timeframe.
 * Ex: para timeframeSeconds = 60, alinha no início do minuto.
 *
 * @param {number} timestampSeconds
 * @param {number} timeframeSeconds
 * @returns {number}
 */
export function alignTimestamp(timestampSeconds, timeframeSeconds = 60) {
  if (!Number.isFinite(timestampSeconds) || !Number.isFinite(timeframeSeconds) || timeframeSeconds <= 0) {
    return NaN;
  }
  return Math.floor(timestampSeconds / timeframeSeconds) * timeframeSeconds;
}

/**
 * Normaliza payloads recebidos via WebSocket da B2Trading.
 * Lida com o formato de envelope confirmado em produção:
 * {
 *   "pair": "EURUSD",
 *   "messages": [
 *     { "name": "tick", "data": { "time": 1727010180000, "open": 1.085, "high": 1.086, "low": 1.084, "close": 1.0855, "volume": 100 } }
 *   ]
 * }
 *
 * E mantém compatibilidade com formatos legados ou diretos:
 * { "event": "candle_update", "symbol": "EURUSD", "data": { ... } }
 *
 * @param {any} payload
 * @param {number} [timeframeSeconds=60]
 * @param {Object} [options={}]
 * @returns {Candle[]} Lista de velas normalizadas extraídas do payload
 */
export function normalizeWebSocketPayload(payload, timeframeSeconds = 60, options = {}) {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const results = [];
  const now = options.receivedAt || Date.now();

  // 1. Suporte a payload que é um Array (ex: Socket.IO ["tick", data] ou lista de candles)
  if (Array.isArray(payload)) {
    if (payload.length >= 2 && typeof payload[0] === "string" && typeof payload[1] === "object") {
      return normalizeWebSocketPayload(payload[1], timeframeSeconds, options);
    }
    for (const item of payload) {
      if (item && typeof item === "object") {
        const itemResults = normalizeWebSocketPayload(item, timeframeSeconds, options);
        results.push(...itemResults);
      }
    }
    return results;
  }

  // 2. Identifica o símbolo (prioridade para pair conforme revelado no bundle)
  const rawSymbol = payload.pair || payload.symbol || payload.asset || payload.ticker || options.symbol || "";
  let symbol = String(rawSymbol).trim().toUpperCase();

  // 3. Extração via envelope de produção 'messages'
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    for (const msg of payload.messages) {
      if (!msg || typeof msg !== "object") continue;

      const d = msg.data || msg;
      const msgSym = (msg.pair || msg.symbol || d.pair || d.symbol || symbol).trim().toUpperCase();
      if (d && typeof d === "object") {
        const candle = _buildCandleFromData(d, msgSym, timeframeSeconds, "websocket", false, now);
        if (candle) {
          results.push(candle);
        }
      }
    }
    return results;
  }

  // 4. Fallback: payload direto ou legado com propriedade 'data'
  if (payload.data && typeof payload.data === "object") {
    const d = payload.data;
    const finalSym = (d.pair || d.symbol || symbol).trim().toUpperCase();
    const candle = _buildCandleFromData(d, finalSym, timeframeSeconds, "websocket", false, now);
    if (candle) {
      results.push(candle);
    }
    return results;
  }

  // 5. Fallback: payload plano onde o próprio objeto raiz contém ohlc ou price
  if (
    (payload.open !== undefined && payload.close !== undefined) ||
    payload.price !== undefined ||
    payload.p !== undefined ||
    payload.rate !== undefined ||
    payload.last !== undefined
  ) {
    const candle = _buildCandleFromData(payload, symbol, timeframeSeconds, "websocket", false, now);
    if (candle) {
      results.push(candle);
    }
  }

  return results;
}

/**
 * Normaliza barras de histórico obtidas via REST (/api/market/history).
 * Aceita { bars: [...] }, { bar: {...} } ou array direto [ {...} ].
 *
 * @param {any} rawInput
 * @param {string} symbol
 * @param {number} [timeframeSeconds=60]
 * @param {Object} [options={}]
 * @returns {Candle[]} Lista de velas históricas normalizadas (ordenadas crescentemente)
 */
export function normalizeHistoryBars(rawInput, symbol, timeframeSeconds = 60, options = {}) {
  if (!rawInput) return [];

  const sym = String(symbol || rawInput.pair || rawInput.symbol || "").trim().toUpperCase();
  const now = options.receivedAt || Date.now();

  let rawList = [];
  if (Array.isArray(rawInput)) {
    rawList = rawInput;
  } else if (typeof rawInput === "object") {
    if (Array.isArray(rawInput.bars)) {
      rawList = rawInput.bars;
    } else if (rawInput.bar && typeof rawInput.bar === "object") {
      rawList = [rawInput.bar];
    }
  }

  const candles = [];
  for (const item of rawList) {
    if (!item) continue;

    let candle = null;
    if (Array.isArray(item)) {
      // Suporte a tupla [time, open, high, low, close, volume]
      const [t, o, h, l, c, v] = item;
      candle = _buildCandleFromData(
        { time: t, open: o, high: h, low: l, close: c, volume: v },
        sym,
        timeframeSeconds,
        "history",
        true,
        now
      );
    } else if (typeof item === "object") {
      candle = _buildCandleFromData(item, sym, timeframeSeconds, "history", true, now);
    }

    if (candle) {
      candles.push(candle);
    }
  }

  // Ordena crescentemente por timestamp
  candles.sort((a, b) => a.timestamp - b.timestamp);

  return candles;
}

/**
 * Helper interno para converter objeto com campos time/open/high/low/close em Candle.
 *
 * @private
 */
function _buildCandleFromData(data, symbol, timeframeSeconds, source, closed, receivedAt) {
  let rawTime =
    data.time !== undefined
      ? data.time
      : data.t !== undefined
      ? data.t
      : data.timestamp !== undefined
      ? data.timestamp
      : data.ts !== undefined
      ? data.ts
      : undefined;

  let timeSeconds = normalizeTimestampToSeconds(rawTime);

  // Fallback para streaming em tempo real quando o timestamp não vem explícito
  if (!Number.isFinite(timeSeconds) && source === "websocket") {
    timeSeconds = normalizeTimestampToSeconds(receivedAt || Date.now());
  }

  if (!Number.isFinite(timeSeconds)) {
    return null;
  }

  const alignedTimestamp = alignTimestamp(timeSeconds, timeframeSeconds);

  const fallbackPrice =
    data.price !== undefined
      ? Number(data.price)
      : data.p !== undefined
      ? Number(data.p)
      : data.close !== undefined
      ? Number(data.close)
      : data.c !== undefined
      ? Number(data.c)
      : data.rate !== undefined
      ? Number(data.rate)
      : data.last !== undefined
      ? Number(data.last)
      : data.value !== undefined
      ? Number(data.value)
      : NaN;

  const rawOpen = data.open !== undefined ? data.open : data.o !== undefined ? data.o : fallbackPrice;
  const rawHigh = data.high !== undefined ? data.high : data.h !== undefined ? data.h : fallbackPrice;
  const rawLow = data.low !== undefined ? data.low : data.l !== undefined ? data.l : fallbackPrice;
  const rawClose = data.close !== undefined ? data.close : data.c !== undefined ? data.c : fallbackPrice;

  const open = Number(rawOpen);
  const high = Number(rawHigh);
  const low = Number(rawLow);
  const close = Number(rawClose);

  if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  const rawVol = data.volume !== undefined ? data.volume : data.v !== undefined ? data.v : data.vol;
  const volume = rawVol !== undefined ? Number(rawVol) : undefined;

  const sym = String(
    data.pair || data.symbol || data.asset || data.ticker || data.s || symbol || ""
  ).trim().toUpperCase();

  return {
    symbol: sym,
    timeframeSeconds,
    timestamp: alignedTimestamp,
    open,
    high,
    low,
    close,
    ...(volume !== undefined && Number.isFinite(volume) ? { volume } : {}),
    source,
    closed,
    receivedAt,
  };
}
