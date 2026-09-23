/**
 * intraminute-tracker.js - Rastreador de Microestrutura Intraminuto e Fluxo de Ticks
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Acumular os ticks recebidos em tempo real durante a formação de cada vela M1.
 * - Extrair dinamicamente grandezas de microestrutura:
 *     1. Contagem e magnitude de upticks / downticks
 *     2. Pressão Direcional Contínua (Pressure_t)
 *     3. Velocidade da Pressão (Velocity) e Aceleração da Pressão (Acceleration)
 *     4. Taxa de chegada de ticks e aceleração de fluxo
 *     5. Tempo relativo próximo da máxima e mínima
 *     6. Reversões e direção dos últimos N ticks
 * - Ao fechar a vela, arquivar um resumo determinístico e reiniciar o acumulador.
 */

export class IntraminuteTracker {
  constructor(options = {}) {
    this.maxTicksPerCandle = options.maxTicksPerCandle || 500;
    /** @type {Map<string, { currentCandleTimestamp: number, ticks: Array<{ price: number, timeMs: number, delta: number }>, closedMetrics: Map<number, Object> }>} */
    this.series = new Map();
  }

  _getKey(symbol, timeframeSeconds = 60) {
    return `${String(symbol || "").trim().toUpperCase()}:${Number(timeframeSeconds)}`;
  }

  _getOrCreate(symbol, timeframeSeconds) {
    const key = this._getKey(symbol, timeframeSeconds);
    if (!this.series.has(key)) {
      this.series.set(key, {
        currentCandleTimestamp: 0,
        ticks: [],
        closedMetrics: new Map(),
      });
    }
    return this.series.get(key);
  }

  /**
   * Registra um tick recebido no stream em tempo real.
   *
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} price
   * @param {number} candleTimestamp - Timestamp da vela aberta atual (em segundos epoch)
   * @param {number} [timeMs] - Timestamp em milissegundos
   */
  recordTick(symbol, timeframeSeconds, price, candleTimestamp, timeMs = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;

    const data = this._getOrCreate(symbol, timeframeSeconds);

    // Se mudou a vela pelo candleTimestamp, arquiva a anterior e reseta
    if (data.currentCandleTimestamp > 0 && candleTimestamp !== data.currentCandleTimestamp) {
      this.sealCandle(symbol, timeframeSeconds, data.currentCandleTimestamp);
      data.ticks = [];
    }

    data.currentCandleTimestamp = candleTimestamp;

    const prevPrice = data.ticks.length > 0 ? data.ticks[data.ticks.length - 1].price : price;
    const delta = price - prevPrice;

    data.ticks.push({
      price,
      timeMs,
      delta,
    });

    if (data.ticks.length > this.maxTicksPerCandle) {
      data.ticks.shift();
    }
  }

