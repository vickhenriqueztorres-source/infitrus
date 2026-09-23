/**
 * dynamic-ensemble.js - Fusão de Hipóteses e Ensemble Dinâmico Ponderado
 * Oracle Quant Signals
 *
 * Princípios do PRD:
 * 1. Não exigir concordância 5/5: modelos fracos ou discordantes com baixa confiança não vetam.
 * 2. Combinação ponderada contínua:
 *      P_ensemble = sum(w_i * P_i) / sum(w_i)
 *      w_i = Confiança_i * Calibração_i * Relevância_i * Estabilidade_i
 * 3. Pesos dinâmicos adaptados continuamente via Brier Score móvel.
 * 4. Estimativa de incerteza da dispersão entre os motores:
 *      P_conservadora = P_ensemble - z * σ_incerteza
 */

import { clamp } from "../detectors/detector-types.js";

export class DynamicEnsemble {
  constructor() {
    // Histórico de erros quadráticos recentes (Brier Score) para cada motor
    this.brierScores = {
      hierarchical_bayes: 0.25,
      adaptive_knn: 0.25,
      online_logistic: 0.25,
      temporal_dynamics: 0.25,
      microstructure_probabilistic: 0.25,
    };

    this.calibrationCounts = {
      hierarchical_bayes: 0,
      adaptive_knn: 0,
      online_logistic: 0,
      temporal_dynamics: 0,
      microstructure_probabilistic: 0,
    };
  }

  /**
   * Atualiza a calibração dos motores quando o resultado da vela é revelado.
   *
   * @param {Object<string, number>} previousPredictions - { engineId: probUp }
   * @param {number} actualOutcome - 1 se alta, 0 se baixa
   */
  updateCalibration(previousPredictions = {}, actualOutcome = 0) {
    for (const [id, prob] of Object.entries(previousPredictions)) {
      if (Number.isFinite(prob) && this.brierScores[id] !== undefined) {
        const errorSq = (prob - actualOutcome) ** 2;
        this.calibrationCounts[id]++;
        const alpha = Math.min(0.10, 1 / this.calibrationCounts[id]);
        this.brierScores[id] = (1 - alpha) * this.brierScores[id] + alpha * errorSq;
      }
    }
  }

  /**
   * Realiza a fusão de hipóteses e calcula a probabilidade do ensemble.
   *
   * @param {Array<Object>} engineResults - Resultados dos 5 motores
   * @param {Object} adaptationInfo - Dados da camada de regime/estabilidade
   * @returns {Object}
   */
  fuse(engineResults = [], adaptationInfo = {}) {
    if (!Array.isArray(engineResults) || engineResults.length === 0) {
      return {
        probUp: 0.50,
        probDown: 0.50,
        conservativeProbUp: 0.50,
        conservativeProbDown: 0.50,
        uncertainty: 0.10,
        weights: {},
        hypothesisRatio: 1.0,
        dominantDirection: "NEUTRAL",
      };
    }

    const marketStability = adaptationInfo.marketStability !== undefined ? adaptationInfo.marketStability : 1.0;

    let sumWeight = 0;
    let sumWeightProbUp = 0;
    const computedWeights = {};

    // 1. Cálculo dos pesos individuais w_i
    for (const res of engineResults) {
      const id = res.engineId;
      const confidence = res.confidence || 0.5;

      // Calibração baseada no Brier Score inverso (menor erro = maior calibração)
      const brier = this.brierScores[id] || 0.25;
      const calibration = clamp(1.0 - (brier - 0.15) * 2.5, 0.3, 1.2);

      // Relevância depende da quantidade de amostras / dados válidos
      const sampleRel = res.effectiveN !== undefined ? clamp(res.effectiveN / 15, 0.4, 1.0) : 0.8;

      // Estabilidade geral do mercado
      const stability = marketStability;

      const w = confidence * calibration * sampleRel * stability;
      computedWeights[id] = Number(w.toFixed(4));

      sumWeight += w;
      sumWeightProbUp += w * res.probUp;
    }

    // 2. Probabilidade média ponderada
    const probUpEnsemble = sumWeight > 0 ? sumWeightProbUp / sumWeight : 0.50;
    const probDownEnsemble = 1.0 - probUpEnsemble;

    // 3. Estimativa de Incerteza (Dispersão ponderada entre os modelos)
    let varSum = 0;
    for (const res of engineResults) {
      const w = computedWeights[res.engineId] || 0;
      varSum += w * ((res.probUp - probUpEnsemble) ** 2);
    }
    const uncertainty = sumWeight > 0 ? Math.sqrt(varSum / sumWeight) : 0.10;

    // 4. Modulação de incerteza pelo fator de regime recente
    const uncertaintyMultiplier = adaptationInfo.uncertaintyMultiplier || 1.0;
    const adjustedUncertainty = uncertainty * uncertaintyMultiplier;

    // 5. Probabilidade Conservadora (Encolhimento estatístico penalizado pela incerteza)
    // z = 0.67 corresponde a 1 desvio padrão de segurança
    const zSafety = 0.67;
    const conservativeProbUp = Number(clamp(probUpEnsemble - (probUpEnsemble > 0.5 ? zSafety * adjustedUncertainty : -zSafety * adjustedUncertainty), 0.10, 0.90).toFixed(4));
    const conservativeProbDown = Number((1.0 - conservativeProbUp).toFixed(4));

    // 6. Fusão de Hipóteses (Razão de Evidência CALL vs PUT)
    const callWeightSum = engineResults.filter((r) => r.probUp >= 0.52).reduce((acc, r) => acc + (computedWeights[r.engineId] || 0), 0);
    const putWeightSum = engineResults.filter((r) => r.probUp <= 0.48).reduce((acc, r) => acc + (computedWeights[r.engineId] || 0), 0);
    const hypothesisRatio = putWeightSum > 0 ? callWeightSum / putWeightSum : callWeightSum > 0 ? 3.0 : 1.0;

    const dominantDirection = probUpEnsemble >= 0.52 ? "CALL" : probUpEnsemble <= 0.48 ? "PUT" : "NEUTRAL";

    return {
      probUp: Number(probUpEnsemble.toFixed(4)),
      probDown: Number(probDownEnsemble.toFixed(4)),
      conservativeProbUp,
      conservativeProbDown,
      uncertainty: Number(adjustedUncertainty.toFixed(4)),
      weights: computedWeights,
      hypothesisRatio: Number(hypothesisRatio.toFixed(3)),
      dominantDirection,
      contributingEngines: engineResults.map((r) => ({
        id: r.engineId,
        name: r.name,
        probUp: r.probUp,
        confidence: r.confidence,
        weight: computedWeights[r.engineId] || 0,
      })),
    };
  }
}
