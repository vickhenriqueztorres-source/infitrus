/**
 * microstructure-probabilistic-engine.js - Motor 5: Microestrutura Probabilística (Tick-Level)
 * Oracle Quant Signals
 *
 * Princípio do PRD:
 * "Especializado nos ticks e no comportamento intraminuto. Ele calcula P(CALL|ticks)
 * e P(PUT|ticks) independentemente dos modelos baseados em candles.
 * Fornece uma fonte de informação diferente e ortogonal."
 */

import { clamp } from "../detectors/detector-types.js";

export class MicrostructureProbabilisticEngine {
  constructor() {
    this.id = "microstructure_probabilistic";
    this.name = "Microestrutura de Ticks";
  }

  /**
   * Avalia exclusivamente as métricas de fluxo de ticks da vela.
   *
   * @param {Object} params
   * @param {Object} params.microMetrics - Métricas oriundas do IntraminuteTracker
   * @returns {Object}
   */
  evaluate({ microMetrics = null }) {
    if (!microMetrics || microMetrics.tickCount < 3) {
      return {
        engineId: this.id,
        name: this.name,
        probUp: 0.50,
        probDown: 0.50,
        confidence: 0.30,
        tickCount: microMetrics?.tickCount || 0,
      };
    }

    const {
      pressure,
      pressureVelocity,
      pressureAcceleration,
      timeNearHighRatio,
      timeNearLowRatio,
      lastTicksDirection,
      flowImbalance,
      tickCount,
    } = microMetrics;

    // Componentes ponderados do modelo de microestrutura:
    // 1. Pressão Direcional Acumulada (peso 40%)
    const compPressure = pressure * 0.40;

    // 2. Velocidade e Aceleração da Pressão (peso 25%)
    const compVelocity = clamp(pressureVelocity * 1.5, -0.25, 0.25);

    // 3. Extremos de Tempo (peso 20%)
    const compExtremes = (timeNearHighRatio - timeNearLowRatio) * 0.20;

    // 4. Direção dos Últimos Ticks (peso 15%)
    const compLastTicks = (lastTicksDirection || 0) * 0.15;

    // Escore total de microestrutura [-1, +1]
    const totalScore = compPressure + compVelocity + compExtremes + compLastTicks;

    // Mapeamento sigmoidal de probabilidade
    const z = totalScore * 2.2;
    const rawProbUp = 1 / (1 + Math.exp(-z));

    const probUp = Number(clamp(rawProbUp, 0.25, 0.75).toFixed(4));
    const probDown = Number((1.0 - probUp).toFixed(4));

    // Confiança aumenta com a amostragem de ticks no minuto
    const confidence = clamp(0.40 + Math.min(0.50, tickCount / 35), 0.40, 0.95);

    return {
      engineId: this.id,
      name: this.name,
      probUp,
      probDown,
      confidence: Number(confidence.toFixed(3)),
      tickCount,
      totalScore: Number(totalScore.toFixed(4)),
    };
  }
}
