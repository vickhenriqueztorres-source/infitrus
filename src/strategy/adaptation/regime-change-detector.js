/**
 * regime-change-detector.js - Camada de Adaptação por Regime e Detecção de Change Point
 * Oracle Quant Signals
 *
 * Princípio do PRD:
 * "Regime e Change Point deixam de ser estratégias. Eles passam a funcionar como camada de adaptação."
 *
 * Funções:
 * 1. Calcula regime de mercado contínuo (Tendência, Lateralização, Expansão, Compressão).
 * 2. Algoritmo CUSUM bicaudal para detectar mudança abrupta na distribuição de retornos/volatilidade.
 * 3. Modula o peso temporal: quando detecta mudança, aplica decaimento rápido nos dados antigos
 *    e eleva temporariamente o limiar de incerteza, SEM bloquear o sistema (preserva frequência).
 *
 * Arquitetura Pura:
 * - `evaluate(candles, rawFeatures)` é ESTRITAMENTE SOMENTE LEITURA (zero efeitos colaterais).
 * - `observeClosedCandle(closedCandle, rawFeatures)` atualiza o estado CUSUM uma vez por vela fechada.
 */

export class RegimeChangeDetector {
  constructor(config = {}) {
    this.cusumThreshold = config.cusumThreshold || 4.5;
    this.decayBase = config.decayBase || 0.05;

    // Estado CUSUM persistente
    this.sPos = 0;
    this.sNeg = 0;
    this.lastObservedCandle = 0;
    this.lastChangePointCandle = 0;
    this.marketStability = 1.0;
    this.isChangePoint = false;
  }

  /**
   * Atualiza os acumuladores CUSUM e a estabilidade de mercado a cada vela fechada.
   * Ignora se o timestamp for igual ou anterior ao último observado (idempotência).
   *
   * @param {Object} closedCandle
   * @param {Object} [rawFeatures={}]
   */
  observeClosedCandle(closedCandle, rawFeatures = {}) {
    if (!closedCandle || !closedCandle.timestamp) return;
    if (closedCandle.timestamp <= this.lastObservedCandle) return;
    this.lastObservedCandle = closedCandle.timestamp;

    const r1 = rawFeatures.r1 || 0;
    const sigma5 = rawFeatures.sigma5 || 1e-4;
    const vr3_20 = rawFeatures.vr3_20 || 1.0;

    const normalizedReturn = r1 / Math.max(1e-6, sigma5);
    const slack = 0.5; // Margem de tolerância CUSUM

    this.sPos = Math.max(0, this.sPos + normalizedReturn - slack);
    this.sNeg = Math.max(0, this.sNeg - normalizedReturn - slack);

    this.isChangePoint = this.sPos > this.cusumThreshold || this.sNeg > this.cusumThreshold || vr3_20 > 2.8;

    if (this.isChangePoint) {
      this.lastChangePointCandle = closedCandle.timestamp;
      this.sPos = 0;
      this.sNeg = 0;
      this.marketStability = 0.35; // Queda temporária de estabilidade
    } else {
      // Recuperação gradual da estabilidade (convergência de volta para 1.0)
      this.marketStability = Math.min(1.0, this.marketStability + 0.08);
    }
  }

  /**
   * Avalia a estabilidade do mercado e o regime atual.
   * Método ESTRITAMENTE PURO (somente leitura, não muta o estado interno).
   *
   * @param {Array<{ close: number, open: number, high: number, low: number, timestamp: number }>} candles
   * @param {Object} rawFeatures
   * @returns {Object} Diagnóstico de adaptação e modulação de pesos
   */
  evaluate(candles = [], rawFeatures = {}) {
    const n = candles.length;
    if (n < 15) {
      return {
        regime: "BOOTING",
        regimeProb: 0.5,
        isChangePoint: false,
        marketStability: 1.0,
        uncertaintyMultiplier: 1.0,
        temporalDecayFactor: this.decayBase,
      };
    }

    const lastCandle = candles[n - 1];
    const vr3_20 = rawFeatures.vr3_20 || 1.0;
    const persistence = rawFeatures.persistence || 0;

    // 1. Classificação do Regime Atual
    let regime = "RANGE_STABLE";
    let regimeProb = 0.65;

    if (vr3_20 > 1.4 && Math.abs(persistence) >= 0.6) {
      regime = persistence > 0 ? "TREND_EXPANSION_BULL" : "TREND_EXPANSION_BEAR";
      regimeProb = 0.80;
    } else if (vr3_20 < 0.75) {
      regime = "RANGE_COMPRESSION";
      regimeProb = 0.75;
    } else if (vr3_20 >= 2.2) {
      regime = "VOLATILITY_SHOCK";
      regimeProb = 0.90;
    }

    // 2. Avaliação de Change Point instantâneo ou registrado
    const isChangePoint = this.isChangePoint || vr3_20 > 2.8;

    // Se houve mudança recente (nas últimas 5 velas):
    const candlesSinceChange = (lastCandle.timestamp - this.lastChangePointCandle) / 60;
    const isRecentChange = isChangePoint || candlesSinceChange <= 5;

    let uncertaintyMultiplier = 1.0;
    let temporalDecayFactor = this.decayBase;

    if (isRecentChange) {
      // Eleva o limiar de margem de incerteza temporariamente (+25%), sem desligar os modelos
      uncertaintyMultiplier = 1.25;
      temporalDecayFactor = 0.15;
    }

    return {
      regime,
      regimeProb,
      isChangePoint,
      isRecentChange,
      marketStability: Number(this.marketStability.toFixed(3)),
      uncertaintyMultiplier,
      temporalDecayFactor,
    };
  }
}
