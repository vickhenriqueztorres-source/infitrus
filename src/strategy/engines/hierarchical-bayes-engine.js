/**
 * hierarchical-bayes-engine.js - Motor 1: Inferência Beta-Binomial Sequencial com Partial Pooling e Fator de Esquecimento (λ)
 * Oracle Quant Signals — Active Quant Optimizer
 *
 * Fundamentos Matemáticos:
 * 1. Modelo Conjugado Beta-Binomial Dinâmico com Esquecimento Exponencial (λ < 1):
 *    - Prior Nível 0 (Raiz): Beta(α_0, β_0) centrado em p_0 = 0.50 (ou ajustado ao breakeven).
 *    - Atualização Sequencial a cada vela fechada Y_t ∈ {0, 1}:
 *      α_t = λ * α_{t-1} + Y_t
 *      β_t = λ * β_{t-1} + (1 - Y_t)
 * 2. Partial Pooling Hierárquico (Nível 0 -> Nível 1 Pai -> Nível 2 Filho):
 *    - E[p | Pai]      = (α_pai + m * p_0) / (α_pai + β_pai + m)
 *    - E[p | Específico] = (α_esp + m * E[p | Pai]) / (α_esp + β_esp + m)
 * 3. Variância Posterior Analítica Exata:
 *    Var(p) = (α * β) / ((α + β)^2 * (α + β + 1))
 */

import { clamp } from "../detectors/detector-types.js";

export class HierarchicalBayesEngine {
  constructor(config = {}) {
    this.id = "hierarchical_bayes";
    this.name = "Bayes Hierárquico Beta-Binomial";
    this.shrinkageM = config.shrinkageM || 15;
    this.forgettingLambda = config.forgettingLambda || 0.985; // Decaimento para recálculo do market maker OTC

    /** @type {Map<string, { alpha: number, beta: number, total: number, up: number }>} */
    this.counts = new Map();
  }

  _getKeyParent(volatilityState, r3Sign) {
    return `L1_${volatilityState}_${r3Sign}`;
  }

  _getKeySpecific(volatilityState, r1Sign, bodyDominant, pressureSign) {
    return `L2_${volatilityState}_${r1Sign}_${bodyDominant ? "DOM" : "NORM"}_${pressureSign}`;
  }

  _updateNode(key, outcomeUp) {
    if (!key) return;
    if (!this.counts.has(key)) {
      this.counts.set(key, { alpha: 0, beta: 0, total: 0, up: 0 });
    }
    const rec = this.counts.get(key);
    const y = outcomeUp ? 1 : 0;
    rec.alpha = this.forgettingLambda * rec.alpha + y;
    rec.beta = this.forgettingLambda * rec.beta + (1 - y);
    rec.total++;
    if (y === 1) rec.up++;
  }

  /**
   * Atualização Bayesiana sequencial a partir do fechamento da vela anterior.
   *
   * @param {Object} prevContext
   * @param {number} outcomeUp - 1 se a vela subiu, 0 se desceu
   */
  update(prevContext, outcomeUp) {
    if (!prevContext || outcomeUp === 0.5) return;
    this._updateNode(prevContext.keyParent, outcomeUp);
    this._updateNode(prevContext.keySpecific, outcomeUp);
  }

