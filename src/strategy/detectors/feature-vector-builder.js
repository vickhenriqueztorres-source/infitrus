/**
 * feature-vector-builder.js - Integrador Unificado de Detectores e Construtor do Vetor X_t
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Executar simultaneamente as 8 famílias de detectores contínuos (~70-100 grandezas).
 * - Extrair todas as features fundamentais contínuas (retornos, derivadas, volatilidade multiescala,
 *   microestrutura, posicionamento e aceitação de extremos).
 * - Garantia absoluta de ZERO LOOKAHEAD (todas as features em t utilizam estritamente dados <= t).
 * - Montar o vetor numérico contínuo X_t padronizado com z-score dinâmico Welford.
 */

import { clamp } from "./detector-types.js";
import { MomentumVelocityFamily } from "./families/momentum-velocity.js";
import { CandleGeometryFamily } from "./families/candle-geometry.js";
import { VolatilityMultidimensionalFamily } from "./families/volatility-multidimensional.js";
import { ContinuationProbabilisticFamily } from "./families/continuation-probabilistic.js";
import { ReversionExhaustionFamily } from "./families/reversion-exhaustion.js";
import { MicrostructureIntraminuteFamily } from "./families/microstructure-intraminute.js";
import { PricePositioningFamily } from "./families/price-positioning.js";
import { SecondOrderInteractionsFamily } from "./families/second-order-interactions.js";

export class FeatureVectorBuilder {
  constructor() {
    this.familyMomentum = new MomentumVelocityFamily();
    this.familyGeometry = new CandleGeometryFamily();
    this.familyVolatility = new VolatilityMultidimensionalFamily();
    this.familyContinuation = new ContinuationProbabilisticFamily();
    this.familyReversion = new ReversionExhaustionFamily();
    this.familyMicrostructure = new MicrostructureIntraminuteFamily();
    this.familyPositioning = new PricePositioningFamily();
    this.familyInteractions = new SecondOrderInteractionsFamily();

    // Histórico de normalização z-score para as variáveis numéricas
    this.featureMeans = {};
    this.featureVars = {};
    this.featureCount = 0;
  }

  /**
   * Extrai todos os detectores e gera o vetor numérico contínuo Xt e a coleção de sinais.
   *
   * @param {Array<{ close: number, open: number, high: number, low: number, timestamp: number }>} candles
   * @param {Object} [microMetrics=null]
   * @returns {{ vector: number[], featureMap: Object<string, number>, signals: Object<string, any>, volatilityState: string }}
   */
  build(candles = [], microMetrics = null) {
    if (!candles || candles.length < 10) {
      return { vector: [], featureMap: {}, signals: {}, volatilityState: "aguardando" };
    }

    const n = candles.length;
    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];
    const c3 = n >= 4 ? candles[n - 4] : c2;
    const c5 = n >= 6 ? candles[n - 6] : c3;
    const c10 = n >= 11 ? candles[n - 11] : candles[0];
    const c20 = n >= 21 ? candles[n - 21] : candles[0];

    // 1. Extração rigorosa de variáveis contínuas com ZERO LOOKAHEAD
    const r1 = Math.log(c0.close / Math.max(1e-6, c1.close));
    const r2 = Math.log(c0.close / Math.max(1e-6, c2.close));
    const r3 = Math.log(c0.close / Math.max(1e-6, c3.close));
    const r5 = Math.log(c0.close / Math.max(1e-6, c5.close));

    // Velocidade, aceleração e jerk (pts/s em timeframe 60s)
    const v0 = (c0.close - c1.close) / 60;
    const v1 = (c1.close - c2.close) / 60;
    const v2 = (c2.close - c3.close) / 60;
    const priceVelocity = v0;
    const priceAcceleration = (v0 - v1) / 60;
    const jerk = ((v0 - v1) - (v1 - v2)) / 60;

    // Geometria contínua
    const range0 = Math.max(1e-6, c0.high - c0.low);
    const range1 = Math.max(1e-6, c1.high - c1.low);
    const body0 = Math.abs(c0.close - c0.open);
    const bodyRatio = clamp(body0 / range0, 0, 1);
    const upperWickRatio = clamp((c0.high - Math.max(c0.open, c0.close)) / range0, 0, 1);
    const lowerWickRatio = clamp((Math.min(c0.open, c0.close) - c0.low) / range0, 0, 1);
    const closePosition = clamp((c0.close - c0.low) / range0, 0, 1);

