/**
 * adaptive-knn-engine.js - Motor 2: KNN com Distância Elastificada (Wasserstein-1 + DTW Leve + Decaimento Dual)
 * Oracle Quant Signals — Active Quant Optimizer
 *
 * Fundamentos Matemáticos:
 * 1. Distância de Wasserstein-1 (Earth Mover's Distance):
 *    W_1(P, Q) = sum_{b=1}^{B} |CDF_P(b) - CDF_Q(b)|
 *    Compara a Densidade de Probabilidade de Duração nos quantis do range [low, high].
 * 2. Dynamic Time Warping (DTW) com Banda de Sakoe-Chiba (w=1):
 *    Alinha elasticamente a trajetória local de retornos [r4, r3, r2, r1, closePos] em buffers Float64Array pré-alocados.
 * 3. Ponderação Kernel Gaussiano-Exponencial Dual:
 *    w_i = exp(-d_elastic(X_t, X_i)^2 / τ) * exp(-λ * idade_i)
 * 4. Contração Beta-Binomial sobre Tamanho Amostral Efetivo de Kish (N_eff).
 */

import { clamp } from "../detectors/detector-types.js";

const DENSITY_BINS = 5;
const DTW_LEN = 5;

export class AdaptiveKnnEngine {
  constructor(config = {}) {
    this.id = "adaptive_knn";
    this.name = "KNN Adaptativo (Wasserstein + DTW)";
    this.kNeighbors = config.kNeighbors || 15;
    this.tauDistance = config.tauDistance || 2.5;
    this.lambdaAge = config.lambdaAge || 0.015;
    this.maxHistory = config.maxHistory || 300;
    this.shrinkageM = config.shrinkageM || 20.0;

    // Buffers Float64Array pré-alocados para zero alocação no cálculo de Wasserstein e DTW
    this._cdfCurr = new Float64Array(DENSITY_BINS);
    this._cdfHist = new Float64Array(DENSITY_BINS);
    this._trajCurr = new Float64Array(DTW_LEN);
    this._trajHist = new Float64Array(DTW_LEN);
    this._dtwMatrix = new Float64Array(DTW_LEN * DTW_LEN);
  }

  /**
   * Reconstrói a CDF da Densidade de Probabilidade de Duração em 5 quantis do range [low, high]
   * a partir de durationDensity (ticks reais) ou da geometria analítica OHLC da vela.
   */
  _fillOccupancyCdf(candle, durationDensity, targetCdf) {
    if (Array.isArray(durationDensity) && durationDensity.length === DENSITY_BINS) {
      let acc = 0;
      for (let b = 0; b < DENSITY_BINS; b++) {
        acc += durationDensity[b];
        targetCdf[b] = acc;
      }
      return;
    }

    const range = Math.max(1e-8, candle.high - candle.low);
    const bodyLow = Math.max(0, Math.min(1, (Math.min(candle.open, candle.close) - candle.low) / range));
    const bodyHigh = Math.max(0, Math.min(1, (Math.max(candle.open, candle.close) - candle.low) / range));
    const closePos = Math.max(0, Math.min(1, (candle.close - candle.low) / range));

    let sum = 0;
    for (let b = 0; b < DENSITY_BINS; b++) {
      const binStart = b / DENSITY_BINS;
      const binEnd = (b + 1) / DENSITY_BINS;
      const binMid = 0.5 * (binStart + binEnd);
      // Maior densidade temporal dentro do corpo real e ao redor do fechamento
      const inBody = binEnd > bodyLow && binStart < bodyHigh ? 0.55 : 0.15;
      const nearClose = Math.exp(-Math.pow((binMid - closePos) / 0.28, 2)) * 0.45;
      const pdf = inBody + nearClose;
      sum += pdf;
      targetCdf[b] = sum;
    }
    const invSum = sum > 0 ? 1 / sum : 1;
    for (let b = 0; b < DENSITY_BINS; b++) {
      targetCdf[b] *= invSum;
    }
  }

  /**
   * Distância de Wasserstein-1 (Earth Mover's Distance) 1D exata entre duas CDFs discretas:
   * W_1(P, Q) = (1 / B) * sum |CDF_P(b) - CDF_Q(b)|
   */
  _wasserstein1Distance() {
    let w1 = 0;
    for (let b = 0; b < DENSITY_BINS; b++) {
      w1 += Math.abs(this._cdfCurr[b] - this._cdfHist[b]);
    }
    return w1 / DENSITY_BINS;
  }

