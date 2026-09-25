/**
 * edge-selector.js - Tomador de Decisão: Seleção Competitiva por Edge entre Estratégias Paralelas
 * Oracle Quant Signals
 *
 * Princípios da Nova Arquitetura:
 * 1. Estratégias Paralelas: Recebe candidatos independentes das 5 famílias (~21 subestratégias).
 * 2. Seleção Competitiva: A subestratégia com maior AdjustedEdge é eleita:
 *    AdjustedEdge = Edge * Quality * MaturityFactor * RegimeCompatibility
 * 3. Resolução de Conflitos:
 *    - Se houver CALL e PUT simultâneos: ΔEdge = |AdjustedEdge_CALL - AdjustedEdge_PUT|.
 *    - Se ΔEdge >= 1.0 p.p. (0.010): a mais forte vence e emite o sinal.
 *    - Se ΔEdge < 1.0 p.p.: veto por conflito equilibrado (AGUARDAR).
 * 4. Bônus de Confluência Inter-Famílias (Ortogonal):
 *    - Se 2+ famílias ortogonais distintas concordarem, bonifica Quality e Confidence.
 *    - NUNCA infla a probabilidade calibrada artificialmente.
 *    - Subestratégias da mesma família não contam como confirmações independentes.
 * 5. Vetos Estritamente Operacionais: STALE_DATA (>15s), GAPS anormais (>2) ou dados corrompidos.
 */

import { clamp } from "../detectors/detector-types.js";

export class EdgeSelector {
  constructor(config = {}) {
    this.minEdge = config.minEdge !== undefined ? config.minEdge : 0.015; // Mínimo +1.5% de vantagem sobre breakeven
    this.minQuality = config.minQuality !== undefined ? config.minQuality : 0.50;
    this.conflictThreshold = config.conflictThreshold !== undefined ? config.conflictThreshold : 0.010; // 1.0 p.p. de desempate
  }

