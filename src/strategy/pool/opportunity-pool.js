/**
 * opportunity-pool.js - Coletor, Calibrador Beta-Binomial, Otimizador SGD Online e Matriz de Covariância 21x21
 * Oracle Quant Signals — Active Quant Optimizer
 *
 * Fundamentos Matemáticos:
 * 1. Modelo Beta-Binomial Dinâmico com Fator de Esquecimento (λ = 0.985):
 *    - Prior ancorado no Breakeven do Payout (p_be = 1 / (1 + R)):
 *      α_0 = M_0 * p_be,  β_0 = M_0 * (1 - p_be)
 *    - Atualização Sequencial a cada resultado Y_t ∈ {0, 1}:
 *      α_t = λ * α_{t-1} + Y_t,  β_t = λ * β_{t-1} + (1 - Y_t)
 * 2. Limite Inferior de Wilson (Wilson Score Lower Bound) para Probabilidade Conservadora:
 *    Substitui subtrações lineares arbitrárias pela cota inferior analítica da distribuição binomial/Beta.
 * 3. Otimização Dinâmica por Gradiente Estocástico (SGD sobre Log-Loss + Brier Score):
 *    w_{i, t+1} = w_{i, t} + η * ∇J(w_{i, t}), penalizando co-ativações correlacionadas na derrota.
 * 4. Matriz de Co-Ativação e Co-Derrota 21x21 em Float64Array (441 elementos contíguos).
 */

import { clamp } from "../detectors/detector-types.js";

export const CorrelationGroups = Object.freeze({
  MOMENTUM: "MOMENTUM",
  REVERSAL: "REVERSAL",
  MICROSTRUCTURE: "MICROSTRUCTURE",
  VOLATILITY: "VOLATILITY",
  ANALOGY: "ANALOGY",
});

export const CANONICAL_SUBSTRATEGIES = Object.freeze([
  "IMPULSE_CONTINUATION",
  "PERSISTENT_MOMENTUM",
  "PULLBACK_CONTINUATION",
  "LATE_ACCELERATION",
  "STATISTICAL_EXHAUSTION",
  "WICK_REJECTION",
  "FAILED_BREAKOUT",
  "MOMENTUM_EXHAUSTION",
  "PERSISTENT_TICK_PRESSURE",
  "PRESSURE_ACCELERATION",
  "PRESSURE_REVERSAL",
  "HIGH_LOW_ACCEPTANCE",
  "END_OF_MINUTE_FLOW",
  "SQUEEZE_BREAKOUT",
  "EXPANSION_CONTINUATION",
  "VOLATILITY_IGNITION",
  "COMPRESSION_DIRECTIONAL_BIAS",
  "EXACT_LOCAL_ANALOGY",
  "BROAD_ANALOGY",
  "RECENT_ANALOGY",
  "BAYESIAN_CONTEXT_ANALOGY",
]);

const SUB_INDEX_MAP = new Map(CANONICAL_SUBSTRATEGIES.map((name, idx) => [name, idx]));
const NUM_STRATEGIES = CANONICAL_SUBSTRATEGIES.length; // 21

/**
 * Calcula o Limite Inferior do Intervalo de Wilson para uma proporção binomial pHat com tamanho efetivo nEff.
 * Quando a variância amostral colapsa (nEff elevado), W_lower converge para pHat.
 */
export function computeWilsonLowerBound(pHat, nEff, z = 0.6745) {
  const p = clamp(pHat, 0.01, 0.99);
  const n = Math.max(4.0, nEff);
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const rad = Math.sqrt((p * (1 - p)) / n + (z2 / (4 * n * n)));
  return clamp((center - z * rad) / denom, 0.05, 0.95);
}