  /**
   * Dynamic Time Warping (DTW) leve com banda de Sakoe-Chiba (largura w = 1) sobre _trajCurr e _trajHist.
   */
  _computeBandDtw() {
    const dp = this._dtwMatrix;
    dp.fill(1e9);

    for (let i = 0; i < DTW_LEN; i++) {
      const jMin = Math.max(0, i - 1);
      const jMax = Math.min(DTW_LEN - 1, i + 1);
      for (let j = jMin; j <= jMax; j++) {
        const diff = this._trajCurr[i] - this._trajHist[j];
        const cost = diff * diff;
        if (i === 0 && j === 0) {
          dp[0] = cost;
        } else {
          let bestPrev = 1e9;
          if (i > 0) bestPrev = Math.min(bestPrev, dp[(i - 1) * DTW_LEN + j]);
          if (j > 0) bestPrev = Math.min(bestPrev, dp[i * DTW_LEN + (j - 1)]);
          if (i > 0 && j > 0) bestPrev = Math.min(bestPrev, dp[(i - 1) * DTW_LEN + (j - 1)]);
          dp[i * DTW_LEN + j] = cost + bestPrev;
        }
      }
    }
    return Math.sqrt(dp[DTW_LEN * DTW_LEN - 1] / DTW_LEN);
  }

  _fillTrajectory(candles, idx, targetTraj) {
    const c0 = candles[idx];
    const range0 = Math.max(1e-8, c0.high - c0.low);
    const closePos0 = (c0.close - c0.low) / range0;

    for (let k = 0; k < 4; k++) {
      const backIdx = Math.max(1, idx - (3 - k));
      const cCur = candles[backIdx];
      const cPrev = candles[backIdx - 1];
      const r = Math.log(cCur.close / Math.max(1e-6, cPrev.close));
      targetTraj[k] = clamp(0.5 + r * 220, 0, 1);
    }
    targetTraj[4] = clamp(closePos0, 0, 1);
  }

