/**
 * intraminute-tracker.js - Rastreador de Microestrutura Intraminuto e Cinemática de Ticks (Active Quant Optimizer)
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Acumular ticks em buffers circulares Float64Array (zero alocação em alta frequência)
 * - Calcular Cinemática Diferencial em Tempo Real:
 *     1. Velocidade instantânea do preço (1ª Derivada): v(t) = dP / dt
 *     2. Aceleração instantânea do preço (2ª Derivada): a(t) = dv / dt
 *     3. Pressão de Fluxo Integrada Não-Linear: F(t) = ∫ sgn(v(τ)) * |v(τ)|^γ dτ
 *     4. Densidade de Probabilidade de Duração (5 quantis de permanência temporal por nível de preço) para distância de Wasserstein-1
 *     5. Trajetória Normalizada (10 pontos reamostrados) para Dynamic Time Warping (DTW)
 *     6. Detecção de Desaceleração Terminal (v > 0 e a << 0 -> Rejeição) e Aceleração Convergente (-> Rompimento)
 */

const GAMMA_FLOW = 1.35;
const DENSITY_BINS = 5;
const TRAJECTORY_POINTS = 10;

export class IntraminuteTracker {
  constructor(options = {}) {
    this.maxTicksPerCandle = options.maxTicksPerCandle || 512;
    this.series = new Map();
  }

  _getKey(symbol, timeframeSeconds = 60) {
    return `${String(symbol || "").trim().toUpperCase()}:${Number(timeframeSeconds)}`;
  }

  _getOrCreate(symbol, timeframeSeconds) {
    const key = this._getKey(symbol, timeframeSeconds);
    if (!this.series.has(key)) {
      const cap = this.maxTicksPerCandle;
      this.series.set(key, {
        currentCandleTimestamp: 0,
        ticks: [],
        // Buffers circulares Float64Array para cálculo diferencial O(1)
        pricesRing: new Float64Array(cap),
        timesRing: new Float64Array(cap),
        deltasRing: new Float64Array(cap),
        velRing: new Float64Array(cap),
        accRing: new Float64Array(cap),
        head: 0,
        count: 0,
        closedMetrics: new Map(),
      });
    }
    return this.series.get(key);
  }

  /**
   * Registra um tick recebido no stream em tempo real e atualiza as derivadas nos buffers circulares.
   */
  recordTick(symbol, timeframeSeconds, price, candleTimestamp, timeMs = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;

    const data = this._getOrCreate(symbol, timeframeSeconds);

    if (data.currentCandleTimestamp > 0 && candleTimestamp !== data.currentCandleTimestamp) {
      this.sealCandle(symbol, timeframeSeconds, data.currentCandleTimestamp);
      data.ticks = [];
      data.head = 0;
      data.count = 0;
    }

    data.currentCandleTimestamp = candleTimestamp;

    const cap = this.maxTicksPerCandle;
    const prevIdx = data.count > 0 ? (data.head - 1 + cap) % cap : -1;
    const prevPrice = prevIdx >= 0 ? data.pricesRing[prevIdx] : price;
    const prevTimeMs = prevIdx >= 0 ? data.timesRing[prevIdx] : timeMs;
    const prevVel = prevIdx >= 0 ? data.velRing[prevIdx] : 0;

    const delta = price - prevPrice;
    const dtSec = Math.max(0.001, (timeMs - prevTimeMs) / 1000);
    const instVel = prevIdx >= 0 ? delta / dtSec : 0;
    const instAcc = prevIdx >= 0 ? (instVel - prevVel) / dtSec : 0;

    data.pricesRing[data.head] = price;
    data.timesRing[data.head] = timeMs;
    data.deltasRing[data.head] = delta;
    data.velRing[data.head] = instVel;
    data.accRing[data.head] = instAcc;

    data.head = (data.head + 1) % cap;
    if (data.count < cap) {
      data.count++;
    }

    data.ticks.push({
      price,
      timeMs,
      delta,
      velocity: instVel,
      acceleration: instAcc,
    });

    if (data.ticks.length > cap) {
      data.ticks.shift();
    }
  }