  /**
   * Leilão competitivo entre os candidatos gerados pelas 5 famílias / 21 subestratégias autônomas.
   *
   * @param {Object} params
   * @param {Array<Object>} params.candidates - Resultados individuais ou OpportunityObjects
   * @param {number} [params.payout=0.80]
   * @param {Object} [params.qualityContext={}]
   * @returns {Object} Decisão consolidada
   */
  selectCompetitive({ candidates = [], payout = 0.80, qualityContext = {} }) {
    const breakeven = 1 / (1 + payout);

    // 1. Verificação de Vetos Operacionais Estritos
    const criticalGaps = qualityContext.gapCount > 2;
    const isCorrupted = qualityContext.isCorrupted === true;
    const isStale = qualityContext.isStale === true || (qualityContext.staleTime && qualityContext.staleTime > 15000);

    if (criticalGaps || isCorrupted || isStale) {
      return {
        action: "WAIT",
        label: "VETO CRÍTICO (AGUARDAR)",
        strategy: null,
        subStrategy: null,
        strategyId: null,
        strategyName: null,
        edge: 0,
        adjustedEdge: 0,
        quality: 0,
        confidence: 0,
        payout,
        breakeven: Number(breakeven.toFixed(4)),
        reasons: [
          isStale ? "Veto Operacional: Feed de dados congelado (>15s sem ticks)" :
          criticalGaps ? "Veto Operacional: Lacunas anormais de dados (>2 gaps)" :
          "Veto Operacional: Integridade de dados corrompida",
        ],
        isVetoed: true,
        isConflict: false,
        isConfluence: false,
        confluenceFamilies: [],
        confluentCount: 0,
      };
    }

    // 2. Normaliza e filtra candidatos válidos com Edge real e qualidade mínima
    const validCandidates = [];
    for (const raw of (candidates || [])) {
      if (!raw) continue;
      const action = raw.direction || raw.action;
      if (action !== "CALL" && action !== "PUT") continue;

      const edge = Number.isFinite(raw.edge) ? raw.edge : 0;
      const quality = Number.isFinite(raw.quality) ? raw.quality : 0.60;
      if (edge < this.minEdge || quality < this.minQuality) continue;

      // AdjustedEdge: se já não estiver pré-calculado
      const maturityFactor = raw.maturityScore || (raw.maturity === "ACTIVE" ? 1.0 : raw.maturity === "LEARNING" ? 0.85 : 0.65);
      const regimeFactor = raw.regimeCompatibility || 1.0;
      const adjustedEdge = raw.adjustedEdge !== undefined ? raw.adjustedEdge : Number((edge * quality * maturityFactor * regimeFactor).toFixed(4));

      if (adjustedEdge <= 0) continue;

      validCandidates.push({
        ...raw,
        action,
        direction: action,
        edge,
        quality,
        adjustedEdge,
        correlationGroup: raw.correlationGroup || raw.strategy || raw.strategyId || raw.name || "UNKNOWN",
        name: raw.name || raw.subStrategy || raw.strategyId || raw.strategy || "Strategy",
      });
    }

    if (validCandidates.length === 0) {
      let bestCandidateEdge = 0;
      for (const c of candidates || []) {
        if (c && Number.isFinite(c.edge) && c.edge > bestCandidateEdge) {
          bestCandidateEdge = c.edge;
        }
      }
      return {
        action: "WAIT",
        label: "AGUARDAR (Sem Edge)",
        strategy: null,
        subStrategy: null,
        strategyId: null,
        strategyName: null,
        edge: Number(bestCandidateEdge.toFixed(4)),
        adjustedEdge: 0,
        ev: 0,
        quality: 0.50,
        confidence: 0.40,
        probability: 0.50,
        conservativeProbability: 0.50,
        breakeven: Number(breakeven.toFixed(4)),
        payout,
        reasons: [`Nenhuma oportunidade atingiu Edge mínimo (+${(this.minEdge * 100).toFixed(1)}%) com qualidade exigida`],
        isVetoed: false,
        isConflict: false,
        isConfluence: false,
        confluenceFamilies: [],
        confluentCount: 0,
      };
    }

    // 3. Separação por direção e ordenação por AdjustedEdge
    const callCandidates = validCandidates
      .filter((c) => c.action === "CALL")
      .sort((a, b) => b.adjustedEdge - a.adjustedEdge || b.edge - a.edge);

    const putCandidates = validCandidates
      .filter((c) => c.action === "PUT")
      .sort((a, b) => b.adjustedEdge - a.adjustedEdge || b.edge - a.edge);

    const bestCall = callCandidates[0] || null;
    const bestPut = putCandidates[0] || null;

    let winner = null;
    let isConflict = false;
    let conflictDelta = 0;
    const reasons = [];

    // 4. Resolução de Conflito Direcional
    if (bestCall && bestPut) {
      conflictDelta = Math.abs(bestCall.adjustedEdge - bestPut.adjustedEdge);
      if (conflictDelta >= this.conflictThreshold) {
        // O lado com maior AdjustedEdge supera o conflito
        winner = bestCall.adjustedEdge > bestPut.adjustedEdge ? bestCall : bestPut;
        const loser = winner === bestCall ? bestPut : bestCall;
        reasons.push(
          `Superou conflito: ${winner.name} (${winner.action} AdjEdge: +${(winner.adjustedEdge * 100).toFixed(1)}%) sobre ${loser.name} (${loser.action} AdjEdge: +${(loser.adjustedEdge * 100).toFixed(1)}%) [Δ: +${(conflictDelta * 100).toFixed(1)}%]`
        );
      } else {
        // Conflito equilibrado (< 1.0 p.p.) -> Neutralização prudencial
        return {
          action: "WAIT",
          label: "AGUARDAR (Conflito Direcional)",
          strategy: null,
          subStrategy: null,
          strategyId: null,
          strategyName: null,
          edge: Number(Math.max(bestCall.edge, bestPut.edge).toFixed(4)),
          adjustedEdge: Number(Math.max(bestCall.adjustedEdge, bestPut.adjustedEdge).toFixed(4)),
          ev: 0,
          quality: Number(((bestCall.quality + bestPut.quality) / 2).toFixed(3)),
          confidence: 0.50,
          probability: 0.50,
          conservativeProbability: 0.50,
          breakeven: Number(breakeven.toFixed(4)),
          payout,
          reasons: [
            `Conflito equilibrado entre ${bestCall.name} (CALL AdjEdge: +${(bestCall.adjustedEdge * 100).toFixed(1)}%) e ${bestPut.name} (PUT AdjEdge: +${(bestPut.adjustedEdge * 100).toFixed(1)}%) [Δ: ${(conflictDelta * 100).toFixed(1)}% < ${(this.conflictThreshold * 100).toFixed(1)}%]`,
          ],
          isVetoed: false,
          isConflict: true,
          isConfluence: false,
          confluenceFamilies: [],
          confluentCount: 0,
        };
      }
    } else {
      winner = bestCall || bestPut;
    }

    // 5. Verificação de Confluência Ortogonal entre Famílias Distintas
    const sameDirectionCandidates = winner.action === "CALL" ? callCandidates : putCandidates;
    const orthogonalGroups = new Set();
    const orthogonalFamilies = [];

    for (const c of sameDirectionCandidates) {
      const grp = c.correlationGroup || c.strategy || c.strategyId || c.name;
      if (!orthogonalGroups.has(grp)) {
        orthogonalGroups.add(grp);
        orthogonalFamilies.push(grp);
      }
    }

    const isConfluence = orthogonalGroups.size >= 2;
    let finalQuality = winner.quality;
    let finalConfidence = winner.confidence || clamp(winner.quality * 0.9, 0.45, 0.90);

    if (isConfluence) {
      // Bônus em Qualidade e Confiança (NUNCA infla probabilidade bruta ou conservadora)
      const confluenceBonus = (orthogonalGroups.size - 1) * 0.05;
      finalQuality = Number(clamp(finalQuality + confluenceBonus, 0.50, 0.98).toFixed(3));
      finalConfidence = Number(clamp(finalConfidence + confluenceBonus * 1.2, 0.50, 0.98).toFixed(3));
      reasons.push(
        `Confluência ortogonal de ${orthogonalGroups.size} famílias independentes: ${orthogonalFamilies.join(" + ")}`
      );
    }

    // 5.1 Política de Maturidade: Estratégias em SHADOW participam da análise/replay,
    // mas não anunciam entrada acionável isoladamente sem validação empírica.
    const isShadow = winner.maturity === "SHADOW";
    const hasActiveConfluence = isConfluence && sameDirectionCandidates.some((c) => c.maturity && c.maturity !== "SHADOW");
    const isActionable = !isShadow || hasActiveConfluence;

    if (isShadow && !hasActiveConfluence) {
      reasons.unshift(`Oportunidade em SHADOW (${winner.subStrategy || winner.name}): observação analítica sem alerta acionável`);
    }

    // 6. Cálculo do Valor Esperado (EV)
    // EV = P_cons * Payout - (1 - P_cons) * 1.0
    const activeP = winner.conservativeProbability || winner.conservativeProb || 0.50;
    const ev = Number((activeP * payout - (1 - activeP) * 1.0).toFixed(3));

    const strategyId = winner.strategyId || winner.subStrategy || winner.strategy;
    const strategyName = winner.name || winner.subStrategy || winner.strategy;
    const subStrategy = winner.subStrategy || null;

    return {
      action: winner.action,
      label: `${winner.action} (+${(winner.edge * 100).toFixed(1)}% - ${subStrategy || strategyName})${isShadow && !hasActiveConfluence ? " [SHADOW]" : ""}`,
      strategy: winner.strategy || strategyId,
      subStrategy,
      strategyId,
      strategyName,
      correlationGroup: winner.correlationGroup,
      edge: winner.edge,
      adjustedEdge: winner.adjustedEdge,
      ev,
      quality: finalQuality,
      confidence: finalConfidence,
      probability: winner.calibratedProbability || winner.rawProbability || (winner.action === "CALL" ? winner.probUp : winner.probDown) || 0.50,
      conservativeProbability: activeP,
      breakeven: Number(breakeven.toFixed(4)),
      payout,
      reasons,
      maturity: winner.maturity || "ACTIVE",
      isActionable,
      isVetoed: false,
      isConflict,
      isConfluence,
      confluenceFamilies: orthogonalFamilies,
      confluentCount: orthogonalGroups.size,
      allCandidates: validCandidates,
    };
  }