  /**
   * Computa as métricas de microestrutura do buffer atual ou de uma lista de ticks.
   *
   * @param {Array<{ price: number, timeMs: number, delta: number }>} ticks
   * @param {number} [candleOpen]
   * @param {number} [candleHigh]
   * @param {number} [candleLow]
   * @param {number} [candleClose]
   * @returns {Object}
   */
  computeMetrics(ticks = [], candleOpen = null, candleHigh = null, candleLow = null, candleClose = null) {
    const n = ticks.length;
    if (n < 2) {
      return {
        tickCount: n,
        uptickCount: 0,
        downtickCount: 0,
        flatTickCount: n,
        pressure: 0,
        pressureVelocity: 0,
        pressureAcceleration: 0,
        tickArrivalRate: 0,
        tickArrivalAcceleration: 0,
        timeNearHighRatio: 0.5,
        timeNearLowRatio: 0.5,
        lastTicksDirection: 0,
        reversalCount: 0,
        flowImbalance: 0,
      };
    }

    let upticks = 0;
    let downticks = 0;
    let flatTicks = 0;
    let sumUp = 0;
    let sumDown = 0;

    let prevSign = 0;
    let reversals = 0;

    for (let i = 1; i < n; i++) {
      const d = ticks[i].delta;
      if (d > 0) {
        upticks++;
        sumUp += d;
        if (prevSign === -1) reversals++;
        prevSign = 1;
      } else if (d < 0) {
        downtickMagnitudeSum:
        downticks++;
        sumDown += Math.abs(d);
        if (prevSign === 1) reversals++;
        prevSign = -1;
      } else {
        flatTicks++;
      }
    }

    const totalDelta = sumUp + sumDown;
    const pressure = totalDelta > 0 ? (sumUp - sumDown) / totalDelta : 0;

    // Velocidade e Aceleração da Pressão: divide em 3 terços temporais
    const third = Math.max(1, Math.floor(n / 3));
    const p1 = this._subPressure(ticks.slice(0, third));
    const p2 = this._subPressure(ticks.slice(third, third * 2));
    const p3 = this._subPressure(ticks.slice(third * 2));

    const pressureVelocity = p3 - p2;
    const pressureAcceleration = (p3 - p2) - (p2 - p1);

    // Velocidade de chegada dos ticks (ticks/seg)
    const totalTimeMs = Math.max(100, ticks[n - 1].timeMs - ticks[0].timeMs);
    const tickArrivalRate = (n / (totalTimeMs / 1000));

    // Aceleração do fluxo de chegada (2ª metade vs 1ª metade)
    const half = Math.max(1, Math.floor(n / 2));
    const timeHalf1 = Math.max(50, ticks[half - 1].timeMs - ticks[0].timeMs);
    const timeHalf2 = Math.max(50, ticks[n - 1].timeMs - ticks[half].timeMs);
    const rate1 = (half / (timeHalf1 / 1000));
    const rate2 = ((n - half) / (timeHalf2 / 1000));
    const tickArrivalAcceleration = rate2 - rate1;

    // Posição no range da vela
    let high = candleHigh;
    let low = candleLow;
    if (high === null || low === null || high <= low) {
      const prices = ticks.map((t) => t.price);
      high = Math.max(...prices);
      low = Math.min(...prices);
    }

    const range = high - low;
    let nearHighCount = 0;
    let nearLowCount = 0;
    if (range > 0) {
      const highThresh = low + range * 0.70;
      const lowThresh = low + range * 0.30;
      for (const t of ticks) {
        if (t.price >= highThresh) nearHighCount++;
        if (t.price <= lowThresh) nearLowCount++;
      }
    }

    const timeNearHighRatio = n > 0 ? nearHighCount / n : 0.5;
    const timeNearLowRatio = n > 0 ? nearLowCount / n : 0.5;

    // Direção dos últimos 10 ticks
    const lastWindow = ticks.slice(-10);
    const lastDir = lastWindow.length >= 2 ? (lastWindow[lastWindow.length - 1].price - lastWindow[0].price) : 0;
    const lastTicksDirection = lastDir > 0 ? 1 : lastDir < 0 ? -1 : 0;

    // Desbalanceamento de fluxo
    const flowImbalance = (upticks + downticks) > 0 ? (upticks - downticks) / (upticks + downticks) : 0;

    return {
      tickCount: n,
      uptickCount: upticks,
      downtickCount: downticks,
      flatTickCount: flatTicks,
      pressure: Number(pressure.toFixed(4)),
      pressureVelocity: Number(pressureVelocity.toFixed(4)),
      pressureAcceleration: Number(pressureAcceleration.toFixed(4)),
      tickArrivalRate: Number(tickArrivalRate.toFixed(2)),
      tickArrivalAcceleration: Number(tickArrivalAcceleration.toFixed(2)),
      timeNearHighRatio: Number(timeNearHighRatio.toFixed(3)),
      timeNearLowRatio: Number(timeNearLowRatio.toFixed(3)),
      lastTicksDirection,
      reversalCount: reversals,
      flowImbalance: Number(flowImbalance.toFixed(4)),
    };
  }

  _subPressure(slice) {
    if (!slice || slice.length < 2) return 0;
    let up = 0;
    let down = 0;
    for (let i = 1; i < slice.length; i++) {
      const d = slice[i].delta;
      if (d > 0) up += d;
      else if (d < 0) down += Math.abs(d);
    }
    const tot = up + down;
    return tot > 0 ? (up - down) / tot : 0;
  }

  /**
   * Finaliza e arquiva o resumo de microestrutura de uma vela que acabou de fechar.
   *
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} candleTimestamp
   */
  sealCandle(symbol, timeframeSeconds, candleTimestamp) {
    const data = this._getOrCreate(symbol, timeframeSeconds);
    if (!data || data.ticks.length === 0) return null;

    const metrics = this.computeMetrics(data.ticks);
    data.closedMetrics.set(candleTimestamp, {
      ...metrics,
      timestamp: candleTimestamp,
      symbol: String(symbol).toUpperCase(),
    });

    // Mantém no máximo 100 resumos na memória para cada par
    if (data.closedMetrics.size > 100) {
      const oldestKey = data.closedMetrics.keys().next().value;
      data.closedMetrics.delete(oldestKey);
    }

    return metrics;
  }

  /**
   * Obtém as métricas de microestrutura da vela aberta em tempo real.
   *
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} [candleOpen]
   * @param {number} [candleHigh]
   * @param {number} [candleLow]
   * @param {number} [candleClose]
   * @returns {Object}
   */
  getCurrentMetrics(symbol, timeframeSeconds, candleOpen, candleHigh, candleLow, candleClose) {
    const data = this._getOrCreate(symbol, timeframeSeconds);
    return this.computeMetrics(data.ticks, candleOpen, candleHigh, candleLow, candleClose);
  }

  /**
   * Obtém as métricas arquivadas de uma vela já fechada.
   *
   * @param {string} symbol
   * @param {number} timeframeSeconds
   * @param {number} candleTimestamp
   * @returns {Object|null}
   */
  getClosedMetrics(symbol, timeframeSeconds, candleTimestamp) {
    const data = this._getOrCreate(symbol, timeframeSeconds);
    return data.closedMetrics.get(candleTimestamp) || null;
  }
}

export const intraminuteTracker = new IntraminuteTracker();
