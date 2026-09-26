/**
 * edge-selector.js - Tomador de Decisão: Leilão de AdjustedEdge, Veto Covariante 21x21 e Bayes Condicional
 * Oracle Quant Signals — Active Quant Optimizer
 *
 * Fundamentos Matemáticos:
 * 1. Seleção Competitiva Ponderada:
 *    AdjustedEdge_i = Edge_i * Quality_i * MaturityFactor_i * RegimeCompatibility_i * ω_i
 * 2. Veto de Conflito Direcional:
 *    ΔEdge = |AdjustedEdge_CALL - AdjustedEdge_PUT| < conflictThreshold -> Veto Neutro (WAIT).
 * 3. Sistema de Veto Matemático (Determinante de Covariância & Bayes Condicional):
 *    - Se S_1 e S_2 disparam juntas:
 *      P(Win | S_1 ∩ S_2) = [P(S_1 ∩ S_2 | Win) * P(Win)] / P(S_1 ∩ S_2)
 *    - Determinante de Independência 2x2: det(R) = 1 - ρ_{12}^2.
 *    - Se S_1 e S_2 são correlacionadas na derrota (P(Loss | S_1 ∩ S_2) > 0.52 com co-ativações empíricas),
 *      o AdjustedEdge sofre contração covariante e a confluência é vetada.
 */

import { clamp } from "../detectors/detector-types.js";

export class EdgeSelector {
  constructor(config = {}) {
    this.minEdge = config.minEdge !== undefined ? config.minEdge : 0.025;
    this.minQuality = config.minQuality !== undefined ? config.minQuality : 0.65;
    this.conflictThreshold = config.conflictThreshold !== undefined ? config.conflictThreshold : 0.030;
    this.requireConfluence = config.requireConfluence !== undefined ? config.requireConfluence : true;
  }