  /**
   * Avalia a série histórica e calcula a probabilidade direcional ponderada por Wasserstein-1, DTW e recência.
   */
  evaluate({ currentVector = [], candles = [], microMetrics = null, temporalDecayFactor = null }) {
    const n = candles.length;
    if (n < 20 || currentVector.length === 0) {
      return {
        engineId: this.id,
        name: this.name,
        probUp: 0.50,
        probDown: 0.50,
        confidence: 0.30,
        effectiveN: 0,
        meanDistance: 0,
        wassersteinDistance: 0,
        dtwDistance: 0,
      };
    }

    const lambda = temporalDecayFactor !== null ? temporalDecayFactor : this.lambdaAge;
    const historyStart = Math.max(5, n - this.maxHistory);
    const candidates = [];

    const isLastOpen = candles[n - 1].closed === false;
    const maxTrainIndex = isLastOpen ? n - 2 : n - 1;

    const cCurr = candles[n - 1];
    const r1Curr = Math.log(cCurr.close / Math.max(1e-6, candles[n - 2].close));
    const rangeCurr = Math.max(1e-6, cCurr.high - cCurr.low);
    const closePosCurr = (cCurr.close - cCurr.low) / rangeCurr;
    const bodyRatioCurr = Math.abs(cCurr.close - cCurr.open) / rangeCurr;
    const r5Curr = n - 1 >= 5 ? Math.log(cCurr.close / Math.max(1e-6, candles[n - 6].close)) : r1Curr * 5;

    // Preenche CDF e Trajetória da vela atual uma única vez
    this._fillOccupancyCdf(cCurr, microMetrics?.durationDensity || null, this._cdfCurr);
    this._fillTrajectory(candles, n - 1, this._trajCurr);

    for (let i = historyStart; i < maxTrainIndex; i++) {
      if (candles[i + 1].closed === false) continue;
      const outcomeUp = candles[i + 1].close > candles[i + 1].open ? 1 : 0;
      const age = n - 1 - i;

      const cHist = candles[i];
      const r1Hist = Math.log(cHist.close / Math.max(1e-6, candles[i - 1].close));
      const rangeHist = Math.max(1e-6, cHist.high - cHist.low);
      const closePosHist = (cHist.close - cHist.low) / rangeHist;
      const bodyRatioHist = Math.abs(cHist.close - cHist.open) / rangeHist;
      const r5Hist = i >= 5 ? Math.log(cHist.close / Math.max(1e-6, candles[i - 5].close)) : r1Hist * 5;

      // 1. Distância Cinemática Euclidiana Normalizada
      const dR1 = (r1Curr - r1Hist) * 140;
      const dR5 = (r5Curr - r5Hist) * 75;
      const dPos = (closePosCurr - closePosHist) * 1.8;
      const dBody = (bodyRatioCurr - bodyRatioHist) * 1.8;
      const euclideanSq = dR1 * dR1 + dR5 * dR5 + dPos * dPos + dBody * dBody;

      // 2. Distância de Wasserstein-1 (Earth Mover's Distance) na Densidade de Duração
      this._fillOccupancyCdf(cHist, null, this._cdfHist);
      const w1Dist = this._wasserstein1Distance();

      // 3. Dynamic Time Warping (DTW) na Trajetória de Retornos
      this._fillTrajectory(candles, i, this._trajHist);
      const dtwDist = this._computeBandDtw();

      // Métrica Híbrida Elastificada: combina cinemática + Wasserstein-1 + DTW
      const elasticDist = Math.sqrt(
        0.55 * euclideanSq + 1.80 * (w1Dist * w1Dist) + 1.40 * (dtwDist * dtwDist)
      );

      const wDist = Math.exp(-(elasticDist * elasticDist) / this.tauDistance);
      const wAge = Math.exp(-lambda * age);
      const weight = wDist * wAge;

      if (weight > 1e-5) {
        candidates.push({ dist: elasticDist, w1Dist, dtwDist, weight, outcomeUp, age });
      }
    }

    if (candidates.length === 0) {
      return {
        engineId: this.id,
        name: this.name,
        probUp: 0.50,
        probDown: 0.50,
        confidence: 0.35,
        effectiveN: 0,
        meanDistance: 0,
        wassersteinDistance: 0,
        dtwDistance: 0,
      };
    }

    candidates.sort((a, b) => b.weight - a.weight);
    const topK = candidates.slice(0, this.kNeighbors);

    let sumWeight = 0;
    let sumWeightUp = 0;
    let sumWeightSq = 0;
    let sumDist = 0;
    let sumW1 = 0;
    let sumDtw = 0;

    for (const c of topK) {
      sumWeight += c.weight;
      sumWeightSq += c.weight * c.weight;
      sumDist += c.dist;
      sumW1 += c.w1Dist;
      sumDtw += c.dtwDist;
      if (c.outcomeUp === 1) {
        sumWeightUp += c.weight;
      }
    }

    const rawProbUp = sumWeight > 0 ? sumWeightUp / sumWeight : 0.50;
    const effectiveN = sumWeightSq > 0 ? (sumWeight * sumWeight) / sumWeightSq : 0;
    const meanDistance = topK.length > 0 ? sumDist / topK.length : 0;
    const meanW1 = topK.length > 0 ? sumW1 / topK.length : 0;
    const meanDtw = topK.length > 0 ? sumDtw / topK.length : 0;

    // Moderação Beta-Binomial (contração m-estimate sobre N_efetivo de Kish)
    const m = this.shrinkageM || 20.0;
    const smoothedProbUp = (rawProbUp * effectiveN + 0.50 * m) / (effectiveN + m);

    const probUp = Number(clamp(smoothedProbUp, 0.20, 0.80).toFixed(4));
    const probDown = Number((1.0 - probUp).toFixed(4));
    const confidence = clamp((effectiveN / this.kNeighbors) * Math.exp(-meanDistance / 3), 0.35, 0.95);

    return {
      engineId: this.id,
      name: this.name,
      probUp,
      probDown,
      confidence: Number(confidence.toFixed(3)),
      effectiveN: Number(effectiveN.toFixed(1)),
      meanDistance: Number(meanDistance.toFixed(3)),
      wassersteinDistance: Number(meanW1.toFixed(4)),
      dtwDistance: Number(meanDtw.toFixed(4)),
    };
  }
}