  /**
   * Avalia a distribuição posterior Beta-Binomial hierárquica para a próxima vela.
   */
  evaluate({ rawFeatures = {}, volatilityState = "normal", candles = [] }) {
    const n = candles.length;
    if (n < 10) {
      return {
        engineId: this.id,
        name: this.name,
        probUp: 0.50,
        probDown: 0.50,
        posteriorStd: 0.05,
        confidence: 0.30,
        sampleSize: 0,
        parentSampleSize: 0,
        contextKeys: null,
      };
    }

    const r1 = rawFeatures.r1 || 0;
    const r3 = rawFeatures.r3 || 0;
    const bodyRatio = rawFeatures.bodyRatio || 0.5;
    const pressure = rawFeatures.pressure || 0;
    const integratedFlow = rawFeatures.integratedFlowPressure !== undefined ? rawFeatures.integratedFlowPressure : pressure;

    const r1Sign = r1 > 0 ? "UP" : r1 < 0 ? "DOWN" : "FLAT";
    const r3Sign = r3 > 0 ? "UP" : r3 < 0 ? "DOWN" : "FLAT";
    const bodyDominant = bodyRatio > 0.65;
    const pressureSign = integratedFlow > 0.15 ? "POS" : integratedFlow < -0.15 ? "NEG" : "NEUT";

    const keyParent = this._getKeyParent(volatilityState, r3Sign);
    const keySpecific = this._getKeySpecific(volatilityState, r1Sign, bodyDominant, pressureSign);

    const pRoot = 0.50;
    const m = this.shrinkageM;

    // 1. Nível 1 (Pai) com Partial Pooling da Raiz
    let pParent = pRoot;
    let nParent = 0;
    let effParent = 0;
    if (this.counts.has(keyParent)) {
      const recP = this.counts.get(keyParent);
      nParent = recP.total;
      effParent = recP.alpha + recP.beta;
      pParent = (recP.alpha + m * pRoot) / (effParent + m);
    }

    // 2. Nível 2 (Específico) com Partial Pooling do Pai
    let pSpecific = pParent;
    let nSpecific = 0;
    let effSpecific = 0;
    let alphaPost = m * pParent;
    let betaPost = m * (1 - pParent);

    if (this.counts.has(keySpecific)) {
      const recS = this.counts.get(keySpecific);
      nSpecific = recS.total;
      effSpecific = recS.alpha + recS.beta;
      alphaPost = recS.alpha + m * pParent;
      betaPost = recS.beta + m * (1 - pParent);
      pSpecific = alphaPost / (alphaPost + betaPost);
    } else if (nParent === 0) {
      // Se nenhum dado empírico foi acumulado na sessão, calcula o prior preditivo sobre a série fechada local
      let histMatches = 0;
      let histWins = 0;
      const isLastOpen = candles[n - 1].closed === false;
      const maxIdx = isLastOpen ? n - 2 : n - 1;
      const startIdx = Math.max(3, maxIdx - 60);

      for (let i = startIdx; i < maxIdx; i++) {
        const cCur = candles[i];
        const cPrev = candles[i - 1];
        const cNext = candles[i + 1];
        if (!cCur || !cPrev || !cNext || cNext.closed === false) continue;

        const r1H = Math.log(cCur.close / Math.max(1e-6, cPrev.close));
        const r1SignH = r1H > 0 ? "UP" : r1H < 0 ? "DOWN" : "FLAT";
        const rngH = Math.max(1e-6, cCur.high - cCur.low);
        const bodyDomH = Math.abs(cCur.close - cCur.open) / rngH > 0.60;

        if (r1SignH === r1Sign && bodyDomH === bodyDominant) {
          const age = maxIdx - i;
          const w = Math.pow(this.forgettingLambda, age);
          histMatches += w;
          if (cNext.close > cNext.open) histWins += w;
        }
      }

      if (histMatches > 0) {
        alphaPost = histWins + m * pRoot;
        betaPost = (histMatches - histWins) + m * (1 - pRoot);
        pSpecific = alphaPost / (alphaPost + betaPost);
        nSpecific = Math.round(histMatches);
      } else {
        const priorShift = (r1Sign === "UP" ? 0.035 : -0.035) + (pressureSign === "POS" ? 0.035 : -0.035);
        pSpecific = clamp(0.50 + priorShift, 0.42, 0.58);
      }
    }

    // 3. Variância e Desvio Padrão Analítico da Distribuição Beta(alphaPost, betaPost)
    const totalMass = alphaPost + betaPost;
    const posteriorVar = (alphaPost * betaPost) / (totalMass * totalMass * (totalMass + 1));
    const posteriorStd = Math.sqrt(Math.max(1e-6, posteriorVar));

    pSpecific = clamp(pSpecific, 0.25, 0.75);
    const probUp = Number(pSpecific.toFixed(4));
    const probDown = Number((1.0 - probUp).toFixed(4));
    const confidence = clamp(0.40 + Math.min(0.52, (nSpecific + nParent * 0.25) / 55), 0.40, 0.95);

    return {
      engineId: this.id,
      name: this.name,
      probUp,
      probDown,
      posteriorStd: Number(posteriorStd.toFixed(4)),
      confidence: Number(confidence.toFixed(3)),
      sampleSize: nSpecific,
      parentSampleSize: nParent,
      contextKeys: { keyParent, keySpecific },
    };
  }
}
