/**
 * reversion-strategy.js - Estratégia 2: Reversão / Exaustão
 * Oracle Quant Signals
 *
 * Hipótese:
 * "O movimento esticado perdeu inércia, atingiu exaustão estatística (Z-Score elevado)
 * e apresenta absorção/rejeição, aumentando significativamente a probabilidade de retorno na próxima M1."
 *
 * Independência:
 * - Pode disparar PUT em plena tendência prévia de alta, sem depender de concordância de médias móveis.
 */

import { clamp } from "../detectors/detector-types.js";

export class ReversionStrategy {
  constructor(config = {}) {
    this.id = "reversion_exhaustion";
    this.name = "Reversão / Exaustão";
    this.lookbackWindow = config.lookbackWindow || 20;
    this.minZScore = config.minZScore || 1.6;
  }

  /**
   * Avalia a série histórica sob a hipótese de exaustão e reversão.
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
        reasons: ["Aquecendo janela para Z-Score de Reversão"],
        hasEdge: false,
      };
    }

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    // 1. Z-Score sobre as últimas 20 velas
    let sum = 0;
    for (let i = n - this.lookbackWindow; i < n; i++) {
      sum += candles[i].close;
    }
    const mean = sum / this.lookbackWindow;

    let sumVar = 0;
    for (let i = n - this.lookbackWindow; i < n; i++) {
      sumVar += (candles[i].close - mean) ** 2;
    }
    const std = Math.sqrt(sumVar / this.lookbackWindow) || 1e-5;
    const zScore = (c0.close - mean) / std;

    // 2. Geometria da vela e pavios de absorção
    const range0 = Math.max(1e-6, c0.high - c0.low);
    const body0 = Math.abs(c0.close - c0.open);
    const body1 = Math.abs(c1.close - c1.open);

    const upperWick0 = (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick0 = (Math.min(c0.open, c0.close) - c0.low) / range0;

    // 3. Aceleração de preço
    const v0 = c0.close - c1.close;
    const v1 = c1.close - c2.close;
    const accel = v0 - v1;

    // 4. Pressão intraminuto
    const pressure = microMetrics?.pressure || 0;
    const pressureVel = microMetrics?.pressureVelocity || 0;

    // --- Detecção de Exaustão de Alta (Candidato a PUT) ---
    let putScore = 0;
    const putReasons = [];

    if (zScore >= this.minZScore) {
      putScore += 0.30 * clamp((zScore - this.minZScore) / 1.5, 0.4, 1.2);
      putReasons.push(`Afastamento estatístico extremo (Z-Score: +${zScore.toFixed(2)})`);

      if (upperWick0 >= 0.28) {
        putScore += 0.25 * clamp(upperWick0 / 0.50, 0.5, 1.2);
        putReasons.push(`Pavio superior de absorção (${(upperWick0 * 100).toFixed(0)}%)`);
      }
      if (accel < 0) {
        putScore += 0.15;
        putReasons.push("Perda de inércia e desaceleração do topo");
      }
      if (body0 < body1 * 0.75) {
        putScore += 0.15;
        putReasons.push("Redução no volume e tamanho do corpo");
      }
      if (pressureVel < 0 || pressure < 0.20) {
        putScore += 0.15;
        putReasons.push("Deterioração da pressão compradora");
      }
    }

    // --- Detecção de Exaustão de Baixa (Candidato a CALL) ---
    let callScore = 0;
    const callReasons = [];

    if (zScore <= -this.minZScore) {
      callScore += 0.30 * clamp((-zScore - this.minZScore) / 1.5, 0.4, 1.2);
      callReasons.push(`Afastamento estatístico extremo (Z-Score: ${zScore.toFixed(2)})`);

      if (lowerWick0 >= 0.28) {
        callScore += 0.25 * clamp(lowerWick0 / 0.50, 0.5, 1.2);
        callReasons.push(`Pavio inferior de rejeição (${(lowerWick0 * 100).toFixed(0)}%)`);
      }
      if (accel > 0) {
        callScore += 0.15;
        callReasons.push("Perda de inércia e desaceleração do fundo");
      }
      if (body0 < body1 * 0.75) {
        callScore += 0.15;
        callReasons.push("Redução no volume e tamanho do corpo");
      }
      if (pressureVel > 0 || pressure > -0.20) {
        callScore += 0.15;
        callReasons.push("Recuperação da pressão de compra");
      }
    }

    let probUp = 0.50;
    let probDown = 0.50;
    let action = "WAIT";
    let dominantScore = 0;
    let reasons = [];

    if (putScore >= 0.55 && putScore > callScore) {
      action = "PUT";
      dominantScore = clamp(putScore, 0, 1);
      probDown = Number(clamp(0.50 + dominantScore * 0.22, 0.50, 0.72).toFixed(4));
      probUp = Number((1 - probDown).toFixed(4));
      reasons = putReasons;
    } else if (callScore >= 0.55 && callScore > putScore) {
      action = "CALL";
      dominantScore = clamp(callScore, 0, 1);
      probUp = Number(clamp(0.50 + dominantScore * 0.22, 0.50, 0.72).toFixed(4));
      probDown = Number((1 - probUp).toFixed(4));
      reasons = callReasons;
    } else {
      reasons = [`Sem exaustão estatística (Z-Score atual: ${zScore.toFixed(2)})`];
    }

    const uncertainty = Number(clamp(0.04 - dominantScore * 0.015, 0.02, 0.06).toFixed(4));
    const zSafety = 0.67;

    const dominantProb = action === "CALL" ? probUp : action === "PUT" ? probDown : 0.50;
    const conservativeProb = Number(clamp(dominantProb - zSafety * uncertainty, 0.40, 0.72).toFixed(4));
    const edge = Number((conservativeProb - breakeven).toFixed(4));
    const confidence = Number(clamp(0.52 + dominantScore * 0.42, 0.40, 0.95).toFixed(3));
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
      zScore: Number(zScore.toFixed(2)),
      reasons,
      hasEdge,
    };
  }
}