  /**
   * Computa as métricas de microestrutura e cinemática diferencial de uma lista de ticks.
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
        priceVelocity: 0,
        priceAcceleration: 0,
        integratedFlowPressure: 0,
        kinematicRejection: 0,
        kinematicConvergence: 0,
        tickArrivalRate: 0,
        tickArrivalAcceleration: 0,
        timeNearHighRatio: 0.5,
        timeNearLowRatio: 0.5,
        lastTicksDirection: 0,
        reversalCount: 0,
        flowImbalance: 0,
        durationDensity: [0.2, 0.2, 0.2, 0.2, 0.2],
        normalizedTrajectory: new Array(TRAJECTORY_POINTS).fill(0.5),
      };
    }

    let upticks = 0;
    let downticks = 0;
    let flatTicks = 0;
    let sumUp = 0;
    let sumDown = 0;
    let prevSign = 0;
    let reversals = 0;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = ticks[i].price;
      if (p < minPrice) minPrice = p;
      if (p > maxPrice) maxPrice = p;
    }

    const high = candleHigh !== null && candleHigh > minPrice ? candleHigh : maxPrice;
    const low = candleLow !== null && candleLow < maxPrice ? candleLow : minPrice;
    const range = Math.max(1e-8, high - low);

    // Buffers locais Float64Array para derivadas v(t) e a(t)
    const velocities = new Float64Array(n);
    const accelerations = new Float64Array(n);
    const dtArray = new Float64Array(n);

    for (let i = 1; i < n; i++) {
      const d = ticks[i].delta !== undefined ? ticks[i].delta : (ticks[i].price - ticks[i - 1].price);
      const dtSec = Math.max(0.001, ((ticks[i].timeMs || i * 1000) - (ticks[i - 1].timeMs || (i - 1) * 1000)) / 1000);
      dtArray[i] = dtSec;

      // Normaliza espaço pela amplitude da vela (range) e tempo pela janela de decisão (τ_0 = 10s)
      const dTau = dtSec / 10.0;
      const normDelta = d / range;
      const v = normDelta / dTau;
      velocities[i] = v;
      accelerations[i] = i >= 2 ? (v - velocities[i - 1]) / dTau : 0;

      if (d > 0) {
        upticks++;
        sumUp += d;
        if (prevSign === -1) reversals++;
        prevSign = 1;
      } else if (d < 0) {
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

    // Velocidade e Aceleração da Pressão por terços temporais
    const third = Math.max(1, Math.floor(n / 3));
    const p1 = this._subPressure(ticks.slice(0, third));
    const p2 = this._subPressure(ticks.slice(third, third * 2));
    const p3 = this._subPressure(ticks.slice(third * 2));

    const pressureVelocity = p3 - p2;
    const pressureAcceleration = (p3 - p2) - (p2 - p1);

    // =========================================================================
    // 1. CINEMÁTICA DIFERENCIAL DE TICKS (Terço Final / Últimos 5 a 15s)
    // v(t) = dP/dt, a(t) = dv/dt, F(t) = ∫ sgn(v(τ)) * |v(τ)|^γ dτ
    // =========================================================================
    const tailStart = Math.max(1, Math.floor(n * 0.66));
    let sumVelTail = 0;
    let sumAccTail = 0;
    let sumDtTail = 0;
    let flowNum = 0;
    let flowDen = 0;

    for (let i = 1; i < n; i++) {
      const v = velocities[i];
      const dt = dtArray[i];
      const dTau = dt / 10.0;
      const magGamma = Math.pow(Math.abs(v), GAMMA_FLOW) * dTau;
      const sgn = v > 0 ? 1 : v < 0 ? -1 : 0;
      // Peso exponencial maior para os ticks do terço final
      const recencyWeight = Math.exp(-0.08 * (n - 1 - i));
      flowNum += sgn * magGamma * recencyWeight;
      flowDen += magGamma * recencyWeight;

      if (i >= tailStart) {
        sumVelTail += v * dTau;
        sumAccTail += accelerations[i] * dTau;
        sumDtTail += dTau;
      }
    }

    const priceVelocity = sumDtTail > 0 ? sumVelTail / sumDtTail : velocities[n - 1];
    const priceAcceleration = sumDtTail > 0 ? sumAccTail / sumDtTail : accelerations[n - 1];
    const integratedFlowPressure = flowDen > 1e-9 ? flowNum / flowDen : pressure;

    // Regra de Ação Cinemática:
    // - Desaceleração no topo (v_early > 0 ou close alto, mas a_tail << 0) -> Rejeição Baixista (-1 PUT)
    // - Desaceleração no fundo (v_early < 0 ou close baixo, mas a_tail >> 0) -> Rejeição Altista (+1 CALL)
    // - Aceleração convergente (sgn(v) == sgn(a) com alta magnitude) -> Rompimento (+1 CALL / -1 PUT)
    let kinematicRejection = 0;
    let kinematicConvergence = 0;

    const earlyVel = third >= 2 ? (ticks[third - 1].price - ticks[0].price) / range : 0;
    if ((earlyVel > 0.15 || priceVelocity > 0) && priceAcceleration < -0.05) {
      kinematicRejection = -Math.min(1.0, Math.abs(priceAcceleration) * 2.5); // Sinaliza PUT por freio no topo
    } else if ((earlyVel < -0.15 || priceVelocity < 0) && priceAcceleration > 0.05) {
      kinematicRejection = Math.min(1.0, Math.abs(priceAcceleration) * 2.5); // Sinaliza CALL por freio no fundo
    }

    if (priceVelocity > 0.02 && priceAcceleration > 0.01 && integratedFlowPressure > 0.20) {
      kinematicConvergence = Math.min(1.0, (priceVelocity + priceAcceleration) * 1.5);
    } else if (priceVelocity < -0.02 && priceAcceleration < -0.01 && integratedFlowPressure < -0.20) {
      kinematicConvergence = -Math.min(1.0, (Math.abs(priceVelocity) + Math.abs(priceAcceleration)) * 1.5);
    }

    // =========================================================================
    // 2. DENSIDADE DE PROBABILIDADE DE DURAÇÃO (Para Distância de Wasserstein-1)
    // =========================================================================
    const densityBins = new Float64Array(DENSITY_BINS);
    let totalDuration = 0;
    let nearHighCount = 0;
    let nearLowCount = 0;
    const highThresh = low + range * 0.70;
    const lowThresh = low + range * 0.30;

    for (let i = 0; i < n; i++) {
      const p = ticks[i].price;
      if (p >= highThresh) nearHighCount++;
      if (p <= lowThresh) nearLowCount++;

      const dt = i > 0 ? dtArray[i] : 0.5;
      const relPos = Math.max(0, Math.min(0.9999, (p - low) / range));
      const binIdx = Math.floor(relPos * DENSITY_BINS);
      densityBins[binIdx] += dt;
      totalDuration += dt;
    }

    const durationDensity = [];
    for (let b = 0; b < DENSITY_BINS; b++) {
      durationDensity.push(
        totalDuration > 0 ? Number((densityBins[b] / totalDuration).toFixed(4)) : 1 / DENSITY_BINS
      );
    }

    // =========================================================================
    // 3. TRAJETÓRIA NORMALIZADA (Para Dynamic Time Warping - DTW Leve)
    // =========================================================================
    const normalizedTrajectory = [];
    for (let k = 0; k < TRAJECTORY_POINTS; k++) {
      const idx = Math.min(n - 1, Math.floor((k / (TRAJECTORY_POINTS - 1)) * (n - 1)));
      const normP = Math.max(0, Math.min(1, (ticks[idx].price - low) / range));
      normalizedTrajectory.push(Number(normP.toFixed(4)));
    }

    // Velocidade de chegada dos ticks (ticks/seg)
    const totalTimeMs = Math.max(100, ticks[n - 1].timeMs - ticks[0].timeMs);
    const tickArrivalRate = n / (totalTimeMs / 1000);

    // Aceleração do fluxo de chegada (2ª metade vs 1ª metade)
    const half = Math.max(1, Math.floor(n / 2));
    const timeHalf1 = Math.max(50, ticks[half - 1].timeMs - ticks[0].timeMs);
    const timeHalf2 = Math.max(50, ticks[n - 1].timeMs - ticks[half].timeMs);
    const rate1 = half / (timeHalf1 / 1000);
    const rate2 = (n - half) / (timeHalf2 / 1000);
    const tickArrivalAcceleration = rate2 - rate1;

    const timeNearHighRatio = n > 0 ? nearHighCount / n : 0.5;
    const timeNearLowRatio = n > 0 ? nearLowCount / n : 0.5;

    // Direção dos últimos 10 ticks
    const lastWindow = ticks.slice(-10);
    const lastDir = lastWindow.length >= 2 ? lastWindow[lastWindow.length - 1].price - lastWindow[0].price : 0;
    const lastTicksDirection = lastDir > 0 ? 1 : lastDir < 0 ? -1 : 0;

    // Desbalanceamento de fluxo
    const flowImbalance = upticks + downticks > 0 ? (upticks - downticks) / (upticks + downticks) : 0;

    return {
      tickCount: n,
      uptickCount: upticks,
      downtickCount: downticks,
      flatTickCount: flatTicks,
      pressure: Number(pressure.toFixed(4)),
      pressureVelocity: Number(pressureVelocity.toFixed(4)),
      pressureAcceleration: Number(pressureAcceleration.toFixed(4)),
      priceVelocity: Number(priceVelocity.toFixed(4)),
      priceAcceleration: Number(priceAcceleration.toFixed(4)),
      integratedFlowPressure: Number(integratedFlowPressure.toFixed(4)),
      kinematicRejection: Number(kinematicRejection.toFixed(4)),
      kinematicConvergence: Number(kinematicConvergence.toFixed(4)),
      tickArrivalRate: Number(tickArrivalRate.toFixed(2)),
      tickArrivalAcceleration: Number(tickArrivalAcceleration.toFixed(2)),
      timeNearHighRatio: Number(timeNearHighRatio.toFixed(3)),
      timeNearLowRatio: Number(timeNearLowRatio.toFixed(3)),
      lastTicksDirection,
      reversalCount: reversals,
      flowImbalance: Number(flowImbalance.toFixed(4)),
      durationDensity,
      normalizedTrajectory,
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

  sealCandle(symbol, timeframeSeconds, candleTimestamp) {
    const data = this._getOrCreate(symbol, timeframeSeconds);
    if (!data || data.ticks.length === 0) return null;

    const metrics = this.computeMetrics(data.ticks);
    data.closedMetrics.set(candleTimestamp, {
      ...metrics,
      timestamp: candleTimestamp,
      symbol: String(symbol).toUpperCase(),
    });

    if (data.closedMetrics.size > 100) {
      const oldestKey = data.closedMetrics.keys().next().value;
      data.closedMetrics.delete(oldestKey);
    }

    return metrics;
  }

  getCurrentMetrics(symbol, timeframeSeconds, candleOpen, candleHigh, candleLow, candleClose) {
    const data = this._getOrCreate(symbol, timeframeSeconds);
    return this.computeMetrics(data.ticks, candleOpen, candleHigh, candleLow, candleClose);
  }

  getClosedMetrics(symbol, timeframeSeconds, candleTimestamp) {
    const data = this._getOrCreate(symbol, timeframeSeconds);
    return data.closedMetrics.get(candleTimestamp) || null;
  }
}

export const intraminuteTracker = new IntraminuteTracker();
