/**
 * quant-portfolio.js - Orquestrador do Sistema Quantitativo M1
 * Oracle Quant Signals
 *
 * Arquitetura de 5 Grandes Famílias e 21 Subestratégias Independentes:
 *   Dados M1 + Microestrutura
 *       ↓
 *   FeatureVectorBuilder (50+ variáveis contínuas, 0 lookahead)
 *       ↓
 *   5 Famílias de Estratégias em Paralelo (~21 Subestratégias Autônomas):
 *     1. Família Continuação / Momentum      (4 Subestratégias)
 *     2. Família Reversão / Exaustão         (4 Subestratégias)
 *     3. Família Microestrutura              (5 Subestratégias)
 *     4. Família Volatilidade / Expansão     (4 Subestratégias)
 *     5. Família Analogia Histórica          (4 Subestratégias)
 *       ↓
 *   OpportunityPool (Validação de Schema, Agrupamento de Correlação, Deduplicação Intra-Família & Calibração Brier)
 *       ↓
 *   Competitive Edge Selector (Leilão de AdjustedEdge, Resolução de Conflitos & Bônus de Confluência Ortogonal)
 *       ↓
 *   Decisão Final (CALL / PUT / WAIT)
 */

import { DEFAULT_PAYOUT } from "./payout-calculator.js";
import { clamp } from "./detectors/detector-types.js";
import { FeatureVectorBuilder } from "./detectors/feature-vector-builder.js";
import { RegimeChangeDetector } from "./adaptation/regime-change-detector.js";
import { OpportunityPool, CorrelationGroups } from "./pool/opportunity-pool.js";
import { ContinuationFamily } from "./strategies/continuation-family.js";
import { ReversionFamily } from "./strategies/reversion-family.js";
import { MicrostructureFamily } from "./strategies/microstructure-family.js";
import { VolatilityFamily } from "./strategies/volatility-family.js";
import { HistoricalAnalogyFamily } from "./strategies/historical-analogy-family.js";
import { ContinuationStrategy } from "./strategies/continuation-strategy.js";
import { ReversionStrategy } from "./strategies/reversion-strategy.js";
import { MicrostructureStrategy } from "./strategies/microstructure-strategy.js";
import { VolatilityExpansionStrategy } from "./strategies/volatility-expansion-strategy.js";
import { HistoricalAnalogyStrategy } from "./strategies/historical-analogy-strategy.js";
import { EdgeSelector } from "./decision/edge-selector.js";

export class QuantPortfolio {
  constructor(config = {}) {
    this.payout = config.payout || DEFAULT_PAYOUT;
    this.minEdge = config.minEdge !== undefined ? config.minEdge : 0.015;

    // Componentes de extração contínua e regime
    this.featureBuilder = new FeatureVectorBuilder();
    this.regimeDetector = new RegimeChangeDetector();

    // Estratégias Legadas (compatibilidade retroativa)
    this.strategyContinuation = new ContinuationStrategy(config.continuationConfig);
    this.strategyReversion = new ReversionStrategy(config.reversionConfig);
    this.strategyMicrostructure = new MicrostructureStrategy(config.microstructureConfig);
    this.strategyVolatility = new VolatilityExpansionStrategy(config.volatilityConfig);
    this.strategyAnalogy = new HistoricalAnalogyStrategy(config.analogyConfig);

    // As 5 Grandes Famílias Quantitativas (~21 Subestratégias Autônomas)
    this.familyContinuation = new ContinuationFamily(config.continuationConfig);
    this.familyReversion = new ReversionFamily(config.reversionConfig);
    this.familyMicrostructure = new MicrostructureFamily(config.microstructureConfig);
    this.familyVolatility = new VolatilityFamily(config.volatilityConfig);
    this.familyAnalogy = new HistoricalAnalogyFamily(config.analogyConfig);

    // Pool de Oportunidades (Validador, Calibrador e Agrupador)
    this.opportunityPool = new OpportunityPool({
      minEdge: this.minEdge,
      minQuality: config.minQuality || 0.50,
    });

    // Tomador de Decisão Competitiva
    this.edgeSelector = new EdgeSelector({
      minEdge: this.minEdge,
      minQuality: config.minQuality || 0.50,
      conflictThreshold: config.conflictThreshold || 0.010,
    });
  }

  setPayout(newPayout) {
    if (Number.isFinite(newPayout) && newPayout > 0 && newPayout < 2) {
      this.payout = Number(newPayout);
    }
  }