    // Amplitude e aceleração de range
    let prevRangeSum5 = 0;
    for (let i = Math.max(0, n - 6); i < n - 1; i++) {
      prevRangeSum5 += Math.max(1e-6, candles[i].high - candles[i].low);
    }
    const avgRange5 = prevRangeSum5 / Math.max(1, Math.min(5, n - 1));
    const rangeRatio = range0 / avgRange5;
    const rangeAcceleration = (range0 - range1) / Math.max(1e-6, range1);

    // Volatilidade multiescala (desvio padrão dos retornos log)
    const computeStd = (lookback) => {
      const w = Math.min(lookback, n - 1);
      if (w < 2) return 1e-4;
      let sum = 0;
      const rets = [];
      for (let i = n - w; i < n; i++) {
        const r = Math.log(candles[i].close / Math.max(1e-6, candles[i - 1].close));
        rets.push(r);
        sum += r;
      }
      const mean = sum / w;
      let sumVar = 0;
      for (const r of rets) sumVar += (r - mean) ** 2;
      return Math.sqrt(sumVar / w) || 1e-4;
    };

    const volatility3 = computeStd(3);
    const volatility5 = computeStd(5);
    const volatility10 = computeStd(10);
    const volatility20 = computeStd(20);
    const vr3_20 = volatility3 / volatility20;
    const vr5_20 = volatility5 / volatility20;

    // Z-Score de preço
    const computeZScore = (lookback) => {
      const w = Math.min(lookback, n);
      if (w < 2) return 0;
      let sum = 0;
      for (let i = n - w; i < n; i++) sum += candles[i].close;
      const mean = sum / w;
      let sumVar = 0;
      for (let i = n - w; i < n; i++) sumVar += (candles[i].close - mean) ** 2;
      const std = Math.sqrt(sumVar / w) || 1e-5;
      return (c0.close - mean) / std;
    };

    const zScore10 = computeZScore(10);
    const zScore20 = computeZScore(20);

    // Eficiência Direcional: deslocamento líquido / caminho total percorrido
    let totalPath = 0;
    for (let i = Math.max(0, n - 5); i < n; i++) {
      totalPath += Math.max(1e-6, candles[i].high - candles[i].low);
    }
    const netDisplacement = Math.abs(c0.close - (candles[Math.max(0, n - 5)]?.open || c0.open));
    const directionalEfficiency = clamp(netDisplacement / Math.max(1e-6, totalPath), 0, 1);

    // Posicionamento relativo em múltiplos ranges
    const computeRangePos = (lookback) => {
      let hMax = -Infinity;
      let lMin = Infinity;
      for (let i = Math.max(0, n - lookback); i < n; i++) {
        if (candles[i].high > hMax) hMax = candles[i].high;
        if (candles[i].low < lMin) lMin = candles[i].low;
      }
      const span = Math.max(1e-6, hMax - lMin);
      return {
        pos: clamp((c0.close - lMin) / span, 0, 1),
        distHigh: (hMax - c0.close) / span,
        distLow: (c0.close - lMin) / span,
      };
    };

    const pos3 = computeRangePos(3);
    const pos5 = computeRangePos(5);
    const pos10 = computeRangePos(10);

    // Microestrutura Intraminuto
    const pressure = microMetrics?.pressure || 0;
    const pressureVelocity = microMetrics?.pressureVelocity || 0;
    const pressureAcceleration = microMetrics?.pressureAcceleration || 0;
    const flowImbalance = microMetrics?.flowImbalance || 0;
    const timeNearHighRatio = microMetrics?.timeNearHighRatio || 0;
    const timeNearLowRatio = microMetrics?.timeNearLowRatio || 0;
    const lastTicksDirection = microMetrics?.lastTicksDirection || 0;
    const tickCount = microMetrics?.tickCount || 0;

    const uptickRatio = microMetrics?.uptickRatio !== undefined ? microMetrics.uptickRatio : clamp(0.5 + pressure * 0.5, 0, 1);
    const downtickRatio = 1 - uptickRatio;
    const positiveTickMagnitude = microMetrics?.positiveTickMagnitude || Math.max(0, pressure);
    const negativeTickMagnitude = microMetrics?.negativeTickMagnitude || Math.max(0, -pressure);
    const tickArrivalVelocity = tickCount / 60; // ticks por segundo

