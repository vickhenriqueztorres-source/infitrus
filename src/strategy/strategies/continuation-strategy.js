/**
 * continuation-strategy.js - Estratégia 1: Continuação / Momentum
 * Oracle Quant Signals
 *
 * Hipótese:
 * "O movimento direcional atual possui inércia, aceleração e fluxo suficientes para se estender
 * por mais uma vela M1."
 *
 * Modelo:
 * - Avalia retornos multiperíodo, aceleração, expansão de range, posição do fechamento no extremo,
 *   pavio de rejeição curto e pressão de ticks favorável.
 * - Produz probabilidade, incerteza e edge conservador de forma 100% autônoma.
 */

import { clamp } from "../detectors/detector-types.js";

export class ContinuationStrategy {
  constructor(config = {}) {
    this.id = "continuation_momentum";
    this.name = "Continuação / Momentum";
    this.minWarmingCandles = config.minWarmingCandles || 10;
  }

  /**
   * Avalia os dados de mercado sob a hipótese de continuação de momentum.
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

    if (n < this.minWarmingCandles) {
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
        reasons: ["Aquecendo histórico para Momentum"],
        hasEdge: false,
      };
    }

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    const range0 = Math.max(1e-6, c0.high - c0.low);
    const range1 = Math.max(1e-6, c1.high - c1.low);
    const range2 = Math.max(1e-6, c2.high - c2.low);

    const closePos0 = (c0.close - c0.low) / range0;
    const upperWick0 = (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick0 = (Math.min(c0.open, c0.close) - c0.low) / range0;

    const r1 = Math.log(c0.close / Math.max(1e-6, c1.close));
    const r2 = Math.log(c1.close / Math.max(1e-6, c2.close));

    const v0 = c0.close - c1.close;
    const v1 = c1.close - c2.close;
    const accel = v0 - v1;

    const pressure = microMetrics?.pressure || 0;
    const pressureVel = microMetrics?.pressureVelocity || 0;

    // --- Pontuação de Continuação de Alta (CALL) ---
    let bullScore = 0;
    const bullReasons = [];

    if (r1 > 0) {
      bullScore += 0.20;
      if (closePos0 >= 0.60) {
        const factorPos = clamp((closePos0 - 0.50) / 0.50, 0, 1);
        bullScore += 0.25 * factorPos;
        bullReasons.push(`Fechamento no quadrante superior (${(closePos0 * 100).toFixed(0)}%)`);
      }
      if (upperWick0 <= 0.30) {
        const factorWick = clamp(1 - upperWick0 / 0.30, 0, 1);
        bullScore += 0.15 * factorWick;
        bullReasons.push(`Pavio superior controlado (${(upperWick0 * 100).toFixed(0)}%)`);
      }
      if (range0 >= range1 * 0.95) {
        const factorRange = clamp((range0 / range1 - 0.90) / 0.30, 0, 1);
        bullScore += 0.15 * factorRange;
        bullReasons.push("Amplitude M1 sustentada/em expansão");
      }
      if (accel >= 0) {
        bullScore += 0.10;
        bullReasons.push("Aceleração positiva do preço");
      }
      if (pressure > 0.10) {
        const factorPress = clamp(pressure / 0.60, 0, 1);
        bullScore += 0.15 * factorPress;
        bullReasons.push(`Pressão compradora favorável (+${(pressure * 100).toFixed(0)}%)`);
      }
      if (r2 > 0) {
        bullScore += 0.05; // Persistência de 2 velas
      }
    }

    // --- Pontuação de Continuação de Baixa (PUT) ---
    let bearScore = 0;
    const bearReasons = [];

    if (r1 < 0) {
      bearScore += 0.20;
      if (closePos0 <= 0.40) {
        const factorPos = clamp((0.50 - closePos0) / 0.50, 0, 1);
        bearScore += 0.25 * factorPos;
        bearReasons.push(`Fechamento no quadrante inferior (${(closePos0 * 100).toFixed(0)}%)`);
      }
      if (lowerWick0 <= 0.30) {
        const factorWick = clamp(1 - lowerWick0 / 0.30, 0, 1);
        bearScore += 0.15 * factorWick;
        bearReasons.push(`Pavio inferior controlado (${(lowerWick0 * 100).toFixed(0)}%)`);
      }
      if (range0 >= range1 * 0.95) {
        const factorRange = clamp((range0 / range1 - 0.90) / 0.30, 0, 1);
        bearScore += 0.15 * factorRange;
        bearReasons.push("Amplitude M1 sustentada/em expansão");
      }
      if (accel <= 0) {
        bearScore += 0.10;
        bearReasons.push("Aceleração negativa do preço");
      }
      if (pressure < -0.10) {
        const factorPress = clamp(-pressure / 0.60, 0, 1);
        bearScore += 0.15 * factorPress;
        bearReasons.push(`Pressão vendedora favorável (${(pressure * 100).toFixed(0)}%)`);
      }
      if (r2 < 0) {
        bearScore += 0.05; // Persistência de 2 velas
      }
    }

    let probUp = 0.50;
    let probDown = 0.50;
    let action = "WAIT";
    let dominantScore = 0;
    let reasons = [];

    if (bullScore >= 0.50 && bullScore > bearScore) {
      action = "CALL";
      dominantScore = clamp(bullScore, 0, 1);
      probUp = Number(clamp(0.50 + dominantScore * 0.22, 0.50, 0.72).toFixed(4));
      probDown = Number((1 - probUp).toFixed(4));
      reasons = bullReasons;
    } else if (bearScore >= 0.50 && bearScore > bullScore) {
      action = "PUT";
      dominantScore = clamp(bearScore, 0, 1);
      probDown = Number(clamp(0.50 + dominantScore * 0.22, 0.50, 0.72).toFixed(4));
      probUp = Number((1 - probDown).toFixed(4));
      reasons = bearReasons;
    } else {
      reasons = ["Sem inércia direcional suficiente para continuação"];
    }

    // Incerteza do modelo de momentum
    const uncertainty = Number(clamp(0.04 - dominantScore * 0.015, 0.02, 0.06).toFixed(4));
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
      reasons,
      hasEdge,
    };
  }
}