  /**
   * Avalia a série temporal sob as 5 famílias e ~21 subestratégias autônomas em paralelo.
   *
   * @param {Object} params
   * @param {string} params.symbol
   * @param {number} params.timeframeSeconds
   * @param {Array<{ timestamp: number, open: number, high: number, low: number, close: number }>} params.candles
   * @param {Object} [params.microMetrics=null]
   * @param {boolean} [params.isReady=true]
   * @param {number} [params.gapCount=0]
   * @param {boolean} [params.isStale=false]
   * @returns {Object} Relatório estruturado de decisão
   */
  evaluate({
    symbol,
    timeframeSeconds = 60,
    candles = [],
    microMetrics = null,
    isReady = true,
    gapCount = 0,
    isStale = false,
  }) {
    const sym = String(symbol || "").trim().toUpperCase();
    const len = candles.length;
    const lastCandle = len > 0 ? candles[len - 1] : null;
    const breakeven = Number((1 / (1 + this.payout)).toFixed(4));

    if (!isReady || len < 15) {
      return {
        action: "WAIT",
        label: "AGUARDAR (Aquecendo)",
        strategy: null,
        subStrategy: null,
        strategyId: null,
        strategyName: null,
        symbol: sym,
        timeframeSeconds,
        candleTimestamp: lastCandle ? lastCandle.timestamp : null,
        entryPrice: lastCandle ? lastCandle.close : null,
        probability: 0.50,
        conservativeProbability: 0.50,
        ev: 0,
        edge: 0,
        adjustedEdge: 0,
        quality: 0,
        confidence: 0,
        payout: this.payout,
        breakeven,
        strategiesResults: this._getEmptyFamilySummary(breakeven),
        subStrategiesResults: [],
        microstructure: microMetrics,
        reasons: [`Coletando dados M1 (${len}/15 velas necessárias)`],
        uncertainty: 0.20,
        isDivergent: false,
        isConfluence: false,
        isConflict: false,
      };
    }

    // 1. Extração do Vetor de Features (50+ variáveis contínuas, 0 lookahead) e Regime
    const { vector, featureMap, volatilityState } = this.featureBuilder.build(candles, microMetrics);
    const adaptation = this.regimeDetector.evaluate(candles, featureMap);
    const currentRegime = adaptation.regime || "trend";

    // 2. Execução Paralela das 5 Famílias Quantitativas
    const oppContinuation = this.familyContinuation.evaluate({
      candles,
      featureMap,
      microMetrics,
      payout: this.payout,
      regime: currentRegime,
    });

    const oppReversion = this.familyReversion.evaluate({
      candles,
      featureMap,
      microMetrics,
      payout: this.payout,
      regime: currentRegime,
    });

    const oppMicrostructure = this.familyMicrostructure.evaluate({
      microMetrics,
      payout: this.payout,
      regime: currentRegime,
    });

    const oppVolatility = this.familyVolatility.evaluate({
      candles,
      featureMap,
      microMetrics,
      payout: this.payout,
      regime: currentRegime,
    });

    const oppAnalogy = this.familyAnalogy.evaluate({
      candles,
      currentVector: vector,
      featureMap,
      microMetrics,
      volatilityState,
      payout: this.payout,
      regime: currentRegime,
    });

    // Lista consolidada de todas as subestratégias que geraram oportunidade
    const allSubOpportunities = [
      ...oppContinuation,
      ...oppReversion,
      ...oppMicrostructure,
      ...oppVolatility,
      ...oppAnalogy,
    ];

    // 3. Processamento no OpportunityPool:
    // Validação de schema, calibração Brier, cálculo de AdjustedEdge e filtro de redundância intra-família
    const pooledCandidates = this.opportunityPool.process(allSubOpportunities, {
      payout: this.payout,
      regime: currentRegime,
      marketStability: adaptation.marketStability,
    });

    // 4. Competitive Edge Selector:
    // Ranqueamento por AdjustedEdge, resolução de conflitos (ΔEdge >= 1.0 p.p.) e bônus de confluência inter-famílias
    const decision = this.edgeSelector.selectCompetitive({
      candidates: pooledCandidates,
      payout: this.payout,
      qualityContext: {
        gapCount,
        isStale,
        marketStability: adaptation.marketStability,
      },
    });

    // 5. Decisão Direta Pura (Sem mutações internas, deduplicação delegada ao SignalLifecycle)
    const finalDecision = decision;

    // 6. Resumo das 5 Famílias para Compatibilidade com UI e Auditoria
    const familySummaryMap = {
      CONTINUATION: { id: "continuation", name: "Continuação / Momentum", opps: oppContinuation },
      REVERSION: { id: "reversion", name: "Reversão / Exaustão", opps: oppReversion },
      MICROSTRUCTURE: { id: "microstructure", name: "Microestrutura / Fluxo", opps: oppMicrostructure },
      VOLATILITY: { id: "volatility_expansion", name: "Expansão de Volatilidade", opps: oppVolatility },
      HISTORICAL_ANALOGY: { id: "historical_analogy", name: "Analogia Histórica", opps: oppAnalogy },
    };

    const strategiesResults = Object.values(familySummaryMap).map((fam) => {
      const best = fam.opps.length > 0
        ? fam.opps.slice().sort((a, b) => b.edge - a.edge)[0]
        : null;

      if (best) {
        const isCall = best.direction === "CALL";
        return {
          id: fam.id,
          name: fam.name,
          probUp: isCall ? best.rawProbability : Number((1 - best.rawProbability).toFixed(4)),
          probDown: !isCall ? best.rawProbability : Number((1 - best.rawProbability).toFixed(4)),
          conservativeProb: best.conservativeProbability,
          edge: best.edge,
          quality: best.quality,
          confidence: Number(clamp(best.quality * 0.9, 0.45, 0.95).toFixed(3)),
          action: best.direction,
          subStrategy: best.subStrategy,
          hasEdge: best.edge >= this.minEdge,
          reasons: best.reasons || [],
        };
      }

      return {
        id: fam.id,
        name: fam.name,
        probUp: 0.50,
        probDown: 0.50,
        conservativeProb: 0.50,
        edge: 0,
        quality: 0.50,
        confidence: 0.40,
        action: "WAIT",
        subStrategy: null,
        hasEdge: false,
        reasons: ["Sem oportunidade qualificada nesta família"],
      };
    });

    return {
      action: finalDecision.action,
      label: finalDecision.label,
      strategy: finalDecision.strategy,
      subStrategy: finalDecision.subStrategy,
      strategyId: finalDecision.strategyId,
      strategyName: finalDecision.strategyName,
      correlationGroup: finalDecision.correlationGroup,
      symbol: sym,
      timeframeSeconds,
      candleTimestamp: lastCandle.timestamp,
      entryPrice: lastCandle.close,
      probability: finalDecision.probability,
      conservativeProbability: finalDecision.conservativeProbability,
      ev: finalDecision.ev,
      edge: finalDecision.edge,
      adjustedEdge: finalDecision.adjustedEdge,
      quality: finalDecision.quality,
      confidence: finalDecision.confidence,
      payout: this.payout,
      breakeven: finalDecision.breakeven,
      executionMoment: "AT_CANDLE_OPEN", // Entrada estrita na abertura da nova vela M1
      strategiesResults,
      subStrategiesResults: allSubOpportunities,
      pooledCandidates,
      microstructure: microMetrics,
      regime: adaptation.regime,
      marketStability: adaptation.marketStability,
      reasons: finalDecision.reasons,
      isConfluence: finalDecision.isConfluence,
      confluenceFamilies: finalDecision.confluenceFamilies || [],
      confluentCount: finalDecision.confluentCount || 1,
      isConflict: finalDecision.isConflict,
      isDivergent: Boolean(finalDecision.isConflict),
      uncertainty: Number((1 - adaptation.marketStability).toFixed(4)),
      isVetoed: finalDecision.isVetoed,
    };
  }