  /**
   * Método de compatibilidade para suporte ao formato legado de ensemble se necessário.
   */
  select({ ensembleReport, payout = 0.80, qualityContext = {} }) {
    if (!ensembleReport) {
      return {
        action: "WAIT",
        label: "AGUARDAR",
        edge: 0,
        quality: 0,
        payout,
        breakeven: 0.556,
        reasons: ["Dados insuficientes"],
        isVetoed: false,
      };
    }

    const breakeven = 1 / (1 + payout);
    const { probUp, probDown, conservativeProbUp, conservativeProbDown } = ensembleReport;

    const edgeCall = conservativeProbUp - breakeven;
    const edgePut = conservativeProbDown - breakeven;

    let action = "WAIT";
    let edge = 0;
    let label = "AGUARDAR";

    if (edgeCall >= this.minEdge && edgeCall > edgePut) {
      action = "CALL";
      edge = Number(edgeCall.toFixed(4));
      label = `CALL (+${(edge * 100).toFixed(1)}% Edge)`;
    } else if (edgePut >= this.minEdge && edgePut > edgeCall) {
      action = "PUT";
      edge = Number(edgePut.toFixed(4));
      label = `PUT (+${(edge * 100).toFixed(1)}% Edge)`;
    }

    const activeP = action === "CALL" ? conservativeProbUp : action === "PUT" ? conservativeProbDown : 0.50;
    const ev = Number((activeP * payout - (1 - activeP) * 1.0).toFixed(3));

    return {
      action,
      label,
      edge,
      ev,
      quality: 0.70,
      probability: action === "CALL" ? probUp : probDown,
      conservativeProbability: action === "CALL" ? conservativeProbUp : conservativeProbDown,
      breakeven: Number(breakeven.toFixed(4)),
      payout,
      reasons: ["Ensemble legado"],
      isVetoed: false,
    };
  }
}
