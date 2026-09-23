/**
 * continuation-family.js - Família 1: Continuação / Momentum (4 Subestratégias Autônomas)
 * Oracle Quant Signals
 *
 * Subestratégias:
 * 1A. Impulse Continuation: Deslocamento forte, limpo e acelerando.
 * 1B. Persistent Momentum: Eficiência direcional estável sem rejeição contrária.
 * 1C. Pullback Continuation: Retração curta com volume decrescente e retomada da pressão.
 * 1D. Late Acceleration: Aceleração nos últimos ticks da M1 independentemente do range prévio.
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups } from "../pool/opportunity-pool.js";

export class ContinuationFamily {
  constructor(config = {}) {
    this.familyId = "CONTINUATION";
    this.familyName = "Continuação / Momentum";
    this.correlationGroup = CorrelationGroups.MOMENTUM;
    this.minWarmingCandles = config.minWarmingCandles || 8;
  }

  /**
   * Avalia os dados e gera candidatos independentes das 4 subestratégias de Continuação.
   *
   * @param {Object} params
   * @param {Array<Object>} params.candles
   * @param {Object} [params.featureMap={}]
   * @param {Object} [params.microMetrics=null]
   * @param {number} [params.payout=0.80]
   * @param {string} [params.regime="trend"]
   * @returns {Array<Object>} Lista de OpportunityObjects qualificados
   */
  evaluate({ candles = [], featureMap = {}, microMetrics = null, payout = 0.80, regime = "trend" }) {
    const n = candles.length;
    if (n < this.minWarmingCandles) return [];

    const breakeven = 1 / (1 + payout);
    const opportunities = [];

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    // Variáveis contínuas normalizadas
    const r1 = featureMap.r1 !== undefined ? featureMap.r1 : Math.log(c0.close / Math.max(1e-6, c1.close));
    const r2 = featureMap.r2 !== undefined ? featureMap.r2 : Math.log(c0.close / Math.max(1e-6, c2.close));
    const r3 = featureMap.r3 || 0;
    const accel = featureMap.priceAcceleration || 0;
    const range0 = Math.max(1e-6, c0.high - c0.low);
    const range1 = Math.max(1e-6, c1.high - c1.low);
    const rangeRatio = range0 / range1;
    const closePos = featureMap.closePosition !== undefined ? featureMap.closePosition : (c0.close - c0.low) / range0;
    const upperWick = featureMap.upperWickRatio !== undefined ? featureMap.upperWickRatio : (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick = featureMap.lowerWickRatio !== undefined ? featureMap.lowerWickRatio : (Math.min(c0.open, c0.close) - c0.low) / range0;
    const dirEfficiency = featureMap.directionalEfficiency || clamp(Math.abs(c0.close - c2.open) / (range0 + range1 + 1e-6), 0, 1);

    const pressure = microMetrics?.pressure || 0;
    const pressureVel = microMetrics?.pressureVelocity || 0;
    const pressureAccel = microMetrics?.pressureAcceleration || 0;
    const lastTicksDir = microMetrics?.lastTicksDirection || 0;

    const regimeComp = regime === "trend" || regime === "expansion" ? 1.05 : regime === "compression" ? 0.85 : 0.95;

    // =========================================================================
    // 1A — IMPULSE CONTINUATION
    // =========================================================================
    {
      let bullScore = 0;
      let bearScore = 0;
      const bullEv = {};
      const bearEv = {};

      if (r1 > 0) {
        bullScore += 0.20;
        const posFactor = clamp((closePos - 0.50) / 0.50, 0, 1);
        bullScore += 0.25 * posFactor;
        const wickFactor = clamp(1 - upperWick / 0.35, 0, 1);
        bullScore += 0.15 * wickFactor;
        const rangeFactor = clamp((rangeRatio - 0.85) / 0.40, 0, 1);
        bullScore += 0.15 * rangeFactor;
        if (accel >= 0) bullScore += 0.10;
        if (pressure > 0.08) bullScore += 0.15 * clamp(pressure / 0.50, 0, 1);

        bullEv.r1 = r1;
        bullEv.closePos = closePos;
        bullEv.pressure = pressure;
      } else if (r1 < 0) {
        bearScore += 0.20;
        const posFactor = clamp((0.50 - closePos) / 0.50, 0, 1);
        bearScore += 0.25 * posFactor;
        const wickFactor = clamp(1 - lowerWick / 0.35, 0, 1);
        bearScore += 0.15 * wickFactor;
        const rangeFactor = clamp((rangeRatio - 0.85) / 0.40, 0, 1);
        bearScore += 0.15 * rangeFactor;
        if (accel <= 0) bearScore += 0.10;
        if (pressure < -0.08) bearScore += 0.15 * clamp(-pressure / 0.50, 0, 1);

        bearEv.r1 = r1;
        bearEv.closePos = closePos;
        bearEv.pressure = pressure;
      }

      const impulseDir = bullScore >= 0.50 && bullScore > bearScore ? "CALL" : bearScore >= 0.50 ? "PUT" : null;
      if (impulseDir) {
        const score = impulseDir === "CALL" ? bullScore : bearScore;
        const rawProb = Number(clamp(0.50 + score * 0.20, 0.50, 0.72).toFixed(4));
        const uncert = Number(clamp(0.04 - score * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "IMPULSE_CONTINUATION",
            correlationGroup: this.correlationGroup,
            direction: impulseDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.55 + score * 0.40, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: impulseDir === "CALL" ? bullEv : bearEv,
            reasons: [
              `Impulso M1 limpo (${impulseDir === "CALL" ? "alta" : "baixa"})`,
              `Fechamento extremo (${(closePos * 100).toFixed(0)}%)`,
              `Pressão intraminuto (${(pressure * 100).toFixed(0)}%)`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `IMPULSE_${impulseDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 1B — PERSISTENT MOMENTUM (Eficiência Direcional e Closes Progressivos)
    // =========================================================================
    {
      const upCloses = (c0.close > c1.close ? 1 : 0) + (c1.close > c2.close ? 1 : 0);
      const downCloses = (c0.close < c1.close ? 1 : 0) + (c1.close < c2.close ? 1 : 0);

      let pScoreBull = 0;
      let pScoreBear = 0;

      if (upCloses >= 2 && dirEfficiency >= 0.48 && upperWick <= 0.35) {
        pScoreBull = 0.30 + dirEfficiency * 0.35 + (r2 > 0 ? 0.15 : 0) + (pressure > 0 ? 0.20 : 0);
      } else if (downCloses >= 2 && dirEfficiency >= 0.48 && lowerWick <= 0.35) {
        pScoreBear = 0.30 + dirEfficiency * 0.35 + (r2 < 0 ? 0.15 : 0) + (pressure < 0 ? 0.20 : 0);
      }

      const pDir = pScoreBull >= 0.52 ? "CALL" : pScoreBear >= 0.52 ? "PUT" : null;
      if (pDir) {
        const score = pDir === "CALL" ? pScoreBull : pScoreBear;
        const rawProb = Number(clamp(0.50 + score * 0.19, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.038 - score * 0.012, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PERSISTENT_MOMENTUM",
            correlationGroup: this.correlationGroup,
            direction: pDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.52 + dirEfficiency * 0.40, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { dirEfficiency, upCloses, downCloses },
            reasons: [
              `Momentum persistente (eficiência: ${(dirEfficiency * 100).toFixed(0)}%)`,
              `Sequência de closes progressivos`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `PERSISTENT_${pDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 1C — PULLBACK CONTINUATION (Retomada após pequena retração)
    // =========================================================================
    {
      const prevImpulseUp = (c1.close - c2.open) > 0 && Math.log(c1.close / Math.max(1e-6, c2.open)) > 0.0003;
      const prevImpulseDown = (c1.close - c2.open) < 0 && Math.log(c1.close / Math.max(1e-6, c2.open)) < -0.0003;

      let pullbackDir = null;
      let pbScore = 0;
      const pbReasons = [];

      // Pullback de alta: vela c1 subiu forte, c0 fez retração com range contido e pressão compradora retoma
      if (prevImpulseUp && c0.close <= c1.high && range0 <= range1 * 0.90) {
        if (pressure > 0.05 || pressureVel > 0 || closePos >= 0.45) {
          pullbackDir = "CALL";
          pbScore = 0.35 + (1 - range0 / range1) * 0.25 + clamp(pressure / 0.5, 0, 0.25) + (closePos >= 0.5 ? 0.15 : 0);
          pbReasons.push("Impulso prévio de alta com retração de menor amplitude");
          pbReasons.push(`Pressão compradora retornando (+${(pressure * 100).toFixed(0)}%)`);
        }
      } else if (prevImpulseDown && c0.close >= c1.low && range0 <= range1 * 0.90) {
        if (pressure < -0.05 || pressureVel < 0 || closePos <= 0.55) {
          pullbackDir = "PUT";
          pbScore = 0.35 + (1 - range0 / range1) * 0.25 + clamp(-pressure / 0.5, 0, 0.25) + (closePos <= 0.5 ? 0.15 : 0);
          pbReasons.push("Impulso prévio de baixa com retração de menor amplitude");
          pbReasons.push(`Pressão vendedora retornando (${(pressure * 100).toFixed(0)}%)`);
        }
      }

      if (pullbackDir && pbScore >= 0.50) {
        const rawProb = Number(clamp(0.50 + pbScore * 0.21, 0.50, 0.71).toFixed(4));
        const uncert = Number(clamp(0.042 - pbScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PULLBACK_CONTINUATION",
            correlationGroup: this.correlationGroup,
            direction: pullbackDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.55 + pbScore * 0.35, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { rangeRatio, pressure, pressureVel },
            reasons: pbReasons,
            timestamp: c0.timestamp,
            fingerprint: `PULLBACK_${pullbackDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 1D — LATE ACCELERATION (Aceleração nos últimos ticks da M1)
    // =========================================================================
    {
      let lateDir = null;
      let lateScore = 0;

      // Dispara se a aceleração dos ticks explodir no final
      if (lastTicksDir > 0 && pressureAccel > 0.08 && pressureVel > 0.10 && closePos >= 0.55) {
        lateDir = "CALL";
        lateScore = 0.40 + clamp(pressureAccel * 2.0, 0, 0.30) + clamp(pressureVel * 1.5, 0, 0.30);
      } else if (lastTicksDir < 0 && pressureAccel < -0.08 && pressureVel < -0.10 && closePos <= 0.45) {
        lateDir = "PUT";
        lateScore = 0.40 + clamp(-pressureAccel * 2.0, 0, 0.30) + clamp(-pressureVel * 1.5, 0, 0.30);
      }

      if (lateDir && lateScore >= 0.52) {
        const rawProb = Number(clamp(0.50 + lateScore * 0.20, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.045 - lateScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "LATE_ACCELERATION",
            correlationGroup: this.correlationGroup,
            direction: lateDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.50 + lateScore * 0.40, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { pressureAccel, pressureVel, lastTicksDir },
            reasons: [
              `Aceleração tardia de ticks (+${(pressureAccel * 100).toFixed(0)}%)`,
              `Impulso no fechamento do candle M1`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `LATEACC_${lateDir}_${c0.timestamp}`,
          });
        }
      }
    }

    return opportunities;
  }
}
