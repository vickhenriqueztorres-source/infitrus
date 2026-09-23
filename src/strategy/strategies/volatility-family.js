/**
 * volatility-family.js - Família 4: Volatilidade / Expansão (4 Subestratégias Autônomas)
 * Oracle Quant Signals
 *
 * Subestratégias:
 * 4A. Squeeze Breakout: Transição de compressão estreita para rompimento explosivo.
 * 4B. Expansion Continuation: Movimento em expansão de volatilidade estabelecida continuando seu range.
 * 4C. Volatility Ignition: Ignição precoce de variância e aceleração de fluxo antes do rompimento clássico.
 * 4D. Compression Directional Bias: Assimetria direcional interna de microestrutura acumulada dentro do squeeze.
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups } from "../pool/opportunity-pool.js";

export class VolatilityFamily {
  constructor(config = {}) {
    this.familyId = "VOLATILITY";
    this.familyName = "Volatilidade / Expansão";
    this.correlationGroup = CorrelationGroups.VOLATILITY;
    this.minWarmingCandles = config.minWarmingCandles || 20;
  }

  /**
   * Avalia os dados e gera candidatos independentes das 4 subestratégias de Volatilidade.
   *
   * @param {Object} params
   * @param {Array<Object>} params.candles
   * @param {Object} [params.featureMap={}]
   * @param {Object} [params.microMetrics=null]
   * @param {number} [params.payout=0.80]
   * @param {string} [params.regime="expansion"]
   * @returns {Array<Object>} Lista de OpportunityObjects qualificados
   */
  evaluate({ candles = [], featureMap = {}, microMetrics = null, payout = 0.80, regime = "expansion" }) {
    const n = candles.length;
    if (n < this.minWarmingCandles) return [];

    const breakeven = 1 / (1 + payout);
    const opportunities = [];

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];
    const c3 = candles[n - 4];

    // 1. Desvios padrões e razões de volatilidade
    const vr3_20 = featureMap.vr3_20 !== undefined ? featureMap.vr3_20 : (() => {
      const getStd = (window) => {
        const w = Math.min(window, n - 1);
        let sum = 0;
        const rets = [];
        for (let i = n - w; i < n; i++) {
          const r = Math.log(candles[i].close / Math.max(1e-6, candles[i - 1].close));
          rets.push(r);
          sum += r;
        }
        const mean = sum / w;
        let sumVar = 0;
        for (const r of rets) sumVar += (r - mean) ** 2;
        return Math.sqrt(sumVar / w) || 1e-5;
      };
      return getStd(3) / getStd(20);
    })();

    const vr5_20 = featureMap.vr5_20 !== undefined ? featureMap.vr5_20 : vr3_20;
    const volRatio = featureMap.volatilityRatio !== undefined ? featureMap.volatilityRatio : 1.0;

    // 2. Amplitudes e proporções
    const range0 = Math.max(1e-6, c0.high - c0.low);
    const range1 = Math.max(1e-6, c1.high - c1.low);
    const range2 = Math.max(1e-6, c2.high - c2.low);
    const rangeRatio = range0 / range1;

    let prevRangeSum = 0;
    const lookbackRange = Math.min(5, n - 1);
    for (let i = n - 1 - lookbackRange; i < n - 1; i++) {
      prevRangeSum += Math.max(1e-6, candles[i].high - candles[i].low);
    }
    const avgPrevRange = prevRangeSum / lookbackRange;
    const rangeToAvg = range0 / avgPrevRange;

    const closePos = featureMap.closePosition !== undefined ? featureMap.closePosition : (c0.close - c0.low) / range0;
    const bodyRatio = featureMap.bodyRatio !== undefined ? featureMap.bodyRatio : Math.abs(c0.close - c0.open) / range0;
    const upperWick = featureMap.upperWickRatio !== undefined ? featureMap.upperWickRatio : (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick = featureMap.lowerWickRatio !== undefined ? featureMap.lowerWickRatio : (Math.min(c0.open, c0.close) - c0.low) / range0;

    const pressure = microMetrics?.pressure || 0;
    const pressureVel = microMetrics?.pressureVelocity || 0;
    const pressureAccel = microMetrics?.pressureAcceleration || 0;
    const accel = featureMap.priceAcceleration || 0;

    const regimeComp = regime === "expansion" || regime === "breakout" ? 1.05 : regime === "compression" ? 0.90 : 1.0;

    // =========================================================================
    // 4A — SQUEEZE BREAKOUT (Rompimento Explosivo pós Compressão)
    // =========================================================================
    {
      const prevHighMax = Math.max(c1.high, c2.high, c3 ? c3.high : c2.high);
      const prevLowMin = Math.min(c1.low, c2.low, c3 ? c3.low : c2.low);

      const wasCompressed = vr5_20 <= 0.85 || (range1 < avgPrevRange * 0.85 && range2 < avgPrevRange * 0.85);
      const isExpandingNow = rangeToAvg >= 1.25 || rangeRatio >= 1.30;

      let sqDir = null;
      let sqScore = 0;
      const sqReasons = [];

      if (wasCompressed && isExpandingNow) {
        if (c0.close > prevHighMax && c0.close > c0.open && pressure >= -0.05) {
          sqDir = "CALL";
          sqScore = 0.35 + clamp((rangeToAvg - 1.2) * 0.35, 0, 0.35) + clamp(closePos * 0.20, 0, 0.20) + (pressure > 0.10 ? 0.15 : 0);
          sqReasons.push(`Rompimento de squeeze para alta (${rangeToAvg.toFixed(1)}x amplitude média)`);
          sqReasons.push("Superação da máxima das últimas 3 velas com fechamento firme");
        } else if (c0.close < prevLowMin && c0.close < c0.open && pressure <= 0.05) {
          sqDir = "PUT";
          sqScore = 0.35 + clamp((rangeToAvg - 1.2) * 0.35, 0, 0.35) + clamp((1 - closePos) * 0.20, 0, 0.20) + (pressure < -0.10 ? 0.15 : 0);
          sqReasons.push(`Rompimento de squeeze para baixa (${rangeToAvg.toFixed(1)}x amplitude média)`);
          sqReasons.push("Perda da mínima das últimas 3 velas com fechamento firme");
        }
      }

      if (sqDir && sqScore >= 0.50) {
        const rawProb = Number(clamp(0.50 + sqScore * 0.22, 0.50, 0.72).toFixed(4));
        const uncert = Number(clamp(0.04 - sqScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "SQUEEZE_BREAKOUT",
            correlationGroup: this.correlationGroup,
            direction: sqDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.55 + sqScore * 0.40, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { vr5_20, rangeToAvg, rangeRatio, pressure },
            reasons: sqReasons,
            timestamp: c0.timestamp,
            fingerprint: `SQ_BREAK_${sqDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 4B — EXPANSION CONTINUATION (Volatilidade já em expansão continuando)
    // =========================================================================
    {
      const isEstablishedExpansion = vr3_20 >= 1.20 || volRatio >= 1.25;
      let expDir = null;
      let expScore = 0;

      if (isEstablishedExpansion && rangeRatio >= 1.10) {
        if (c0.close > c0.open && closePos >= 0.68 && upperWick <= 0.25) {
          expDir = "CALL";
          expScore = 0.35 + clamp((vr3_20 - 1.2) * 0.3, 0, 0.30) + clamp(closePos * 0.25, 0, 0.25) + (pressure > 0.08 ? 0.15 : 0);
        } else if (c0.close < c0.open && closePos <= 0.32 && lowerWick <= 0.25) {
          expDir = "PUT";
          expScore = 0.35 + clamp((vr3_20 - 1.2) * 0.3, 0, 0.30) + clamp((1 - closePos) * 0.25, 0, 0.25) + (pressure < -0.08 ? 0.15 : 0);
        }
      }

      if (expDir && expScore >= 0.50) {
        const rawProb = Number(clamp(0.50 + expScore * 0.20, 0.50, 0.71).toFixed(4));
        const uncert = Number(clamp(0.042 - expScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "EXPANSION_CONTINUATION",
            correlationGroup: this.correlationGroup,
            direction: expDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.52 + expScore * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { vr3_20, rangeRatio, closePos },
            reasons: [
              `Expansão contínua de volatilidade (VR: ${vr3_20.toFixed(2)})`,
              `Fechamento no extremo favorável (${(closePos * 100).toFixed(0)}%)`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `EXP_CONT_${expDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 4C — VOLATILITY IGNITION (Início precoce de aceleração da variância)
    // =========================================================================
    {
      const hasIgnition = pressureVel !== 0 && (Math.abs(pressureVel) >= 0.12 || Math.abs(pressureAccel) >= 0.08);
      let ignDir = null;
      let ignScore = 0;

      if (hasIgnition) {
        if (pressureVel > 0.10 && pressure > 0.12 && closePos >= 0.55) {
          ignDir = "CALL";
          ignScore = 0.35 + clamp(pressureVel * 1.5, 0, 0.30) + clamp(pressure * 0.5, 0, 0.25) + (accel > 0 ? 0.10 : 0);
        } else if (pressureVel < -0.10 && pressure < -0.12 && closePos <= 0.45) {
          ignDir = "PUT";
          ignScore = 0.35 + clamp(-pressureVel * 1.5, 0, 0.30) + clamp(-pressure * 0.5, 0, 0.25) + (accel < 0 ? 0.10 : 0);
        }
      }

      if (ignDir && ignScore >= 0.50) {
        const rawProb = Number(clamp(0.50 + ignScore * 0.20, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.045 - ignScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "VOLATILITY_IGNITION",
            correlationGroup: this.correlationGroup,
            direction: ignDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.50 + ignScore * 0.40, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { pressureVel, pressureAccel, pressure },
            reasons: [
              `Ignição de volatilidade por aceleração de ticks (vel: ${(pressureVel * 100).toFixed(0)}%)`,
              `Pressão direcional agressiva em início de expansão`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `VOL_IGN_${ignDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 4D — COMPRESSION DIRECTIONAL BIAS (Assimetria interna no squeeze)
    // =========================================================================
    {
      const isCompressed = vr3_20 < 0.80 && rangeRatio <= 0.90;
      let biasDir = null;
      let biasScore = 0;

      if (isCompressed) {
        // Se o mercado está congelado em amplitude, mas o fluxo interno está empurrando claramente para um lado
        if (pressure >= 0.22 && closePos >= 0.52) {
          biasDir = "CALL";
          biasScore = 0.35 + clamp(pressure * 0.6, 0, 0.35) + clamp((closePos - 0.5) * 0.4, 0, 0.20) + (1 - vr3_20) * 0.15;
        } else if (pressure <= -0.22 && closePos <= 0.48) {
          biasDir = "PUT";
          biasScore = 0.35 + clamp(-pressure * 0.6, 0, 0.35) + clamp((0.5 - closePos) * 0.4, 0, 0.20) + (1 - vr3_20) * 0.15;
        }
      }

      if (biasDir && biasScore >= 0.50) {
        const rawProb = Number(clamp(0.50 + biasScore * 0.19, 0.50, 0.69).toFixed(4));
        const uncert = Number(clamp(0.043 - biasScore * 0.012, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "COMPRESSION_DIRECTIONAL_BIAS",
            correlationGroup: this.correlationGroup,
            direction: biasDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.50 + biasScore * 0.35, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regime === "compression" ? 1.10 : 0.95,
            evidence: { vr3_20, pressure, closePos },
            reasons: [
              `Assimetria em compressão (pressão: ${(pressure * 100).toFixed(0)}%)`,
              `Acúmulo direcional antes da quebra da consolidação`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `COMP_BIAS_${biasDir}_${c0.timestamp}`,
          });
        }
      }
    }

    return opportunities;
  }
}
