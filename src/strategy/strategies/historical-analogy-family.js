/**
 * historical-analogy-family.js - Família 5: Analogia Histórica (4 Subestratégias Autônomas)
 * Oracle Quant Signals
 *
 * Subestratégias:
 * 5A. Exact Local Analogy: KNN estrito (k=5) com alta exigência de proximidade multidimensional.
 * 5B. Broad Analogy: Vizinhança expandida (k=25) com ponderação gaussiana para cobertura amostral.
 * 5C. Recent Analogy: Kernel dual com forte decaimento temporal (λ) privilegiando o regime recente.
 * 5D. Bayesian Context Analogy: Inferência Bayesiana hierárquica por regime e microestrutura (partial pooling).
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups } from "../pool/opportunity-pool.js";
import { AdaptiveKnnEngine } from "../engines/adaptive-knn-engine.js";
import { HierarchicalBayesEngine } from "../engines/hierarchical-bayes-engine.js";

export class HistoricalAnalogyFamily {
  constructor(config = {}) {
    this.familyId = "HISTORICAL_ANALOGY";
    this.familyName = "Analogia Histórica";
    this.correlationGroup = CorrelationGroups.ANALOGY;
    this.minWarmingCandles = config.minWarmingCandles || 20;

    // Motores especializados com diferentes parametrizações
    this.exactKnn = new AdaptiveKnnEngine({
      kNeighbors: 5,
      tauDistance: 1.2,
      lambdaAge: 0.005,
      maxHistory: 200,
    });

    this.broadKnn = new AdaptiveKnnEngine({
      kNeighbors: 25,
      tauDistance: 3.5,
      lambdaAge: 0.008,
      maxHistory: 300,
    });

    this.recentKnn = new AdaptiveKnnEngine({
      kNeighbors: 12,
      tauDistance: 2.2,
      lambdaAge: 0.040, // Forte decaimento temporal
      maxHistory: 150,
    });

    this.bayes = new HierarchicalBayesEngine(config.bayesConfig || { shrinkageM: 12 });
  }

  /**
   * Avalia os dados e gera candidatos independentes das 4 subestratégias de Analogia Histórica.
   *
   * @param {Object} params
   * @param {Array<Object>} params.candles
   * @param {number[]} [params.currentVector=[]]
   * @param {Object} [params.featureMap={}]
   * @param {Object} [params.microMetrics=null]
   * @param {string} [params.volatilityState="normal"]
   * @param {number} [params.payout=0.80]
   * @param {string} [params.regime="trend"]
   * @returns {Array<Object>} Lista de OpportunityObjects qualificados
   */
  evaluate({
    candles = [],
    currentVector = [],
    featureMap = {},
    microMetrics = null,
    volatilityState = "normal",
    payout = 0.80,
    regime = "trend",
  }) {
    const n = candles.length;
    if (n < this.minWarmingCandles) return [];

    const breakeven = 1 / (1 + payout);
    const opportunities = [];
    const c0 = candles[n - 1];

    const regimeComp = 1.0;

    // Se o vetor atual não foi fornecido pronto, monta um vetor numérico padrão
    let vec = currentVector;
    if (!vec || vec.length === 0) {
      const c1 = candles[n - 2];
      const r1 = Math.log(c0.close / Math.max(1e-6, c1.close));
      const range = Math.max(1e-6, c0.high - c0.low);
      const closePos = (c0.close - c0.low) / range;
      const bodyRatio = Math.abs(c0.close - c0.open) / range;
      const pressure = microMetrics?.pressure || 0;
      vec = [r1 * 100, closePos, bodyRatio, pressure];
    }

    // =========================================================================
    // 5A — EXACT LOCAL ANALOGY (KNN k=5, Distância Estrita)
    // =========================================================================
    {
      const res = this.exactKnn.evaluate({ currentVector: vec, candles });
      if (res.effectiveN >= 2.5 && res.meanDistance < 2.0) {
        let dir = null;
        let pVal = 0.50;
        if (res.probUp >= 0.57) {
          dir = "CALL";
          pVal = res.probUp;
        } else if (res.probDown >= 0.57) {
          dir = "PUT";
          pVal = res.probDown;
        }

        if (dir) {
          const rawProb = Number(pVal.toFixed(4));
          const uncert = Number(clamp(0.045 - (res.confidence - 0.3) * 0.03, 0.02, 0.05).toFixed(4));
          const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
          const edge = Number((consProb - breakeven).toFixed(4));

          if (consProb > breakeven && edge >= 0.015) {
            opportunities.push({
              strategy: this.familyId,
              subStrategy: "EXACT_LOCAL_ANALOGY",
              correlationGroup: this.correlationGroup,
              direction: dir,
              rawProbability: rawProb,
              calibratedProbability: rawProb,
              conservativeProbability: consProb,
              uncertainty: uncert,
              quality: Number(clamp(res.confidence * 0.9, 0.50, 0.95).toFixed(3)),
              breakevenProbability: Number(breakeven.toFixed(4)),
              edge,
              maturity: "ACTIVE",
              regimeCompatibility: regimeComp,
              evidence: { effectiveN: res.effectiveN, meanDistance: res.meanDistance },
              reasons: [
                `Analogia estrita (5 vizinhos mais próximos)`,
                `Consistência direcional de ${(pVal * 100).toFixed(0)}% com distância média baixa (${res.meanDistance.toFixed(2)})`,
              ],
              timestamp: c0.timestamp,
              fingerprint: `EXACT_KNN_${dir}_${c0.timestamp}`,
            });
          }
        }
      }
    }

    // =========================================================================
    // 5B — BROAD ANALOGY (KNN k=25, Cobertura Estatística Ponderada)
    // =========================================================================
    {
      const res = this.broadKnn.evaluate({ currentVector: vec, candles });
      if (res.effectiveN >= 8) {
        let dir = null;
        let pVal = 0.50;
        if (res.probUp >= 0.56) {
          dir = "CALL";
          pVal = res.probUp;
        } else if (res.probDown >= 0.56) {
          dir = "PUT";
          pVal = res.probDown;
        }

        if (dir) {
          const rawProb = Number(pVal.toFixed(4));
          const uncert = Number(clamp(0.038 - (res.confidence - 0.3) * 0.02, 0.02, 0.045).toFixed(4));
          const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
          const edge = Number((consProb - breakeven).toFixed(4));

          if (consProb > breakeven && edge >= 0.015) {
            opportunities.push({
              strategy: this.familyId,
              subStrategy: "BROAD_ANALOGY",
              correlationGroup: this.correlationGroup,
              direction: dir,
              rawProbability: rawProb,
              calibratedProbability: rawProb,
              conservativeProbability: consProb,
              uncertainty: uncert,
              quality: Number(clamp(0.55 + res.confidence * 0.35, 0.50, 0.95).toFixed(3)),
              breakevenProbability: Number(breakeven.toFixed(4)),
              edge,
              maturity: "ACTIVE",
              regimeCompatibility: regimeComp,
              evidence: { effectiveN: res.effectiveN, prob: pVal },
              reasons: [
                `Vizinhança histórica ampla (amostra efetiva N=${res.effectiveN})`,
                `Distribuição ponderada favorável (${(pVal * 100).toFixed(0)}%)`,
              ],
              timestamp: c0.timestamp,
              fingerprint: `BROAD_KNN_${dir}_${c0.timestamp}`,
            });
          }
        }
      }
    }

    // =========================================================================
    // 5C — RECENT ANALOGY (Kernel Dual com Recência Temporal Elevada)
    // =========================================================================
    {
      const res = this.recentKnn.evaluate({ currentVector: vec, candles });
      if (res.effectiveN >= 3) {
        let dir = null;
        let pVal = 0.50;
        if (res.probUp >= 0.565) {
          dir = "CALL";
          pVal = res.probUp;
        } else if (res.probDown >= 0.565) {
          dir = "PUT";
          pVal = res.probDown;
        }

        if (dir) {
          const rawProb = Number(pVal.toFixed(4));
          const uncert = Number(clamp(0.042 - (res.confidence - 0.3) * 0.025, 0.02, 0.05).toFixed(4));
          const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
          const edge = Number((consProb - breakeven).toFixed(4));

          if (consProb > breakeven && edge >= 0.015) {
            opportunities.push({
              strategy: this.familyId,
              subStrategy: "RECENT_ANALOGY",
              correlationGroup: this.correlationGroup,
              direction: dir,
              rawProbability: rawProb,
              calibratedProbability: rawProb,
              conservativeProbability: consProb,
              uncertainty: uncert,
              quality: Number(clamp(0.52 + res.confidence * 0.40, 0.50, 0.95).toFixed(3)),
              breakevenProbability: Number(breakeven.toFixed(4)),
              edge,
              maturity: "LEARNING",
              regimeCompatibility: regimeComp,
              evidence: { effectiveN: res.effectiveN, recencyDecay: 0.04 },
              reasons: [
                `Analogia de regime recente (decaimento temporal acelerado)`,
                `Dinâmica de curto prazo compatível (${(pVal * 100).toFixed(0)}%)`,
              ],
              timestamp: c0.timestamp,
              fingerprint: `RECENT_KNN_${dir}_${c0.timestamp}`,
            });
          }
        }
      }
    }

    // =========================================================================
    // 5D — BAYESIAN CONTEXT ANALOGY (Partial Pooling por Regime & Microestrutura)
    // =========================================================================
    {
      const res = this.bayes.evaluate({
        rawFeatures: {
          r1: featureMap.r1 || 0,
          r3: featureMap.r3 || 0,
          bodyRatio: featureMap.bodyRatio || 0.5,
          pressure: microMetrics?.pressure || 0,
        },
        volatilityState,
        candles,
      });

      let dir = null;
      let pVal = 0.50;
      if (res.probUp >= 0.56) {
        dir = "CALL";
        pVal = res.probUp;
      } else if (res.probDown >= 0.56) {
        dir = "PUT";
        pVal = res.probDown;
      }

      if (dir) {
        const rawProb = Number(pVal.toFixed(4));
        const uncert = Number(clamp(0.04 - (res.confidence - 0.4) * 0.02, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "BAYESIAN_CONTEXT_ANALOGY",
            correlationGroup: this.correlationGroup,
            direction: dir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(res.confidence, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: res.sampleSize > 15 ? "ACTIVE" : "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { sampleSize: res.sampleSize, parentSize: res.parentSampleSize },
            reasons: [
              `Inferência Bayesiana hierárquica por contexto de regime`,
              `Distribuição posterior contraída (${(pVal * 100).toFixed(0)}%)`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `BAYES_CTX_${dir}_${c0.timestamp}`,
          });
        }
      }
    }

    return opportunities;
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