export class OpportunityPool {
  constructor(config = {}) {
    this.minEdge = config.minEdge !== undefined ? config.minEdge : 0.015;
    this.minQuality = config.minQuality !== undefined ? config.minQuality : 0.50;
    this.forgettingLambda = config.forgettingLambda || 0.985;
    this.learningRateEta = config.learningRateEta || 0.045;
    this.priorStrengthM = config.priorStrengthM || 18.0;

    this.subStrategyStats = new Map();
    this.recentFingerprints = new Map();

    // Matrizes 21x21 pré-alocadas em Float64Array para co-ativação e derrota condicional
    this._coActivationMatrix = new Float64Array(NUM_STRATEGIES * NUM_STRATEGIES);
    this._jointWinMatrix = new Float64Array(NUM_STRATEGIES * NUM_STRATEGIES);
    this._jointLossMatrix = new Float64Array(NUM_STRATEGIES * NUM_STRATEGIES);
  }

  _buildDefaultStats(defaultMaturity = null, breakeven = 0.5556) {
    const mat = defaultMaturity || "LEARNING";
    const score = mat === "ACTIVE" ? 1.0 : mat === "SHADOW" ? 0.65 : 0.85;
    const alpha0 = this.priorStrengthM * breakeven;
    const beta0 = this.priorStrengthM * (1 - breakeven);
    return {
      signals: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      alpha: alpha0,
      beta: beta0,
      omegaWeight: 1.0, // Peso otimizado via SGD online
      brierSum: 0,
      brierScore: 0.2469, // p_be * (1 - p_be) para p_be = 0.5556
      logLossEma: 0.687,
      rollingAccuracy: breakeven,
      wilsonLower: breakeven,
      maturity: mat,
      maturityScore: score,
    };
  }

  _getStatsReadOnly(subStrategyKey, defaultMaturity = null, breakeven = 0.5556) {
    if (this.subStrategyStats.has(subStrategyKey)) {
      return this.subStrategyStats.get(subStrategyKey);
    }
    return this._buildDefaultStats(defaultMaturity, breakeven);
  }

  _getOrCreateStats(subStrategyKey, defaultMaturity = null, breakeven = 0.5556) {
    if (!this.subStrategyStats.has(subStrategyKey)) {
      this.subStrategyStats.set(subStrategyKey, this._buildDefaultStats(defaultMaturity, breakeven));
    }
    return this.subStrategyStats.get(subStrategyKey);
  }

  /**
   * Retorna a probabilidade condicional P(Loss | S_i ∩ S_j) e a correlação empírica entre duas subestratégias.
   */
  getPairwiseDependency(subA, subB) {
    const idxA = SUB_INDEX_MAP.get(subA);
    const idxB = SUB_INDEX_MAP.get(subB);
    if (idxA === undefined || idxB === undefined || idxA === idxB) {
      return { coActivations: 0, conditionalLossRate: 0.4444, conditionalWinRate: 0.5556, correlationPenalty: 0 };
    }
    const cell = idxA * NUM_STRATEGIES + idxB;
    const coAct = this._coActivationMatrix[cell];
    if (coAct < 1.0) {
      return { coActivations: coAct, conditionalLossRate: 0.4444, conditionalWinRate: 0.5556, correlationPenalty: 0 };
    }
    const jointLosses = this._jointLossMatrix[cell];
    const jointWins = this._jointWinMatrix[cell];
    const conditionalLossRate = (jointLosses + 2.0 * 0.4444) / (coAct + 2.0);
    const conditionalWinRate = (jointWins + 2.0 * 0.5556) / (coAct + 2.0);
    // Se a taxa de derrota conjunta exceder (1 - p_be) = 0.4444, gera penalidade covariante
    const correlationPenalty = clamp((conditionalLossRate - 0.4444) * 1.8, 0, 0.45);
    return {
      coActivations: Number(coAct.toFixed(2)),
      conditionalLossRate: Number(conditionalLossRate.toFixed(4)),
      conditionalWinRate: Number(conditionalWinRate.toFixed(4)),
      correlationPenalty: Number(correlationPenalty.toFixed(4)),
    };
  }

