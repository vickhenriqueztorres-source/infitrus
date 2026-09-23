/**
 * historical-analogy-strategy.js - Estratégia 5: Analogia Histórica (KNN + Bayes)
 * Oracle Quant Signals
 *
 * Hipótese:
 * "Padrões multidimensionais matematicamente semelhantes no passado tendem a apresentar
 * distribuições estatísticas favoráveis para a vela seguinte."
 *
 * Modelo:
 * - KNN adaptativo com decaimento exponencial dual (distância e idade)
 * - Contração Bayesiana empírica (partial pooling).
 */

import { clamp } from "../detectors/detector-types.js";
import { AdaptiveKnnEngine } from "../engines/adaptive-knn-engine.js";
import { HierarchicalBayesEngine } from "../engines/hierarchical-bayes-engine.js";

export class HistoricalAnalogyStrategy {
  constructor(config = {}) {
    this.id = "historical_analogy";
    this.name = "Analogia Histórica";
    this.knn = new AdaptiveKnnEngine(config.knnConfig);
    this.bayes = new HierarchicalBayesEngine(config.bayesConfig);
  }

  /**
   * Avalia a série através de analogia estatística multidimensional.
   *
   * @param {Object} params
   * @param {Array<{ open: number, high: number, low: number, close: number, timestamp: number }>} params.candles
   * @param {number[]} [params.currentVector]
   * @param {Object} [params.rawFeatures]
   * @param {string} [params.volatilityState="normal"]
   * @param {number} [params.payout=0.80]
   * @returns {Object} Relatório da estratégia
   */
  evaluate({
    candles = [],
    currentVector = [],
    rawFeatures = {},
    volatilityState = "normal",
    payout = 0.80,
  }) {
    const n = candles.length;
    const breakeven = 1 / (1 + payout);

    if (n < 20) {
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
        reasons: ["Acumulando histórico para Analogia KNN"],
        hasEdge: false,
      };
    }

    // 1. Executa KNN adaptativo
    const resKnn = this.knn.evaluate({
      currentVector,
      candles,
    });

    // 2. Executa Bayes hierárquico
    const resBayes = this.bayes.evaluate({
      rawFeatures,
      volatilityState,
      candles,
    });

    // 3. Fusão especializada entre KNN (peso 60%) e Bayes (peso 40%)
    const probUp = Number((resKnn.probUp * 0.60 + resBayes.probUp * 0.40).toFixed(4));
    const probDown = Number((1.0 - probUp).toFixed(4));

    // Incerteza baseada na dispersão entre KNN e Bayes
    const modelDispersion = Math.abs(resKnn.probUp - resBayes.probUp);
    const uncertainty = Number(clamp(0.025 + modelDispersion * 0.25, 0.02, 0.06).toFixed(4));
    const zSafety = 0.67;

    let action = "WAIT";
    const reasons = [];

    if (probUp >= 0.56) {
      action = "CALL";
      reasons.push(`Distribuição histórica favorável para alta (${(probUp * 100).toFixed(1)}%)`);
      reasons.push(`Amostra ponderada de vizinhos KNN: ${(resKnn.probUp * 100).toFixed(1)}%`);
      reasons.push(`Prior Bayesiano de regime: ${(resBayes.probUp * 100).toFixed(1)}%`);
    } else if (probDown >= 0.56) {
      action = "PUT";
      reasons.push(`Distribuição histórica favorável para baixa (${(probDown * 100).toFixed(1)}%)`);
      reasons.push(`Amostra ponderada de vizinhos KNN: ${(resKnn.probDown * 100).toFixed(1)}%`);
      reasons.push(`Prior Bayesiano de regime: ${(resBayes.probDown * 100).toFixed(1)}%`);
    } else {
      reasons.push(`Distribuição de vizinhos históricos neutra (UP: ${(probUp * 100).toFixed(1)}%)`);
    }

    const dominantProb = action === "CALL" ? probUp : action === "PUT" ? probDown : 0.50;
    const conservativeProb = Number(clamp(dominantProb - zSafety * uncertainty, 0.40, 0.72).toFixed(4));
    const edge = Number((conservativeProb - breakeven).toFixed(4));
    const confidence = Number(clamp(resKnn.confidence * 0.6 + resBayes.confidence * 0.4, 0.40, 0.95).toFixed(3));
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
      knnProbUp: resKnn.probUp,
      bayesProbUp: resBayes.probUp,
      reasons,
      hasEdge,
    };
  }

  /**
   * Atualização online quando uma vela fecha.
   */
  update(context, outcomeUp) {
    if (this.bayes?.update && context) {
      this.bayes.update(context, outcomeUp);
    }
  }
}
