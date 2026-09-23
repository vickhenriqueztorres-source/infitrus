/**
 * volatility-expansion-strategy.js - Estratégia 4: Expansão de Volatilidade (Squeeze Breakout)
 * Oracle Quant Signals
 *
 * Hipótese:
 * "A transição de uma compressão estreita de volatilidade (squeeze) para uma expansão explosiva
 * gera um deslocamento direcional limpo que tende a continuar na vela M1 seguinte."
 *
 * Independência:
 * - Detecta especificamente a quebra de acumulação, com foco na dinâmica de volatilidade e range.
 */

import { clamp } from "../detectors/detector-types.js";

export class VolatilityExpansionStrategy {
  constructor(config = {}) {
    this.id = "volatility_expansion";
    this.name = "Expansão de Volatilidade";
    this.lookbackWindow = config.lookbackWindow || 20;
  }

  /**
   * Avalia a transição de volatilidade e rompimento de compressão.
   *
   * @param {Object} params
   * @param {Array<{ open: number, high: number, low: number, close: number, timestamp: number }>} params.candles
   * @param {Object} [params.microMetrics]
   * @param {number} [params.payout=0.80]
   * @returns {Object} Relatório da estratégia
   */
  evaluate({ candles = [], microMetrics = null, payout = 0.80 }) {
    const n = candles.length;
    const breakeven = 1 / (1 + payout);

    if (n < this.lookbackWindow + 2) {
      return {
        strategyId: this.id,
        name: this.name,
        action: "WAIT",
        probUp: 0.50,
        probDown: 0.50,
        conservativeProb: 0.50,
        uncertainty: 0.05,
        edge: 0,
        quality: 0.3,
        confidence: 0.3,
        breakeven: Number(breakeven.toFixed(4)),
        reasons: ["Aquecendo histórico para Volatilidade"],
        hasEdge: false,
      };
    }

    const c0 = candles[n - 1];

    // 1. Desvios padrões de retornos logarítmicos
    const getStd = (window) => {
      const w = Math.min(window, n - 1);
      let sum = 0;
      const rets = [];
      for (let i = n - w; i < n; i++) {
        const r = Math.log(candles[i].close / Math.max(1e-6, candles[i - 1].close));
        rets.push(r);
        sum += r;
      }
      const mean = sum / w;
      let sumVar = 0;
      for (const r of rets) {
        sumVar += (r - mean) ** 2;
      }
      return Math.sqrt(sumVar / w) || 1e-5;
    };

    const s3 = getStd(3);
    const s20 = getStd(20);
    const vr3_20 = s3 / s20;

    // 2. Amplitude atual vs média das 5 velas anteriores
    const range0 = Math.max(1e-6, c0.high - c0.low);
    let prevRangeSum = 0;
    for (let i = n - 6; i < n - 1; i++) {
      prevRangeSum += Math.max(1e-6, candles[i].high - candles[i].low);
    }
    const avgPrevRange = prevRangeSum / 5;
    const rangeRatio = range0 / avgPrevRange;

    // 3. Rompimento de extremos dos últimos 4 períodos
    const prevHighMax = Math.max(candles[n - 2].high, candles[n - 3].high, candles[n - 4].high);
    const prevLowMin = Math.min(candles[n - 2].low, candles[n - 3].low, candles[n - 4].low);

    const isBullBreakout = c0.close > prevHighMax && c0.close > c0.open;
    const isBearBreakout = c0.close < prevLowMin && c0.close < c0.open;

    const pressure = microMetrics?.pressure || 0;

    let action = "WAIT";
    let dominantScore = 0;
    const reasons = [];

    // Critério de expansão: salto de amplitude + razão de volatilidade acelerando + rompimento do extremo
    const isExpanding = rangeRatio >= 1.50 || (vr3_20 >= 1.25 && rangeRatio >= 1.25);

    if (isExpanding && isBullBreakout && pressure >= 0) {
      action = "CALL";
      dominantScore = clamp((rangeRatio - 1.2) * 0.4 + (vr3_20 > 1 ? 0.3 : 0.1) + pressure * 0.3, 0.4, 1);
      reasons.push(`Quebra de compressão com expansão (${rangeRatio.toFixed(1)}x amplitude média)`);
      reasons.push("Rompimento da máxima das últimas 3 velas");
      if (pressure > 0.15) reasons.push(`Pressão de ticks alinhada (+${(pressure * 100).toFixed(0)}%)`);
    } else if (isExpanding && isBearBreakout && pressure <= 0) {
      action = "PUT";
      dominantScore = clamp((rangeRatio - 1.2) * 0.4 + (vr3_20 > 1 ? 0.3 : 0.1) + Math.abs(pressure) * 0.3, 0.4, 1);
      reasons.push(`Quebra de compressão com expansão (${rangeRatio.toFixed(1)}x amplitude média)`);
      reasons.push("Rompimento da mínima das últimas 3 velas");
      if (pressure < -0.15) reasons.push(`Pressão de ticks alinhada (${(pressure * 100).toFixed(0)}%)`);
    } else {
      reasons.push(`Volatilidade estável/em consolidação (VR: ${vr3_20.toFixed(2)}, RangeRatio: ${rangeRatio.toFixed(2)})`);
    }

    let probUp = 0.50;
    let probDown = 0.50;

    if (action === "CALL") {
      probUp = Number(clamp(0.50 + dominantScore * 0.22, 0.50, 0.72).toFixed(4));
      probDown = Number((1 - probUp).toFixed(4));
    } else if (action === "PUT") {
      probDown = Number(clamp(0.50 + dominantScore * 0.22, 0.50, 0.72).toFixed(4));
      probUp = Number((1 - probDown).toFixed(4));
    }

    const uncertainty = Number(clamp(0.045 - dominantScore * 0.015, 0.02, 0.06).toFixed(4));
    const zSafety = 0.67;

    const dominantProb = action === "CALL" ? probUp : action === "PUT" ? probDown : 0.50;
    const conservativeProb = Number(clamp(dominantProb - zSafety * uncertainty, 0.40, 0.72).toFixed(4));
    const edge = Number((conservativeProb - breakeven).toFixed(4));
    const confidence = Number(clamp(0.50 + dominantScore * 0.45, 0.40, 0.95).toFixed(3));
    const quality = Number(clamp(confidence * 0.7 + (1 - uncertainty * 10) * 0.3, 0.40, 0.95).toFixed(3));
    const hasEdge = action !== "WAIT" && edge > 0.015 && quality >= 0.50;

    return {
      strategyId: this.id,
      name: this.name,
      action: hasEdge ? action : "WAIT",
      candidateAction: action,
      probUp,
      probDown,
      conservativeProb,
      uncertainty,
      edge,
      quality,
      confidence,
      breakeven: Number(breakeven.toFixed(4)),
      score: dominantScore,
      rangeRatio: Number(rangeRatio.toFixed(2)),
      vr3_20: Number(vr3_20.toFixed(2)),
      reasons,
      hasEdge,
    };
  }
}