  validateSchema(opp) {
    if (!opp || typeof opp !== "object") return false;

    if (!opp.strategy || !opp.subStrategy || !opp.correlationGroup) return false;
    if (opp.direction !== "CALL" && opp.direction !== "PUT") return false;

    if (!Number.isFinite(opp.rawProbability) || opp.rawProbability <= 0 || opp.rawProbability >= 1) return false;
    if (!Number.isFinite(opp.conservativeProbability) || opp.conservativeProbability <= 0) return false;
    if (!Number.isFinite(opp.breakevenProbability) || opp.breakevenProbability <= 0) return false;
    if (!Number.isFinite(opp.edge)) return false;

    if (opp.conservativeProbability <= opp.breakevenProbability) return false;
    if (opp.edge < this.minEdge) return false;

    return true;
  }

  /**
   * Processa, valida, aplica atualização Beta-Binomial, Limite de Wilson e pesos SGD sem mutar estado interno.
   */
  process(rawOpportunities = [], context = {}) {
    if (!Array.isArray(rawOpportunities) || rawOpportunities.length === 0) {
      return [];
    }

    const payout = context.payout || 0.80;
    const breakeven = 1 / (1 + payout);
    const validOpportunities = [];

    for (const opp of rawOpportunities) {
      if (!this.validateSchema(opp)) continue;

      const stats = this._getStatsReadOnly(opp.subStrategy, opp.maturity, breakeven);

      // 1. Fusão Bayesiana entre a Verossimilhança do Sinal (opp.rawProbability) e a Posterior Beta(α_t, β_t)
      const posteriorMass = stats.alpha + stats.beta;
      const posteriorMean = stats.alpha / Math.max(1e-6, posteriorMass);
      const empiricalWeight = clamp((posteriorMass - this.priorStrengthM) / 60, 0, 0.45);

      const brierModulator = clamp(1.0 - (stats.brierScore - 0.2469) * 2.2, 0.72, 1.15);
      const fusedProb =
        (1 - empiricalWeight) * (0.50 + (opp.rawProbability - 0.50) * brierModulator) +
        empiricalWeight * posteriorMean;

      const calibratedProbability = Number(clamp(fusedProb, 0.40, 0.76).toFixed(4));

      // 2. Variância Posterior Analítica + Cota Inferior de Wilson
      // Evita inflar artificialmente N_eff (máx 115 para setup estrutural puro) e incorpora effectiveN empírico quando disponível
      const structUncert = clamp(opp.uncertainty || 0.035, 0.020, 0.060);
      const baseStructN = clamp(0.065 / (structUncert * structUncert), 38, 115);
      const empiricalSignalN = Number.isFinite(opp.evidence?.effectiveN) ? clamp(opp.evidence.effectiveN * 2.5, 0, 60) : 0;
      const totalEffectiveN = baseStructN + empiricalSignalN + Math.max(0, posteriorMass - this.priorStrengthM);

      const wilsonConservative = computeWilsonLowerBound(calibratedProbability, totalEffectiveN, 0.6745);
      const conservativeProbability = Number(clamp(wilsonConservative, 0.40, 0.75).toFixed(4));

      const edge = Number((conservativeProbability - breakeven).toFixed(4));
      if (edge < this.minEdge) continue;

      // 3. Cálculo do AdjustedEdge ponderado pelo peso SGD online (ω_i):
      // AdjustedEdge = Edge * Quality * MaturityFactor * RegimeCompatibility * ω_i
      const quality = clamp(opp.quality || 0.60, 0.30, 0.95);
      const maturityFactor = stats.maturityScore;
      const regimeFactor = clamp(opp.regimeCompatibility || 1.0, 0.60, 1.20);
      const omegaWeight = clamp(stats.omegaWeight || 1.0, 0.55, 1.35);

      const adjustedEdge = Number((edge * quality * maturityFactor * regimeFactor * omegaWeight).toFixed(4));
      if (adjustedEdge <= 0) continue;

      validOpportunities.push({
        ...opp,
        calibratedProbability,
        conservativeProbability,
        edge,
        adjustedEdge,
        quality,
        omegaWeight: Number(omegaWeight.toFixed(4)),
        maturity: stats.maturity,
        maturityScore: stats.maturityScore,
        brierScore: Number(stats.brierScore.toFixed(4)),
        sampleInfo: {
          signals: stats.signals,
          wins: stats.wins,
          losses: stats.losses,
          rollingAccuracy: Number(stats.rollingAccuracy.toFixed(3)),
          wilsonLower: Number(stats.wilsonLower.toFixed(4)),
          effectiveMass: Number(posteriorMass.toFixed(1)),
        },
      });
    }

    // 4. Deduplicação Intra-Família por CorrelationGroup
    const grouped = new Map();

    for (const opp of validOpportunities) {
      const key = `${opp.correlationGroup}:${opp.direction}`;
      if (!grouped.has(key)) {
        grouped.set(key, { primary: opp, correlatedSubs: [] });
      } else {
        const existing = grouped.get(key);
        if (opp.adjustedEdge > existing.primary.adjustedEdge) {
          existing.correlatedSubs.push(existing.primary.subStrategy);
          existing.primary = opp;
        } else {
          existing.correlatedSubs.push(opp.subStrategy);
        }
      }
    }

    const nonRedundantPool = [];
    for (const item of grouped.values()) {
      const cand = { ...item.primary };
      if (item.correlatedSubs.length > 0) {
        cand.correlatedEvidence = item.correlatedSubs;
        cand.reasons = [
          ...(cand.reasons || []),
          `Suporte intra-família (${item.correlatedSubs.join(", ")})`,
        ];
      }
      nonRedundantPool.push(cand);
    }

    return nonRedundantPool;
  }