  /**
   * Leilão competitivo entre os candidatos das 5 famílias / 21 subestratégias autônomas.
   */
  selectCompetitive({ candidates = [], payout = 0.80, qualityContext = {}, opportunityPool = null }) {
    const breakeven = 1 / (1 + payout);

    // 1. Vetos Operacionais Estritos
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
          isStale
            ? "Veto Operacional: Feed de dados congelado (>15s sem ticks)"
            : criticalGaps
            ? "Veto Operacional: Lacunas anormais de dados (>2 gaps)"
            : "Veto Operacional: Integridade de dados corrompida",
        ],
        isVetoed: true,
        isConflict: false,
        isConfluence: false,
        confluenceFamilies: [],
        confluentCount: 0,
      };
    }

    // 2. Normaliza e filtra candidatos válidos
    const validCandidates = [];
    for (const raw of candidates || []) {
      if (!raw) continue;
      const action = raw.direction || raw.action;
      if (action !== "CALL" && action !== "PUT") continue;

      const edge = Number.isFinite(raw.edge) ? raw.edge : 0;
      const quality = Number.isFinite(raw.quality) ? raw.quality : 0.60;
      if (edge < this.minEdge || quality < this.minQuality) continue;

      const maturityFactor = raw.maturityScore || (raw.maturity === "ACTIVE" ? 1.0 : raw.maturity === "LEARNING" ? 0.85 : 0.65);
      const regimeFactor = raw.regimeCompatibility || 1.0;
      const omegaWeight = raw.omegaWeight || 1.0;
      const adjustedEdge =
        raw.adjustedEdge !== undefined
          ? raw.adjustedEdge
          : Number((edge * quality * maturityFactor * regimeFactor * omegaWeight).toFixed(4));

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
        winner = bestCall.adjustedEdge > bestPut.adjustedEdge ? bestCall : bestPut;
        const loser = winner === bestCall ? bestPut : bestCall;
        reasons.push(
          `Superou conflito: ${winner.name} (${winner.action} AdjEdge: +${(winner.adjustedEdge * 100).toFixed(1)}%) sobre ${loser.name} (${loser.action} AdjEdge: +${(loser.adjustedEdge * 100).toFixed(1)}%) [Δ: +${(conflictDelta * 100).toFixed(1)}%]`
        );
      } else {
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
          isActionable: false,
          confluenceFamilies: [],
          confluentCount: 0,
        };
      }
    } else {
      winner = bestCall || bestPut;
    }

    // 5. Verificação de Confluência Ortogonal e Matriz de Covariância 21x21
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

    // Avalia o Determinante de Covariância e Probabilidade Condicional P(Loss | S_1 ∩ S_2)
    let maxConditionalLossRate = 0.4444;
    let totalCorrelationPenalty = 0;
    let pairCount = 0;

    if (opportunityPool && typeof opportunityPool.getPairwiseDependency === "function" && sameDirectionCandidates.length >= 2) {
      for (let i = 0; i < sameDirectionCandidates.length; i++) {
        for (let j = i + 1; j < sameDirectionCandidates.length; j++) {
          const dep = opportunityPool.getPairwiseDependency(
            sameDirectionCandidates[i].subStrategy,
            sameDirectionCandidates[j].subStrategy
          );
          if (dep.coActivations >= 3.0) {
            if (dep.conditionalLossRate > maxConditionalLossRate) {
              maxConditionalLossRate = dep.conditionalLossRate;
            }
            totalCorrelationPenalty += dep.correlationPenalty;
            pairCount++;
          }
        }
      }
    }

    const avgCorrPenalty = pairCount > 0 ? totalCorrelationPenalty / pairCount : 0;
    // Determinante efetivo da matriz de correlação 2x2: det(R) = 1 - rho^2
    const covarianceDeterminant = Number(clamp(1.0 - avgCorrPenalty * avgCorrPenalty, 0.20, 1.00).toFixed(4));
    const isCorrelatedInDefeat = maxConditionalLossRate > 0.52;

    const isConfluence = orthogonalGroups.size >= 2;
    let finalQuality = winner.quality;
    let finalConfidence = winner.confidence || clamp(winner.quality * 0.9, 0.45, 0.90);
    let finalAdjustedEdge = winner.adjustedEdge;

    if (isConfluence && !isCorrelatedInDefeat) {
      // Bônus ponderado pelo Determinante de Covariância det(R)
      const confluenceBonus = (orthogonalGroups.size - 1) * 0.05 * covarianceDeterminant;
      finalQuality = Number(clamp(finalQuality + confluenceBonus, 0.50, 0.98).toFixed(3));
      finalConfidence = Number(clamp(finalConfidence + confluenceBonus * 1.2, 0.50, 0.98).toFixed(3));
      reasons.push(
        `Confluência ortogonal de ${orthogonalGroups.size} famílias independentes: ${orthogonalFamilies.join(" + ")} (det(R)=${covarianceDeterminant.toFixed(2)})`
      );
    } else if (isCorrelatedInDefeat) {
      // Penalidade Bayesiana quando S_1 e S_2 são correlacionadas na derrota: AdjustedEdge cai!
      finalAdjustedEdge = Number((finalAdjustedEdge * (1 - Math.min(0.45, avgCorrPenalty + 0.15))).toFixed(4));
      reasons.unshift(
        `Veto Bayesiano Condicional: par correlacionado na derrota (P(Loss|S1∩S2)=${(maxConditionalLossRate * 100).toFixed(1)}%)`
      );
    }

    // 5.1 Política de Maturidade e Seletividade Acionável:
    const isShadow = winner.maturity === "SHADOW";
    const sameDirectionActive = sameDirectionCandidates.some((c) => c.maturity && c.maturity !== "SHADOW");
    const hasConfluence = isConfluence && sameDirectionActive && !isCorrelatedInDefeat;

    // Desconto de multicolinearidade estrutural (MOMENTUM + MICROSTRUCTURE)
    let passesCollinearityCheck = true;
    if (orthogonalGroups.size === 2 && orthogonalGroups.has("MOMENTUM") && orthogonalGroups.has("MICROSTRUCTURE")) {
      const combinedEdge = sameDirectionCandidates.reduce((acc, c) => acc + (c.edge || 0), 0);
      if (combinedEdge < 0.050) {
        passesCollinearityCheck = false;
        reasons.unshift(
          `Confluência Momentum+Microestrutura insuficiente (Edge somado +${(combinedEdge * 100).toFixed(1)}% < +5.0%): aguardando confirmação estrutural`
        );
      }
    }

    const isActionable = hasConfluence && passesCollinearityCheck;

    if (!isActionable) {
      if (isShadow && !sameDirectionActive) {
        reasons.unshift(`Oportunidade em SHADOW (${winner.subStrategy || winner.name}): observação analítica sem alerta acionável`);
      } else if (!hasConfluence && !isCorrelatedInDefeat) {
        reasons.unshift(`Sinal isolado sem confluência inter-famílias (${orthogonalGroups.size}/2 famílias necessárias): aguardando confirmação`);
      }
    }

    // 6. Cálculo do Valor Esperado (EV)
    const activeP = winner.conservativeProbability || winner.conservativeProb || 0.50;
    const ev = Number((activeP * payout - (1 - activeP) * 1.0).toFixed(3));

    const strategyId = winner.strategyId || winner.subStrategy || winner.strategy;
    const strategyName = winner.name || winner.subStrategy || winner.strategy;
    const subStrategy = winner.subStrategy || null;

    return {
      action: winner.action,
      label: `${winner.action} (+${(winner.edge * 100).toFixed(1)}% - ${subStrategy || strategyName})${isShadow && !hasConfluence ? " [SHADOW]" : ""}`,
      strategy: winner.strategy || strategyId,
      subStrategy,
      strategyId,
      strategyName,
      correlationGroup: winner.correlationGroup,
      edge: winner.edge,
      adjustedEdge: finalAdjustedEdge,
      covarianceDeterminant,
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

  select({ ensembleReport, payout = 0.80, qualityContext = {} }) {
    if (!ensembleReport) {
      return {
        action: "WAIT",
        label: "AGUARDAR",
        edge: 0,
        adjustedEdge: 0,
        ev: 0,
        quality: 0,
        confidence: 0,
        reasons: ["Sem relatório de ensemble"],
      };
    }

    const pUp = ensembleReport.probUp ?? 0.50;
    const pDown = ensembleReport.probDown ?? 0.50;
    const direction = pUp >= pDown ? "CALL" : "PUT";
    const rawProb = direction === "CALL" ? pUp : pDown;
    const consProb = ensembleReport.conservativeProb ?? rawProb;
    const breakeven = 1 / (1 + payout);
    const edge = Number((consProb - breakeven).toFixed(4));

    return this.selectCompetitive({
      candidates: [
        {
          action: direction,
          direction,
          name: ensembleReport.dominantEngine || "Ensemble",
          subStrategy: ensembleReport.dominantEngine || "ENSEMBLE",
          correlationGroup: "ENSEMBLE",
          rawProbability: rawProb,
          calibratedProbability: rawProb,
          conservativeProbability: consProb,
          edge,
          quality: ensembleReport.confidence ?? 0.70,
          confidence: ensembleReport.confidence ?? 0.70,
          maturity: "ACTIVE",
        },
      ],
      payout,
      qualityContext,
    });
  }
}
