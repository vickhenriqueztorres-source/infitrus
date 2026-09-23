/**
 * microstructure-strategy.js - Estratégia 3: Microestrutura / Fluxo de Ticks
 * Oracle Quant Signals
 *
 * Hipótese:
 * "O fluxo de agressão e o desequilíbrio de pressão nos ticks dos últimos 30 segundos
 * antecipam a direção da próxima liquidação, independentemente de formações gráficas lentas."
 *
 * Independência:
 * - Pode disparar oportunidade mesmo quando os candles anteriores estão neutros ou laterais.
 */

import { clamp } from "../detectors/detector-types.js";

export class MicrostructureStrategy {
  constructor(config = {}) {
    this.id = "microstructure_flow";
    this.name = "Microestrutura / Fluxo";
    this.minTicks = config.minTicks || 8;
  }

  /**
   * Avalia exclusivamente as métricas de fluxo e microestrutura da vela.
   *
   * @param {Object} params
   * @param {Object} [params.microMetrics]
   * @param {number} [params.payout=0.80]
   * @returns {Object} Relatório da estratégia
   */
  evaluate({ microMetrics = null, payout = 0.80 }) {
    const breakeven = 1 / (1 + payout);
    const tickCount = microMetrics?.tickCount || 0;

    if (!microMetrics || tickCount < this.minTicks) {
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
        reasons: [`Coletando ticks intraminuto (${tickCount}/${this.minTicks} necessários)`],
        hasEdge: false,
      };
    }

    const {
      pressure = 0,
      pressureVelocity = 0,
      pressureAcceleration = 0,
      timeNearHighRatio = 0,
      timeNearLowRatio = 0,
      lastTicksDirection = 0,
      flowImbalance = 0,
    } = microMetrics;

    // Componentes de fluxo
    // 1. Pressão Direcional Acumulada (peso 35%)
    const compPressure = pressure * 0.35;

    // 2. Velocidade e aceleração da pressão (peso 25%)
    const compDynamics = clamp((pressureVelocity * 1.5 + pressureAcceleration * 0.8) * 0.25, -0.25, 0.25);

    // 3. Tempo em extremos da vela (peso 20%)
    const compExtremes = clamp((timeNearHighRatio - timeNearLowRatio) * 0.20, -0.20, 0.20);

    // 4. Últimos ticks antes do fechamento (peso 20%)
    const compLast = clamp((lastTicksDirection * 0.12 + flowImbalance * 0.08), -0.20, 0.20);

    const totalScore = clamp(compPressure + compDynamics + compExtremes + compLast, -1, 1);

    // Mapeamento sigmoidal
    const z = totalScore * 2.3;
    const rawProbUp = 1 / (1 + Math.exp(-z));
    const probUp = Number(clamp(rawProbUp, 0.28, 0.72).toFixed(4));
    const probDown = Number((1.0 - probUp).toFixed(4));

    let action = "WAIT";
    const reasons = [];

    if (totalScore >= 0.38) {
      action = "CALL";
      reasons.push(`Agressão compradora nos ticks (+${(pressure * 100).toFixed(0)}%)`);
      if (timeNearHighRatio >= 0.40) {
        reasons.push(`Preço sustentado na máxima (${(timeNearHighRatio * 100).toFixed(0)}% do tempo)`);
      }
      if (lastTicksDirection > 0) {
        reasons.push("Impulso final dos últimos ticks de alta");
      }
    } else if (totalScore <= -0.38) {
      action = "PUT";
      reasons.push(`Agressão vendedora nos ticks (${(pressure * 100).toFixed(0)}%)`);
      if (timeNearLowRatio >= 0.40) {
        reasons.push(`Preço pressionado na mínima (${(timeNearLowRatio * 100).toFixed(0)}% do tempo)`);
      }
      if (lastTicksDirection < 0) {
        reasons.push("Impulso final dos últimos ticks de baixa");
      }
    } else {
      reasons.push(`Fluxo de ticks equilibrado (Escore: ${totalScore.toFixed(2)})`);
    }

    const confidence = Number(clamp(0.45 + Math.min(0.50, tickCount / 35), 0.45, 0.95).toFixed(3));
    const uncertainty = Number(clamp(0.05 - (confidence - 0.45) * 0.04, 0.02, 0.06).toFixed(4));
    const zSafety = 0.67;

    const dominantProb = action === "CALL" ? probUp : action === "PUT" ? probDown : 0.50;
    const conservativeProb = Number(clamp(dominantProb - zSafety * uncertainty, 0.40, 0.72).toFixed(4));
    const edge = Number((conservativeProb - breakeven).toFixed(4));
    const quality = Number(clamp(confidence * 0.75 + (1 - uncertainty * 10) * 0.25, 0.40, 0.95).toFixed(3));
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
      score: Math.abs(totalScore),
      tickCount,
      reasons,
      hasEdge,
    };
  }
}
