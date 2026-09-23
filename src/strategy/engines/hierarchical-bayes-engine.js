/**
 * hierarchical-bayes-engine.js - Motor 1: Bayes Hierárquico com Partial Pooling
 * Oracle Quant Signals
 *
 * Princípio do PRD:
 * "Se o cenário específico possui poucos exemplos, utiliza informação de cenários mais gerais.
 * Isso evita jogar fora oportunidades simplesmente porque a combinação exata apareceu poucas vezes."
 *
 * Arquitetura de Árvore:
 * - Nível 0 (Raiz): Prior Neutro Global (p0 = 0.50)
 * - Nível 1 (Pai): Contexto Macro (Regime de Volatilidade + Direção M3)
 * - Nível 2 (Filho): Cenário Específico (Momentum + Estrutura de Pavio + Sinal de Pressão)
 *
 * Contração Bayesiana (Partial Pooling):
 *   P(CALL | Específico) = (n * P_empirica + m * P_pai) / (n + m)
 */

import { clamp } from "../detectors/detector-types.js";

export class HierarchicalBayesEngine {
  constructor(config = {}) {
    this.id = "hierarchical_bayes";
    this.name = "Bayes Hierárquico";
    this.shrinkageM = config.shrinkageM || 15; // Parâmetro m de contração

    /** @type {Map<string, { total: number, up: number }>} */
    this.counts = new Map();
  }

  _getKeyParent(volatilityState, r3Sign) {
    return `L1_${volatilityState}_${r3Sign}`;
  }

  _getKeySpecific(volatilityState, r1Sign, bodyDominant, pressureSign) {
    return `L2_${volatilityState}_${r1Sign}_${bodyDominant ? "DOM" : "NORM"}_${pressureSign}`;
  }

  /**
   * Treinamento / atualização online contínua a partir do fechamento da vela anterior.
   *
   * @param {Object} prevContext
   * @param {number} outcomeUp - 1 se a vela subiu, 0 se desceu
   */
  update(prevContext, outcomeUp) {
    if (!prevContext) return;

    const kParent = prevContext.keyParent;
    const kSpecific = prevContext.keySpecific;

    if (kParent) {
      if (!this.counts.has(kParent)) this.counts.set(kParent, { total: 0, up: 0 });
      const pRec = this.counts.get(kParent);
      pRec.total++;
      if (outcomeUp) pRec.up++;
    }

    if (kSpecific) {
      if (!this.counts.has(kSpecific)) this.counts.set(kSpecific, { total: 0, up: 0 });
      const sRec = this.counts.get(kSpecific);
      sRec.total++;
      if (outcomeUp) sRec.up++;
    }
  }

  /**
   * Avalia a probabilidade Bayesiana hierárquica para a próxima vela.
   *
   * @param {Object} params
   * @param {Object} params.rawFeatures
   * @param {string} params.volatilityState
   * @param {Array} params.candles
   * @returns {Object}
   */
  evaluate({ rawFeatures = {}, volatilityState = "normal", candles = [] }) {
    const n = candles.length;
    if (n < 10) {
      return {
        engineId: this.id,
        name: this.name,
        probUp: 0.50,
        probDown: 0.50,
        confidence: 0.30,
        sampleSize: 0,
        contextKeys: null,
      };
    }

    const r1 = rawFeatures.r1 || 0;
    const r3 = rawFeatures.r3 || 0;
    const bodyRatio = rawFeatures.bodyRatio || 0.5;
    const pressure = rawFeatures.pressure || 0;

    const r1Sign = r1 > 0 ? "UP" : r1 < 0 ? "DOWN" : "FLAT";
    const r3Sign = r3 > 0 ? "UP" : r3 < 0 ? "DOWN" : "FLAT";
    const bodyDominant = bodyRatio > 0.65;
    const pressureSign = pressure > 0.15 ? "POS" : pressure < -0.15 ? "NEG" : "NEUT";

    const keyParent = this._getKeyParent(volatilityState, r3Sign);
    const keySpecific = this._getKeySpecific(volatilityState, r1Sign, bodyDominant, pressureSign);

    // 1. Probabilidade Nível 0 (Raiz)
    const pRoot = 0.50;

    // 2. Probabilidade Nível 1 (Pai) com pooling da Raiz
    let pParent = pRoot;
    let nParent = 0;
    if (this.counts.has(keyParent)) {
      const recP = this.counts.get(keyParent);
      nParent = recP.total;
      pParent = (recP.up + this.shrinkageM * pRoot) / (recP.total + this.shrinkageM);
    }

    // 3. Probabilidade Nível 2 (Específico) com partial pooling do Pai
    let pSpecific = pParent;
    let nSpecific = 0;
    if (this.counts.has(keySpecific)) {
      const recS = this.counts.get(keySpecific);
      nSpecific = recS.total;
      // Contração Bayesiana elegante:
      pSpecific = (recS.up + this.shrinkageM * pParent) / (recS.total + this.shrinkageM);
    } else {
      // Se o cenário nunca ocorreu, herda integralmente a estimativa do cenário pai!
      pSpecific = pParent;
    }

    // Se a contagem em memória ainda estiver vazia (início de sessão),
    // aplica inferência bayesiana informativa baseada nas características contínuas:
    if (nParent === 0 && nSpecific === 0) {
      const priorShift = (r1Sign === "UP" ? 0.04 : -0.04) + (pressureSign === "POS" ? 0.04 : -0.04);
      pSpecific = clamp(0.50 + priorShift, 0.42, 0.58);
    }

    pSpecific = clamp(pSpecific, 0.25, 0.75);
    const probUp = Number(pSpecific.toFixed(4));
    const probDown = Number((1.0 - probUp).toFixed(4));
    const confidence = clamp(0.40 + Math.min(0.50, (nSpecific + nParent * 0.2) / 60), 0.40, 0.95);

    return {
      engineId: this.id,
      name: this.name,
      probUp,
      probDown,
      confidence: Number(confidence.toFixed(3)),
      sampleSize: nSpecific,
      parentSampleSize: nParent,
      contextKeys: { keyParent, keySpecific },
    };
  }
}
