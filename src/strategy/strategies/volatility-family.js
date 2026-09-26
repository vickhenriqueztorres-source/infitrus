/**
 * volatility-family.js - Família 4: Volatilidade / Expansão (4 Subestratégias Autônomas Ortogonalizadas)
 * Oracle Quant Signals — Active Quant Optimizer
 *
 * Subestratégias:
 * 4A. Squeeze Breakout: Rompimento explosivo de caixa de consolidação estreita (6 velas) com expansão >= 1.25x ATR.
 * 4B. Expansion Continuation: Continuidade em regime de expansão de variância (VR3/20 >= 1.25) rompendo máxima/mínima anterior sem clímax.
 * 4C. Volatility Ignition: Transição abrupta de vela contraída para expansão de amplitude + aceleração cinemática de chegada de ticks.
 * 4D. Compression Directional Bias: Formação de triângulo ascendente/descendente (fundos ascendentes ou topos descendentes) dentro de squeeze.
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups, computeWilsonLowerBound } from "../pool/opportunity-pool.js";

export class VolatilityFamily {
  constructor(config = {}) {
    this.familyId = "VOLATILITY";
    this.familyName = "Volatilidade / Expansão";
    this.correlationGroup = CorrelationGroups.VOLATILITY;
    this.minWarmingCandles = config.minWarmingCandles || 20;
  }

  /**
   * Avalia os dados e gera candidatos independentes das 4 subestratégias de Volatilidade.
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

    // 1. Razões de Variância (VR3/20 e VR5/20) e Z-Score
    const vr3_20 =
      featureMap.vr3_20 !== undefined
        ? featureMap.vr3_20
        : (() => {
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
    const zScore = featureMap.zScore20 !== undefined ? featureMap.zScore20 : 0;

    // 2. Amplitudes e Caixa de Consolidação Prévia (últimas 6 velas fechadas: n-7 .. n-2)
    const range0 = Math.max(1e-6, c0.high - c0.low);
    const range1 = Math.max(1e-6, c1.high - c1.low);
    const range2 = Math.max(1e-6, c2.high - c2.low);
    const rangeRatio = range0 / range1;

    let prevRangeSum = 0;
    const lookbackRange = Math.min(10, n - 1);
    for (let i = n - 1 - lookbackRange; i < n - 1; i++) {
      prevRangeSum += Math.max(1e-6, candles[i].high - candles[i].low);
    }
    const avgPrevRange = prevRangeSum / lookbackRange;
    const rangeToAvg = range0 / avgPrevRange;

    const boxStart = Math.max(0, n - 7);
    let boxHigh = -Infinity;
    let boxLow = Infinity;
    for (let i = boxStart; i < n - 1; i++) {
      if (candles[i].high > boxHigh) boxHigh = candles[i].high;
      if (candles[i].low < boxLow) boxLow = candles[i].low;
    }
    const boxWidthToAvg = (boxHigh - boxLow) / avgPrevRange;

    const closePos = featureMap.closePosition !== undefined ? featureMap.closePosition : (c0.close - c0.low) / range0;
    const bodyRatio = featureMap.bodyRatio !== undefined ? featureMap.bodyRatio : Math.abs(c0.close - c0.open) / range0;
    const upperWick = featureMap.upperWickRatio !== undefined ? featureMap.upperWickRatio : (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick = featureMap.lowerWickRatio !== undefined ? featureMap.lowerWickRatio : (Math.min(c0.open, c0.close) - c0.low) / range0;

    const pressure = microMetrics?.pressure || 0;
    const integratedFlow = microMetrics?.integratedFlowPressure !== undefined ? microMetrics.integratedFlowPressure : pressure;
    const pressureVel = microMetrics?.pressureVelocity || 0;
    const pressureAccel = microMetrics?.pressureAcceleration || 0;
    const kinematicRejection = microMetrics?.kinematicRejection || 0;
    const kinematicConvergence = microMetrics?.kinematicConvergence || 0;
    const accel = featureMap.priceAcceleration || 0;

    const regimeComp = regime === "expansion" || regime === "breakout" ? 1.05 : regime === "compression" ? 0.90 : 1.0;

    // =========================================================================
    // 4A — SQUEEZE BREAKOUT (Rompimento de Caixa Estreita de 6 Velas pós Compressão)
    // =========================================================================
    {
      const wasCompressed =
        vr5_20 <= 0.85 ||
        boxWidthToAvg <= 2.40 ||
        (range1 < avgPrevRange * 0.85 && range2 < avgPrevRange * 0.85);
      const isExpandingNow = (rangeToAvg >= 1.25 || rangeRatio >= 1.35) && rangeToAvg <= 2.35;

      let sqDir = null;
      let sqScore = 0;
      const sqReasons = [];

      if (wasCompressed && isExpandingNow && bodyRatio >= 0.58) {
        if (
          c0.close > boxHigh &&
          c0.close > c0.open &&
          integratedFlow >= 0.15 &&
          closePos >= 0.70 &&
          upperWick <= 0.22 &&
          kinematicRejection >= -0.15
        ) {
          sqDir = "CALL";
          sqScore =
            0.38 +
            clamp((rangeToAvg - 1.2) * 0.32, 0, 0.30) +
            clamp(closePos * 0.20, 0, 0.20) +
            (integratedFlow > 0.20 ? 0.14 : 0.06);
          sqReasons.push(`Rompimento de caixa de compressão para alta (${rangeToAvg.toFixed(1)}x amplitude média)`);
          sqReasons.push("Superação limpa do teto das últimas 6 velas com fluxo comprador");
        } else if (
          c0.close < boxLow &&
          c0.close < c0.open &&
          integratedFlow <= -0.15 &&
          closePos <= 0.30 &&
          lowerWick <= 0.22 &&
          kinematicRejection <= 0.15
        ) {
          sqDir = "PUT";
          sqScore =
            0.38 +
            clamp((rangeToAvg - 1.2) * 0.32, 0, 0.30) +
            clamp((1 - closePos) * 0.20, 0, 0.20) +
            (integratedFlow < -0.20 ? 0.14 : 0.06);
          sqReasons.push(`Rompimento de caixa de compressão para baixa (${rangeToAvg.toFixed(1)}x amplitude média)`);
          sqReasons.push("Perda limpa do piso das últimas 6 velas com fluxo vendedor");
        }
      }

      if (sqDir && sqScore >= 0.68) {
        const rawProb = Number(clamp(0.50 + sqScore * 0.19, 0.50, 0.705).toFixed(4));
        const uncert = Number(clamp(0.041 - sqScore * 0.014, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 42, 102);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "SQUEEZE_BREAKOUT",
            correlationGroup: this.correlationGroup,
            direction: sqDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.56 + sqScore * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { vr5_20, rangeToAvg, rangeRatio, pressure: integratedFlow },
            reasons: sqReasons,
            timestamp: c0.timestamp,
            fingerprint: `SQ_BREAK_${sqDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 4B — EXPANSION CONTINUATION (Expansão de Variância Rompendo Máxima/Mínima Anterior sem Clímax)
    // =========================================================================
    {
      const isEstablishedExpansion = (vr3_20 >= 1.25 || volRatio >= 1.28) && Math.abs(zScore) < 1.90;
      let expDir = null;
      let expScore = 0;

      // Diferencia da Família 1 exigindo superação da máxima/mínima da vela anterior (c1.high / c1.low) sob regime VR3_20 alto
      if (isEstablishedExpansion && rangeRatio >= 1.12 && rangeToAvg <= 2.20 && bodyRatio >= 0.60) {
        if (
          c0.close > c1.high &&
          c0.close > c0.open &&
          closePos >= 0.74 &&
          upperWick <= 0.18 &&
          integratedFlow >= 0.18 &&
          kinematicRejection >= -0.15
        ) {
          expDir = "CALL";
          expScore =
            0.38 +
            clamp((vr3_20 - 1.2) * 0.28, 0, 0.28) +
            clamp(closePos * 0.22, 0, 0.22) +
            (integratedFlow > 0.20 ? 0.14 : 0.06);
        } else if (
          c0.close < c1.low &&
          c0.close < c0.open &&
          closePos <= 0.26 &&
          lowerWick <= 0.18 &&
          integratedFlow <= -0.18 &&
          kinematicRejection <= 0.15
        ) {
          expDir = "PUT";
          expScore =
            0.38 +
            clamp((vr3_20 - 1.2) * 0.28, 0, 0.28) +
            clamp((1 - closePos) * 0.22, 0, 0.22) +
            (integratedFlow < -0.20 ? 0.14 : 0.06);
        }
      }

      if (expDir && expScore >= 0.68) {
        const rawProb = Number(clamp(0.50 + expScore * 0.185, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.042 - expScore * 0.014, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 42, 100);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "EXPANSION_CONTINUATION",
            correlationGroup: this.correlationGroup,
            direction: expDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.55 + expScore * 0.36, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { vr3_20, rangeRatio, closePos },
            reasons: [
              `Expansão de variância sustentada (VR3/20: ${vr3_20.toFixed(2)}) rompendo extremo prévio`,
              `Fechamento limpo no extremo (${(closePos * 100).toFixed(0)}%) sem exaustão`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `EXP_CONT_${expDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 4C — VOLATILITY IGNITION (Transição de Vela Quieta c1 para Salto de Amplitude c0 >= 1.35x)
    // =========================================================================
    {
      const quietPriorCandle = range1 <= avgPrevRange * 0.95;
      const suddenRangeJump = range0 >= range1 * 1.35 && rangeToAvg <= 2.25;
      const hasFlowIgnition = Math.abs(pressureVel) >= 0.20 || Math.abs(pressureAccel) >= 0.14;

      let ignDir = null;
      let ignScore = 0;

      if (quietPriorCandle && suddenRangeJump && hasFlowIgnition && bodyRatio >= 0.60 && Math.abs(zScore) < 1.85) {
        if (
          c0.close > c0.open &&
          pressureVel > 0.20 &&
          integratedFlow > 0.24 &&
          closePos >= 0.68 &&
          upperWick <= 0.22 &&
          kinematicRejection >= -0.10
        ) {
          ignDir = "CALL";
          ignScore =
            0.38 +
            clamp(pressureVel * 1.3, 0, 0.26) +
            clamp(integratedFlow * 0.45, 0, 0.22) +
            (accel > 0 || kinematicConvergence > 0 ? 0.10 : 0);
        } else if (
          c0.close < c0.open &&
          pressureVel < -0.20 &&
          integratedFlow < -0.24 &&
          closePos <= 0.32 &&
          lowerWick <= 0.22 &&
          kinematicRejection <= 0.10
        ) {
          ignDir = "PUT";
          ignScore =
            0.38 +
            clamp(-pressureVel * 1.3, 0, 0.26) +
            clamp(-integratedFlow * 0.45, 0, 0.22) +
            (accel < 0 || kinematicConvergence < 0 ? 0.10 : 0);
        }
      }

      if (ignDir && ignScore >= 0.68) {
        const rawProb = Number(clamp(0.50 + ignScore * 0.185, 0.50, 0.695).toFixed(4));
        const uncert = Number(clamp(0.043 - ignScore * 0.014, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 40, 96);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "VOLATILITY_IGNITION",
            correlationGroup: this.correlationGroup,
            direction: ignDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.54 + ignScore * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { pressureVel, pressureAccel, rangeRatio: Number(rangeRatio.toFixed(2)) },
            reasons: [
              `Ignição abrupta de volatilidade (${rangeRatio.toFixed(1)}x vela anterior)`,
              `Aceleração de agressão (+${(Math.abs(pressureVel) * 100).toFixed(0)}%) após vela contraída`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `VOL_IGN_${ignDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 4D — COMPRESSION DIRECTIONAL BIAS (Triângulo Ascendente/Descendente dentro do Squeeze)
    // =========================================================================
    {
      const isCompressed = vr3_20 < 0.80 && rangeRatio <= 0.95;
      const higherLows = c0.low >= c1.low && c1.low >= (c3 ? c2.low : c1.low);
      const lowerHighs = c0.high <= c1.high && c1.high <= (c3 ? c2.high : c1.high);

      let biasDir = null;
      let biasScore = 0;

      if (isCompressed) {
        if (higherLows && integratedFlow >= 0.38 && closePos >= 0.64 && upperWick <= 0.25) {
          biasDir = "CALL";
          biasScore =
            0.38 +
            clamp(integratedFlow * 0.55, 0, 0.32) +
            clamp((closePos - 0.5) * 0.4, 0, 0.18) +
            (1 - vr3_20) * 0.15;
        } else if (lowerHighs && integratedFlow <= -0.38 && closePos <= 0.36 && lowerWick <= 0.25) {
          biasDir = "PUT";
          biasScore =
            0.38 +
            clamp(-integratedFlow * 0.55, 0, 0.32) +
            clamp((0.5 - closePos) * 0.4, 0, 0.18) +
            (1 - vr3_20) * 0.15;
        }
      }

      if (biasDir && biasScore >= 0.68) {
        const rawProb = Number(clamp(0.50 + biasScore * 0.18, 0.50, 0.69).toFixed(4));
        const uncert = Number(clamp(0.043 - biasScore * 0.013, 0.023, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 40, 95);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "COMPRESSION_DIRECTIONAL_BIAS",
            correlationGroup: this.correlationGroup,
            direction: biasDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.53 + biasScore * 0.35, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regime === "compression" ? 1.10 : 0.95,
            evidence: { vr3_20, pressure: integratedFlow, closePos, higherLows, lowerHighs },
            reasons: [
              `Compressão triangular (${biasDir === "CALL" ? "fundos ascendentes" : "topos descendentes"})`,
              `Acúmulo direcional de fluxo (${(integratedFlow * 100).toFixed(0)}%) preparando rompimento`,
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
