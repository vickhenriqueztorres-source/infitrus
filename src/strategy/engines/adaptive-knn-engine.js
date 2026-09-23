/**
 * adaptive-knn-engine.js - Motor 2: KNN Probabilístico Adaptativo com Decaimento Dual
 * Oracle Quant Signals
 *
 * Princípio do PRD:
 * "O KNN não procura apenas situações idênticas. Procura estados próximos d(Xt, Xi)
 * e pondera cada ocorrência por w_i = e^(-d_i^2 / τ) * e^(-λ * idade_i)."
 *
 * Vantagens:
 * - Exemplo mais parecido pesa mais (kernel gaussiano de distância τ).
 * - Exemplo recente pesa mais (decaimento temporal λ).
 * - Amostras distantes perdem peso suavemente sem corte artificial rígido.
 */

import { clamp } from "../detectors/detector-types.js";

export class AdaptiveKnnEngine {
  constructor(config = {}) {
    this.id = "adaptive_knn";
    this.name = "KNN Adaptativo";
    this.kNeighbors = config.kNeighbors || 15;
    this.tauDistance = config.tauDistance || 2.5; // Largura do kernel de distância
    this.lambdaAge = config.lambdaAge || 0.015;   // Decaimento temporal por vela de idade
    this.maxHistory = config.maxHistory || 300;
  }

  /**
   * Avalia a série histórica e calcula a probabilidade direcional ponderada por similaridade e recência.
   *
   * @param {Object} params
   * @param {number[]} params.currentVector - Vetor numérico contínuo Xt padronizado
   * @param {Array<{ close: number, open: number, high: number, low: number }>} params.candles
   * @param {number} [params.temporalDecayFactor] - Modulação vinda da camada de regime
   * @returns {Object}
   */
  evaluate({ currentVector = [], candles = [], temporalDecayFactor = null }) {
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
      };
    }

    const lambda = temporalDecayFactor !== null ? temporalDecayFactor : this.lambdaAge;
    const historyStart = Math.max(5, n - this.maxHistory);
    const candidates = [];

    // Compara o vetor atual Xt com as observações históricas passadas
    // Para simplificar e manter performance em tempo real (< 2ms),
    // sintetiza a distância euclidiana normalizada para os estados históricos
    for (let i = historyStart; i < n - 1; i++) {
      const outcomeUp = candles[i + 1].close > candles[i + 1].open ? 1 : 0;
      const age = (n - 1) - i;

      // Distância aproximada baseada nas variáveis fundamentais
      const r1Hist = Math.log(candles[i].close / Math.max(1e-6, candles[i - 1].close));
      const rangeHist = Math.max(1e-6, candles[i].high - candles[i].low);
      const closePosHist = (candles[i].close - candles[i].low) / rangeHist;
      const bodyRatioHist = Math.abs(candles[i].close - candles[i].open) / rangeHist;

      const r1Curr = Math.log(candles[n - 1].close / Math.max(1e-6, candles[n - 2].close));
      const rangeCurr = Math.max(1e-6, candles[n - 1].high - candles[n - 1].low);
      const closePosCurr = (candles[n - 1].close - candles[n - 1].low) / rangeCurr;
      const bodyRatioCurr = Math.abs(candles[n - 1].close - candles[n - 1].open) / rangeCurr;

      const dR1 = (r1Curr - r1Hist) * 150;
      const dPos = (closePosCurr - closePosHist) * 2;
      const dBody = (bodyRatioCurr - bodyRatioHist) * 2;

      const dist = Math.sqrt(dR1 * dR1 + dPos * dPos + dBody * dBody);

      // Peso dual com decaimento exponencial
      const wDist = Math.exp(-(dist * dist) / this.tauDistance);
      const wAge = Math.exp(-lambda * age);
      const weight = wDist * wAge;

      if (weight > 1e-5) {
        candidates.push({ dist, weight, outcomeUp, age });
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
      };
    }

    // Ordena por maior peso (mais próximos e recentes)
    candidates.sort((a, b) => b.weight - a.weight);
    const topK = candidates.slice(0, this.kNeighbors);

    let sumWeight = 0;
    let sumWeightUp = 0;
    let sumWeightSq = 0;
    let sumDist = 0;

    for (const c of topK) {
      sumWeight += c.weight;
      sumWeightSq += c.weight * c.weight;
      sumDist += c.dist;
      if (c.outcomeUp === 1) {
        sumWeightUp += c.weight;
      }
    }

    const rawProbUp = sumWeight > 0 ? sumWeightUp / sumWeight : 0.50;
    // Tamanho amostral efetivo (Kish's Effective Sample Size)
    const effectiveN = sumWeightSq > 0 ? (sumWeight * sumWeight) / sumWeightSq : 0;
    const meanDistance = topK.length > 0 ? sumDist / topK.length : 0;

    // Moderação Bayesiana suave para evitar extremos espúrios
    const m = 3.0;
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
    };
  }
}
