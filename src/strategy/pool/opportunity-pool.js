/**
 * opportunity-pool.js - Coletor, Validador, Agrupador de Correlação e Calibrador de Oportunidades
 * Oracle Quant Signals
 *
 * Responsabilidades:
 * 1. Receber todas as oportunidades geradas pelas ~21 subestratégias independentes.
 * 2. Validar estritamente o schema do OpportunityObject e integridade numérica (zero NaN).
 * 3. Descartar oportunidades que não superem o breakeven (P_cons <= P_breakeven).
 * 4. Agrupamento por CorrelationGroup (MOMENTUM, REVERSAL, MICROSTRUCTURE, VOLATILITY, ANALOGY).
 * 5. Deduplicação intra-família: se duas subestratégias correlacionadas emitirem CALL, seleciona
 *    a de maior AdjustedEdge e anexa a outra como evidência de suporte (NÃO duplica bônus).
 * 6. Gestão de Maturidade (SHADOW, LEARNING, ACTIVE) com partial pooling Bayesiano.
 * 7. Calibração online contínua e rastreamento de Brier Score por subestratégia.
 */

import { clamp } from "../detectors/detector-types.js";

export const CorrelationGroups = Object.freeze({
  MOMENTUM: "MOMENTUM",
  REVERSAL: "REVERSAL",
  MICROSTRUCTURE: "MICROSTRUCTURE",
  VOLATILITY: "VOLATILITY",
  ANALOGY: "ANALOGY",
});

export class OpportunityPool {
  constructor(config = {}) {
    this.minEdge = config.minEdge !== undefined ? config.minEdge : 0.015;
    this.minQuality = config.minQuality !== undefined ? config.minQuality : 0.50;

    /**
     * Estatísticas de calibração online e maturidade por subestratégia
     * @type {Map<string, {
     *   signals: number,
     *   wins: number,
     *   losses: number,
     *   ties: number,
     *   brierSum: number,
     *   brierScore: number,
     *   rollingAccuracy: number,
     *   maturity: string, // 'SHADOW' | 'LEARNING' | 'ACTIVE'
     *   maturityScore: number, // 0.60 a 1.00
     * }>}
     */
    this.subStrategyStats = new Map();

    // Histórico recente para deduplicação temporal (fingerprint)
    this.recentFingerprints = new Map();
  }

  /**
   * Obtém ou inicializa o registro de performance de uma subestratégia.
   * @param {string} subStrategyKey
   * @returns {Object}
   */
  _getOrCreateStats(subStrategyKey) {
    if (!this.subStrategyStats.has(subStrategyKey)) {
      this.subStrategyStats.set(subStrategyKey, {
        signals: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        brierSum: 0,
        brierScore: 0.25, // Brier neutro inicial
        rollingAccuracy: 0.50,
        maturity: "SHADOW",
        maturityScore: 0.65,
      });
    }
    return this.subStrategyStats.get(subStrategyKey);
  }

  /**
   * Valida o schema formal de uma oportunidade individual.
   * @param {Object} opp
   * @returns {boolean}
   */
  validateSchema(opp) {
    if (!opp || typeof opp !== "object") return false;

    if (!opp.strategy || !opp.subStrategy || !opp.correlationGroup) return false;
    if (opp.direction !== "CALL" && opp.direction !== "PUT") return false;

    if (!Number.isFinite(opp.rawProbability) || opp.rawProbability <= 0 || opp.rawProbability >= 1) return false;
    if (!Number.isFinite(opp.conservativeProbability) || opp.conservativeProbability <= 0) return false;
    if (!Number.isFinite(opp.breakevenProbability) || opp.breakevenProbability <= 0) return false;
    if (!Number.isFinite(opp.edge)) return false;

    // Regra inviolável: Não aceitar edge nulo ou negativo
    if (opp.conservativeProbability <= opp.breakevenProbability) return false;
    if (opp.edge < this.minEdge) return false;

    return true;
  }