  /**
   * Atualização Bayesiana sequencial Beta-Binomial + Otimização SGD Online + Matriz de Covariância 21x21
   * quando a vela M1 fecha e o resultado real Y_t ∈ {0, 1} é observado.
   *
   * @param {string} subStrategy
   * @param {string} direction - "CALL" ou "PUT"
   * @param {number} predictedProbability - Probabilidade prevista para a direção operada
   * @param {number} actualOutcomeUp - 1 se fechou em alta, 0 se baixa, 0.5 se doji
   * @param {Array<string>} [coActiveSubStrategies=[]] - Subestratégias que dispararam juntas nesta vela
   */
  recordOutcome(subStrategy, direction, predictedProbability, actualOutcomeUp, coActiveSubStrategies = []) {
    if (!subStrategy) return;

    const stats = this._getOrCreateStats(subStrategy);
    const win = (direction === "CALL" && actualOutcomeUp === 1) || (direction === "PUT" && actualOutcomeUp === 0);
    const tie = actualOutcomeUp === 0.5;

    stats.signals++;
    if (tie) {
      stats.ties++;
      return;
    }

    const y = win ? 1 : 0;
    if (win) {
      stats.wins++;
    } else {
      stats.losses++;
    }

    // 1. Atualização Beta-Binomial com Fator de Esquecimento (λ < 1):
    // α_t = λ * α_{t-1} + Y_t,  β_t = λ * β_{t-1} + (1 - Y_t)
    const lambda = this.forgettingLambda;
    stats.alpha = lambda * stats.alpha + y;
    stats.beta = lambda * stats.beta + (1 - y);

    // 2. Brier Score e Log-Loss com decaimento exponencial
    const pPred = clamp(predictedProbability || 0.5556, 0.05, 0.95);
    const errorSq = (pPred - y) ** 2;
    stats.brierSum += errorSq;
    stats.brierScore = 0.95 * stats.brierScore + 0.05 * errorSq;

    const logLoss = -(y * Math.log(pPred) + (1 - y) * Math.log(1 - pPred));
    stats.logLossEma = 0.95 * stats.logLossEma + 0.05 * logLoss;

    const decisive = stats.wins + stats.losses;
    stats.rollingAccuracy = stats.alpha / Math.max(1e-6, stats.alpha + stats.beta);
    stats.wilsonLower = computeWilsonLowerBound(stats.rollingAccuracy, stats.alpha + stats.beta, 1.645);

    // 3. Atualização da Matriz de Co-Ativação e Co-Derrota 21x21
    const activeList = Array.from(new Set([subStrategy, ...(coActiveSubStrategies || [])]));
    let corrLossPenaltyGrad = 0;

    for (let a = 0; a < activeList.length; a++) {
      const idxA = SUB_INDEX_MAP.get(activeList[a]);
      if (idxA === undefined) continue;
      for (let b = 0; b < activeList.length; b++) {
        if (a === b) continue;
        const idxB = SUB_INDEX_MAP.get(activeList[b]);
        if (idxB === undefined) continue;
        const cell = idxA * NUM_STRATEGIES + idxB;
        this._coActivationMatrix[cell] = lambda * this._coActivationMatrix[cell] + 1.0;
        if (win) {
          this._jointWinMatrix[cell] = lambda * this._jointWinMatrix[cell] + 1.0;
          this._jointLossMatrix[cell] = lambda * this._jointLossMatrix[cell];
        } else {
          this._jointLossMatrix[cell] = lambda * this._jointLossMatrix[cell] + 1.0;
          this._jointWinMatrix[cell] = lambda * this._jointWinMatrix[cell];
          corrLossPenaltyGrad += 0.15;
        }
      }
    }

    // 4. Otimização Dinâmica de Pesos por Gradiente Estocástico (SGD Online):
    // w_{i, t+1} = w_{i, t} + η * ((Y_t - pPred) - penalidade_correlacao_derrota)
    const gradJ = (y - pPred) - (1 - y) * corrLossPenaltyGrad;
    stats.omegaWeight = clamp(stats.omegaWeight + this.learningRateEta * gradJ, 0.55, 1.35);

    // 5. Promoção e Rebaixamento Automático de Maturidade baseado em Evidência e Limite de Wilson
    if (stats.signals < 15) {
      stats.maturity = "SHADOW";
      stats.maturityScore = 0.65;
    } else if (stats.signals < 50) {
      stats.maturity = "LEARNING";
      const pooledAcc = stats.rollingAccuracy;
      stats.maturityScore = Number(clamp(0.70 + (pooledAcc - 0.50) * 0.5, 0.60, 0.90).toFixed(3));
    } else {
      // Se após 50+ sinais a precisão decaída cair abaixo de 53%, rebaixa automaticamente para LEARNING
      if (stats.rollingAccuracy < 0.53 && decisive >= 50) {
        stats.maturity = "LEARNING";
        stats.maturityScore = Number(clamp(0.68 + (stats.rollingAccuracy - 0.50) * 0.4, 0.58, 0.82).toFixed(3));
      } else {
        stats.maturity = "ACTIVE";
        stats.maturityScore = Number(clamp(0.85 + (stats.rollingAccuracy - 0.50) * 0.3, 0.70, 1.00).toFixed(3));
      }
    }
  }

  getMetricsSummary() {
    const summary = {};
    for (const [key, st] of this.subStrategyStats.entries()) {
      summary[key] = {
        signals: st.signals,
        winRate: st.signals > 0 ? Number(((st.wins / Math.max(1, st.wins + st.losses)) * 100).toFixed(1)) : 0,
        rollingAccuracy: Number((st.rollingAccuracy * 100).toFixed(1)),
        wilsonLower: Number((st.wilsonLower * 100).toFixed(1)),
        omegaWeight: Number(st.omegaWeight.toFixed(3)),
        brier: Number(st.brierScore.toFixed(4)),
        maturity: st.maturity,
      };
    }
    return summary;
  }
}