  /**
   * Atualização de estado APENAS quando uma vela fecha.
   *
   * @param {Array<Object>} closedCandles
   * @param {Object} [features=null]
   */
  observeClosedCandle(closedCandles = [], features = null) {
    if (this.regimeDetector?.observeClosedCandle) {
      this.regimeDetector.observeClosedCandle(closedCandles, features);
    }
    if (this.featureBuilder?.observeClosedCandle) {
      this.featureBuilder.observeClosedCandle(closedCandles, features);
    }
  }

  /**
   * Registra resultado real da operação (WIN/LOSS) para calibração online.
   *
   * @param {Object} snapshot - Snapshot imutável gerado na emissão do sinal
   * @param {boolean} won - true se WIN, false se LOSS
   */
  recordOutcome(snapshot, won) {
    if (!snapshot) return;
    const subStrategy = snapshot.subStrategy;
    const direction = snapshot.action;
    const prob = snapshot.conservativeProbability ?? snapshot.probability ?? 0.5;
    const outcomeUp = won ? (direction === "CALL" ? 1 : 0) : (direction === "CALL" ? 0 : 1);

    if (subStrategy && this.opportunityPool) {
      this.opportunityPool.recordOutcome(subStrategy, direction, prob, outcomeUp);
    }
    if (this.familyAnalogy?.update) {
      this.familyAnalogy.update(null, outcomeUp);
    }
  }

  /**
   * Atualização online legada (compatibilidade retroativa).
   *
   * @param {string} symbol
   * @param {number} actualOutcomeUp - 1 se alta, 0 se baixa, 0.5 se doji
   */
  onCandleClosed(symbol, actualOutcomeUp) {
    if (this.familyAnalogy?.update) {
      this.familyAnalogy.update(null, actualOutcomeUp);
    }
  }

  _getEmptyFamilySummary(breakeven) {
    const families = [
      { id: "continuation", name: "Continuação / Momentum" },
      { id: "reversion", name: "Reversão / Exaustão" },
      { id: "microstructure", name: "Microestrutura / Fluxo" },
      { id: "volatility_expansion", name: "Expansão de Volatilidade" },
      { id: "historical_analogy", name: "Analogia Histórica" },
    ];
    return families.map((f) => ({
      id: f.id,
      name: f.name,
      probUp: 0.50,
      probDown: 0.50,
      conservativeProb: 0.50,
      edge: 0,
      quality: 0.30,
      confidence: 0.30,
      action: "WAIT",
      subStrategy: null,
      hasEdge: false,
      reasons: ["Aquecendo histórico"],
    }));
  }
}