    const highAcceptance = timeNearHighRatio;
    const lowAcceptance = timeNearLowRatio;
    const newHighsFrequency = microMetrics?.newHighsFrequency || (closePosition > 0.85 ? 0.6 : 0.2);
    const newLowsFrequency = microMetrics?.newLowsFrequency || (closePosition < 0.15 ? 0.6 : 0.2);

    const last5TickDirection = lastTicksDirection;
    const last10TickDirection = microMetrics?.last10TickDirection !== undefined ? microMetrics.last10TickDirection : lastTicksDirection;

    // Mapa unificado de grandezas contínuas
    const unifiedFeatures = {
      r1,
      r2,
      r3,
      r5,
      priceVelocity,
      priceAcceleration,
      jerk,
      bodyRatio,
      upperWickRatio,
      lowerWickRatio,
      closePosition,
      range0,
      rangeRatio,
      rangeAcceleration,
      volatility3,
      volatility5,
      volatility10,
      volatility20,
      vr3_20,
      vr5_20,
      zScore10,
      zScore20,
      directionalEfficiency,
      pressure,
      pressureVelocity,
      pressureAcceleration,
      flowImbalance,
      uptickRatio,
      downtickRatio,
      positiveTickMagnitude,
      negativeTickMagnitude,
      tickArrivalVelocity,
      highAcceptance,
      lowAcceptance,
      newHighsFrequency,
      newLowsFrequency,
      last5TickDirection,
      last10TickDirection,
      distanceFromHigh: pos5.distHigh,
      distanceFromLow: pos5.distLow,
      posIn3BarRange: pos3.pos,
      posIn5BarRange: pos5.pos,
      posIn10BarRange: pos10.pos,
    };

    // 2. Executa as 8 famílias de detectores para sinais de contexto
    const resMom = this.familyMomentum.evaluate(candles);
    const resGeom = this.familyGeometry.evaluate(candles);
    const resVol = this.familyVolatility.evaluate(candles);
    const resCont = this.familyContinuation.evaluate(candles, microMetrics);
    const resRev = this.familyReversion.evaluate(candles, microMetrics);
    const resMicro = this.familyMicrostructure.evaluate(microMetrics);
    const resPos = this.familyPositioning.evaluate(candles);

    const allSignals = {
      ...resMom.signals,
      ...resGeom.signals,
      ...resVol.signals,
      ...resCont.signals,
      ...resRev.signals,
      ...resMicro.signals,
      ...resPos.signals,
    };

    const allRawFeatures = {
      ...unifiedFeatures,
      ...resMom.rawFeatures,
      ...resGeom.rawFeatures,
      ...resVol.rawFeatures,
      ...resCont.rawFeatures,
      ...resRev.rawFeatures,
      ...resMicro.rawFeatures,
      ...resPos.rawFeatures,
    };

    const resInteractions = this.familyInteractions.evaluate(allRawFeatures);
    Object.assign(allSignals, resInteractions.signals);
    Object.assign(allRawFeatures, resInteractions.rawFeatures);

    // 3. Padronização Welford Online Z-Score
    this.featureCount++;
    const featureNames = Object.keys(allRawFeatures).sort();
    const standardizedVector = [];

    for (const name of featureNames) {
      const val = allRawFeatures[name];
      if (!Number.isFinite(val)) {
        standardizedVector.push(0);
        continue;
      }

      if (this.featureMeans[name] === undefined) {
        this.featureMeans[name] = val;
        this.featureVars[name] = 1.0;
      } else {
        const alpha = Math.min(0.05, 1 / this.featureCount);
        const diff = val - this.featureMeans[name];
        this.featureMeans[name] += alpha * diff;
        this.featureVars[name] = (1 - alpha) * this.featureVars[name] + alpha * (diff ** 2);
      }

      const std = Math.sqrt(this.featureVars[name]) || 1.0;
      const z = (val - this.featureMeans[name]) / std;
      const clampedZ = Math.max(-4, Math.min(4, z));
      standardizedVector.push(Number(clampedZ.toFixed(4)));
    }

    return {
      vector: standardizedVector,
      featureMap: allRawFeatures,
      signals: allSignals,
      volatilityState: resVol.volatilityState || "normal",
    };
  }
}