  /**
   * Processa, valida, deduplica e enriquece a lista de oportunidades geradas.
   *
   * @param {Array<Object>} rawOpportunities - Lista de candidatos vindos das 5 famílias
   * @param {Object} context - { payout, regime, marketStability }
   * @returns {Array<Object>} Lista filtrada de candidatos qualificados
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

      const stats = this._getOrCreateStats(opp.subStrategy);

      // 1. Calibração online da probabilidade baseada no Brier Score empírico da subestratégia
      // Se Brier < 0.23 (boa calibração), confiança mantida; se Brier > 0.27, contrai em direção a 0.50
      const brierFactor = clamp(1.0 - (stats.brierScore - 0.25) * 2.0, 0.70, 1.15);
      const calibratedProbability = Number(
        clamp(0.50 + (opp.rawProbability - 0.50) * brierFactor, 0.40, 0.75).toFixed(4)
      );

      // Incerteza do candidato
      const uncertainty = opp.uncertainty || 0.035;
      const conservativeProbability = Number(
        clamp(calibratedProbability - 0.67 * uncertainty, 0.40, 0.75).toFixed(4)
      );

      // Re-valida edge após calibração
      const edge = Number((conservativeProbability - breakeven).toFixed(4));
      if (edge < this.minEdge) continue;

      // 2. Cálculo do AdjustedEdge:
      // AdjustedEdge = edge * quality * maturityScore * regimeCompatibility
      const quality = clamp(opp.quality || 0.60, 0.30, 0.95);
      const maturityFactor = stats.maturityScore;
      const regimeFactor = clamp(opp.regimeCompatibility || 1.0, 0.60, 1.20);

      // Edge negativo nunca pode virar positivo
      const adjustedEdge = Number((edge * quality * maturityFactor * regimeFactor).toFixed(4));
      if (adjustedEdge <= 0) continue;

      validOpportunities.push({
        ...opp,
        calibratedProbability,
        conservativeProbability,
        edge,
        adjustedEdge,
        quality,
        maturity: stats.maturity,
        maturityScore: stats.maturityScore,
        brierScore: Number(stats.brierScore.toFixed(4)),
        sampleInfo: {
          signals: stats.signals,
          wins: stats.wins,
          losses: stats.losses,
          rollingAccuracy: Number(stats.rollingAccuracy.toFixed(3)),
        },
      });
    }

    // 3. Deduplicação e Agrupamento por CorrelationGroup (Filtro Intra-Família)
    // Se múltiplas subestratégias do mesmo grupo e mesma direção dispararem juntas,
    // elegemos a de maior AdjustedEdge e não duplicamos como confirmações ortogonais
    const grouped = new Map(); // key: `${correlationGroup}:${direction}`

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
   * Atualização online quando a vela M1 fecha e o resultado real é conhecido.
   *
   * @param {string} subStrategy
   * @param {string} direction - "CALL" ou "PUT"
   * @param {number} predictedProbability - Probabilidade prevista para a direção operada
   * @param {number} actualOutcomeUp - 1 se fechou em alta, 0 se baixa
   */
  recordOutcome(subStrategy, direction, predictedProbability, actualOutcomeUp) {
    if (!subStrategy) return;

    const stats = this._getOrCreateStats(subStrategy);
    const win = (direction === "CALL" && actualOutcomeUp === 1) || (direction === "PUT" && actualOutcomeUp === 0);
    const tie = actualOutcomeUp === 0.5;

    stats.signals++;
    if (tie) {
      stats.ties++;
    } else if (win) {
      stats.wins++;
    } else {
      stats.losses++;
    }

    // Cálculo do Brier Score: (probabilidade - resultadoReal)^2
    const target = (direction === "CALL" ? actualOutcomeUp : (1 - actualOutcomeUp));
    const errorSq = (predictedProbability - target) ** 2;
    stats.brierSum += errorSq;
    stats.brierScore = stats.brierSum / stats.signals;

    const decisive = stats.wins + stats.losses;
    stats.rollingAccuracy = decisive > 0 ? stats.wins / decisive : 0.50;

    // Atualiza Maturidade com contração bayesiana
    if (stats.signals < 15) {
      stats.maturity = "SHADOW";
      stats.maturityScore = 0.65;
    } else if (stats.signals < 50) {
      stats.maturity = "LEARNING";
      // Partial pooling: combina acurácia observada com prior 0.50 (peso m = 15)
      const pooledAcc = (stats.wins + 15 * 0.50) / (stats.signals + 15);
      stats.maturityScore = Number(clamp(0.70 + (pooledAcc - 0.50) * 0.5, 0.60, 0.90).toFixed(3));
    } else {
      stats.maturity = "ACTIVE";
      const pooledAcc = (stats.wins + 20 * 0.50) / (stats.signals + 20);
      stats.maturityScore = Number(clamp(0.85 + (pooledAcc - 0.50) * 0.3, 0.70, 1.00).toFixed(3));
    }
  }

  /**
   * Retorna resumo de métricas de todas as subestratégias para auditoria e logs.
   */
  getMetricsSummary() {
    const summary = {};
    for (const [key, st] of this.subStrategyStats.entries()) {
      summary[key] = {
        signals: st.signals,
        winRate: st.signals > 0 ? Number(((st.wins / Math.max(1, st.wins + st.losses)) * 100).toFixed(1)) : 0,
        brier: Number(st.brierScore.toFixed(4)),
        maturity: st.maturity,
      };
    }
    return summary;
  }
}
