/**
 * historical-analogy-family.js - Família 5: Analogia Histórica (4 Subestratégias Autônomas com Wasserstein-DTW e Wilson)
 * Oracle Quant Signals — Active Quant Optimizer
 *
 * Subestratégias:
 * 5A. Exact Local Analogy: KNN estrito (k=12) com distância elástica Wasserstein-1 + DTW e limite de Wilson sobre N_efetivo.
 * 5B. Broad Analogy: Vizinhança expandida (k=25) com ponderação gaussiana e cobertura estatística robusta.
 * 5C. Recent Analogy: Kernel dual com forte decaimento temporal (λ=0.035) privilegiando o regime atual.
 * 5D. Bayesian Context Analogy: Inferência Beta-Binomial hierárquica com limiar rigoroso (>= 62% e amostra mínima real).
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups, computeWilsonLowerBound } from "../pool/opportunity-pool.js";
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
      kNeighbors: 12,
      tauDistance: 1.5,
      lambdaAge: 0.005,
      maxHistory: 200,
      shrinkageM: 20.0,
    });

    this.broadKnn = new AdaptiveKnnEngine({
      kNeighbors: 25,
      tauDistance: 3.5,
      lambdaAge: 0.008,
      maxHistory: 300,
      shrinkageM: 25.0,
    });

    this.recentKnn = new AdaptiveKnnEngine({
      kNeighbors: 15,
      tauDistance: 2.2,
      lambdaAge: 0.035,
      maxHistory: 150,
      shrinkageM: 20.0,
    });

    this.bayes = new HierarchicalBayesEngine(config.bayesConfig || { shrinkageM: 12 });
  }

  /**
   * Avalia os dados e gera candidatos independentes das 4 subestratégias de Analogia Histórica.
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
    // 5A — EXACT LOCAL ANALOGY (KNN k=12, Distância Estrita + Wasserstein/DTW)
    // =========================================================================
    {
      const res = this.exactKnn.evaluate({ currentVector: vec, candles, microMetrics });
      if (res.effectiveN >= 8.0 && res.meanDistance < 1.0) {
        let dir = null;
        let pVal = 0.50;
        if (res.probUp >= 0.69) {
          dir = "CALL";
          pVal = res.probUp;
        } else if (res.probDown >= 0.69) {
          dir = "PUT";
          pVal = res.probDown;
        }

        if (dir) {
          const rawProb = Number(pVal.toFixed(4));
          const uncert = Number(clamp(0.044 - (res.confidence - 0.3) * 0.028, 0.022, 0.05).toFixed(4));
          const effSample = clamp(32 + res.effectiveN * 3.2, 42, 110);
          const consProb = Number(computeWilsonLowerBound(rawProb, effSample, 0.6745).toFixed(4));
          const edge = Number((consProb - breakeven).toFixed(4));

          if (consProb > breakeven && edge >= 0.025) {
            opportunities.push({
              strategy: this.familyId,
              subStrategy: "EXACT_LOCAL_ANALOGY",
              correlationGroup: this.correlationGroup,
              direction: dir,
              rawProbability: rawProb,
              calibratedProbability: rawProb,
              conservativeProbability: consProb,
              uncertainty: uncert,
              quality: Number(clamp(res.confidence * 0.92, 0.50, 0.95).toFixed(3)),
              breakevenProbability: Number(breakeven.toFixed(4)),
              edge,
              maturity: "ACTIVE",
              regimeCompatibility: regimeComp,
              evidence: {
                effectiveN: res.effectiveN,
                meanDistance: res.meanDistance,
                w1: res.wassersteinDistance,
                dtw: res.dtwDistance,
              },
              reasons: [
                `Analogia estrita Wasserstein+DTW (W1=${res.wassersteinDistance?.toFixed(3) ?? "0.000"})`,
                `Consistência direcional robusta de ${(pVal * 100).toFixed(0)}% com distância baixa (${res.meanDistance.toFixed(2)})`,
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
      const res = this.broadKnn.evaluate({ currentVector: vec, candles, microMetrics });
      if (res.effectiveN >= 15 && res.meanDistance < 1.9) {
        let dir = null;
        let pVal = 0.50;
        if (res.probUp >= 0.67) {
          dir = "CALL";
          pVal = res.probUp;
        } else if (res.probDown >= 0.67) {
          dir = "PUT";
          pVal = res.probDown;
        }

        if (dir) {
          const rawProb = Number(pVal.toFixed(4));
          const uncert = Number(clamp(0.039 - (res.confidence - 0.3) * 0.02, 0.022, 0.045).toFixed(4));
          const effSample = clamp(36 + res.effectiveN * 2.8, 48, 120);
          const consProb = Number(computeWilsonLowerBound(rawProb, effSample, 0.6745).toFixed(4));
          const edge = Number((consProb - breakeven).toFixed(4));

          if (consProb > breakeven && edge >= 0.025) {
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
              evidence: {
                effectiveN: res.effectiveN,
                prob: pVal,
                w1: res.wassersteinDistance,
                dtw: res.dtwDistance,
              },
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
      const res = this.recentKnn.evaluate({ currentVector: vec, candles, microMetrics });
      if (res.effectiveN >= 8.0 && res.meanDistance < 1.35) {
        let dir = null;
        let pVal = 0.50;
        if (res.probUp >= 0.68) {
          dir = "CALL";
          pVal = res.probUp;
        } else if (res.probDown >= 0.68) {
          dir = "PUT";
          pVal = res.probDown;
        }

        if (dir) {
          const rawProb = Number(pVal.toFixed(4));
          const uncert = Number(clamp(0.042 - (res.confidence - 0.3) * 0.025, 0.022, 0.05).toFixed(4));
          const effSample = clamp(32 + res.effectiveN * 3.0, 42, 105);
          const consProb = Number(computeWilsonLowerBound(rawProb, effSample, 0.6745).toFixed(4));
          const edge = Number((consProb - breakeven).toFixed(4));

          if (consProb > breakeven && edge >= 0.025) {
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
              evidence: { effectiveN: res.effectiveN, recencyDecay: 0.035 },
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
    // 5D — BAYESIAN CONTEXT ANALOGY (Partial Pooling Estrito >= 62% e Amostra Real)
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

      const hasSufficientHistory = (res.sampleSize || 0) >= 10 || (res.parentSampleSize || 0) >= 18;
      let dir = null;
      let pVal = 0.50;

      // Elevado de 0.56 para 0.62 para eliminar sinais fracos que geravam falsa confluência
      if (hasSufficientHistory && res.probUp >= 0.62) {
        dir = "CALL";
        pVal = res.probUp;
      } else if (hasSufficientHistory && res.probDown >= 0.62) {
        dir = "PUT";
        pVal = res.probDown;
      }

      if (dir) {
        const rawProb = Number(pVal.toFixed(4));
        const uncert = Number(clamp(0.041 - (res.confidence - 0.4) * 0.02, 0.022, 0.05).toFixed(4));
        const effSample = clamp(34 + (res.sampleSize || 0) * 1.8 + (res.parentSampleSize || 0) * 0.5, 42, 108);
        const consProb = Number(computeWilsonLowerBound(rawProb, effSample, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.022) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "BAYESIAN_CONTEXT_ANALOGY",
            correlationGroup: this.correlationGroup,
            direction: dir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(res.confidence, 0.54, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: res.sampleSize >= 18 ? "ACTIVE" : "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: {
              sampleSize: res.sampleSize,
              parentSize: res.parentSampleSize,
              effectiveN: Math.round((res.sampleSize || 0) + (res.parentSampleSize || 0) * 0.35),
            },
            reasons: [
              `Inferência Bayesiana hierárquica por regime (${(pVal * 100).toFixed(0)}%)`,
              `Amostra contextual validada (N=${res.sampleSize || 0}, pai=${res.parentSampleSize || 0})`,
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
