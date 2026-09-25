/**
 * reversion-family.js - Família 2: Reversão / Exaustão (4 Subestratégias Autônomas)
 * Oracle Quant Signals
 *
 * Subestratégias:
 * 2A. Statistical Exhaustion: Z-Score contínuo de 20 períodos com desaceleração e queda de fluxo.
 * 2B. Wick Rejection Reversal: Absorção institucional por pavio longo e rejeição de extremo.
 * 2C. Failed Breakout: Rompimento falso de topo/fundo que não sustenta e volta para o range.
 * 2D. Momentum Exhaustion: Deterioração da derivada de retornos (r3 > r2 > r1) com encolhimento de corpo.
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups } from "../pool/opportunity-pool.js";

export class ReversionFamily {
  constructor(config = {}) {
    this.familyId = "REVERSION";
    this.familyName = "Reversão / Exaustão";
    this.correlationGroup = CorrelationGroups.REVERSAL;
    this.lookbackWindow = config.lookbackWindow || 20;
  }

  /**
   * Avalia a série e gera candidatos das 4 subestratégias de Reversão.
   *
   * @param {Object} params
   * @param {Array<Object>} params.candles
   * @param {Object} [params.featureMap={}]
   * @param {Object} [params.microMetrics=null]
   * @param {number} [params.payout=0.80]
   * @param {string} [params.regime="ranging"]
   * @returns {Array<Object>} Lista de OpportunityObjects qualificados
   */
  evaluate({ candles = [], featureMap = {}, microMetrics = null, payout = 0.80, regime = "ranging" }) {
    const n = candles.length;
    if (n < this.lookbackWindow + 2) return [];

    const breakeven = 1 / (1 + payout);
    const opportunities = [];

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    // Variáveis contínuas
    const range0 = Math.max(1e-6, c0.high - c0.low);
    const range1 = Math.max(1e-6, c1.high - c1.low);
    const body0 = Math.abs(c0.close - c0.open);
    const body1 = Math.abs(c1.close - c1.open);

    const closePos = featureMap.closePosition !== undefined ? featureMap.closePosition : (c0.close - c0.low) / range0;
    const upperWick = featureMap.upperWickRatio !== undefined ? featureMap.upperWickRatio : (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick = featureMap.lowerWickRatio !== undefined ? featureMap.lowerWickRatio : (Math.min(c0.open, c0.close) - c0.low) / range0;

    const r1 = featureMap.r1 !== undefined ? featureMap.r1 : Math.log(c0.close / Math.max(1e-6, c1.close));
    const r2 = featureMap.r2 !== undefined ? featureMap.r2 : Math.log(c0.close / Math.max(1e-6, c2.close));
    const r3 = featureMap.r3 || 0;
    const accel = featureMap.priceAcceleration || 0;

    const zScore = featureMap.zScore20 !== undefined ? featureMap.zScore20 : 0;
    const pressure = microMetrics?.pressure || 0;
    const pressureVel = microMetrics?.pressureVelocity || 0;

    const regimeComp = regime === "ranging" || regime === "compression" ? 1.05 : regime === "trend" ? 0.90 : 1.0;

    // =========================================================================
    // 2A — STATISTICAL EXHAUSTION (Z-Score Contínuo + Perda de Inércia)
    // =========================================================================
    {
      const absZ = Math.abs(zScore);
      let statDir = null;
      let statScore = 0;

      // Intensidades contínuas: zStrength, wickStrength, momentumDecay, pressureDecay
      if (zScore > 1.25) {
        const zStrength = clamp((absZ - 1.25) / 1.5, 0.2, 1.0);
        const wickStrength = clamp(upperWick / 0.40, 0, 1.0);
        const momentumDecay = accel < 0 ? 0.20 : 0.05;
        const pressureDecay = pressureVel < 0 || pressure < 0.25 ? 0.20 : 0.05;

        statScore = zStrength * 0.35 + wickStrength * 0.25 + momentumDecay + pressureDecay;
        if (statScore >= 0.52) statDir = "PUT";
      } else if (zScore < -1.25) {
        const zStrength = clamp((absZ - 1.25) / 1.5, 0.2, 1.0);
        const wickStrength = clamp(lowerWick / 0.40, 0, 1.0);
        const momentumDecay = accel > 0 ? 0.20 : 0.05;
        const pressureDecay = pressureVel > 0 || pressure > -0.25 ? 0.20 : 0.05;

        statScore = zStrength * 0.35 + wickStrength * 0.25 + momentumDecay + pressureDecay;
        if (statScore >= 0.52) statDir = "CALL";
      }

      if (statDir) {
        const rawProb = Number(clamp(0.50 + statScore * 0.21, 0.50, 0.72).toFixed(4));
        const uncert = Number(clamp(0.04 - statScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "STATISTICAL_EXHAUSTION",
            correlationGroup: this.correlationGroup,
            direction: statDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.55 + statScore * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { zScore: Number(zScore.toFixed(2)), upperWick, lowerWick },
            reasons: [
              `Exaustão estatística (Z-Score: ${zScore.toFixed(2)})`,
              `Desaceleração e perda de inércia nos extremos`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `STATEXH_${statDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 2B — WICK REJECTION REVERSAL (Absorção e Rejeição no Extremo)
    // =========================================================================
    {
      let wickDir = null;
      let wickScore = 0;

      // Rejeição de Topo (PUT): pavio superior expressivo (>= 38%) e preço recuando para a metade inferior (closePos <= 0.50)
      if (upperWick >= 0.38 && closePos <= 0.50) {
        const magnitude = clamp((upperWick - 0.35) / 0.35, 0.4, 1.2);
        const closePull = clamp((0.60 - closePos) / 0.40, 0.3, 1.0);
        const flowDrop = pressure < 0.15 ? 0.20 : 0.05;
        wickScore = magnitude * 0.40 + closePull * 0.35 + flowDrop;
        if (wickScore >= 0.55) wickDir = "PUT";
      } else if (lowerWick >= 0.38 && closePos >= 0.50) {
        const magnitude = clamp((lowerWick - 0.35) / 0.35, 0.4, 1.2);
        const closePull = clamp((closePos - 0.40) / 0.40, 0.3, 1.0);
        const flowDrop = pressure > -0.15 ? 0.20 : 0.05;
        wickScore = magnitude * 0.40 + closePull * 0.35 + flowDrop;
        if (wickScore >= 0.55) wickDir = "CALL";
      }

      if (wickDir) {
        const rawProb = Number(clamp(0.50 + wickScore * 0.20, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.042 - wickScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "WICK_REJECTION",
            correlationGroup: this.correlationGroup,
            direction: wickDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.54 + wickScore * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { upperWick, lowerWick, closePos },
            reasons: [
              `Pavio de absorção institucional (${((wickDir === "PUT" ? upperWick : lowerWick) * 100).toFixed(0)}%)`,
              `Rejeição de preço e retorno para o range`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `WICKREJ_${wickDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 2C — FAILED BREAKOUT (Rompimento Falso de Topo ou Fundo)
    // =========================================================================
    {
      const prevCandles = candles.slice(Math.max(0, n - 6), n - 1);
      const prevHighMax = Math.max(...prevCandles.map((c) => c.high));
      const prevLowMin = Math.min(...prevCandles.map((c) => c.low));

      let fbDir = null;
      let fbScore = 0;

      // Rompimento falso de alta: c0 fez nova máxima das últimas 5 velas, mas foi rejeitado com pavio >= 32%
      if (c0.high > prevHighMax && c0.close < prevHighMax && upperWick >= 0.32) {
        const penetration = (c0.high - prevHighMax) / range0;
        const returnStrength = (prevHighMax - c0.close) / range0;
        fbScore = 0.30 + clamp(penetration * 2.5, 0.1, 0.35) + clamp(returnStrength * 2.0, 0.1, 0.35);
        if (pressure < 0) fbScore += 0.15;
        if (fbScore >= 0.55) fbDir = "PUT";
      } else if (c0.low < prevLowMin && c0.close > prevLowMin && lowerWick >= 0.32) {
        const penetration = (prevLowMin - c0.low) / range0;
        const returnStrength = (c0.close - prevLowMin) / range0;
        fbScore = 0.30 + clamp(penetration * 2.5, 0.1, 0.35) + clamp(returnStrength * 2.0, 0.1, 0.35);
        if (pressure > 0) fbScore += 0.15;
        if (fbScore >= 0.55) fbDir = "CALL";
      }

      if (fbDir) {
        const rawProb = Number(clamp(0.50 + fbScore * 0.21, 0.50, 0.71).toFixed(4));
        const uncert = Number(clamp(0.04 - fbScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "FAILED_BREAKOUT",
            correlationGroup: this.correlationGroup,
            direction: fbDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.56 + fbScore * 0.36, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { prevHighMax, prevLowMin, close: c0.close },
            reasons: [
              `Falha de rompimento (${fbDir === "PUT" ? "máxima não sustentada" : "mínima não sustentada"})`,
              `Retorno imediato para a consolidação anterior`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `FAILBRK_${fbDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 2D — MOMENTUM EXHAUSTION (Deterioração das Derivadas r3 > r2 > r1)
    // =========================================================================
    {
      let momExhDir = null;
      let exhScore = 0;

      // Exaustão de alta: movimento subindo mas desacelerando (r3 > r2 > r1 > 0 ou r2 > r1 com body encolhendo)
      if (r1 > 0 && r2 > r1 && accel < 0 && body0 < body1 * 0.75) {
        const decayRate = clamp((r2 - r1) / Math.max(1e-4, r2), 0.2, 1.0);
        const shrinkRate = clamp(1 - body0 / body1, 0.2, 0.8);
        exhScore = 0.35 + decayRate * 0.30 + shrinkRate * 0.25 + (pressureVel < 0 ? 0.15 : 0);
        if (exhScore >= 0.50) momExhDir = "PUT";
      } else if (r1 < 0 && r2 < r1 && accel > 0 && body0 < body1 * 0.75) {
        const decayRate = clamp((r1 - r2) / Math.max(1e-4, Math.abs(r2)), 0.2, 1.0);
        const shrinkRate = clamp(1 - body0 / body1, 0.2, 0.8);
        exhScore = 0.35 + decayRate * 0.30 + shrinkRate * 0.25 + (pressureVel > 0 ? 0.15 : 0);
        if (exhScore >= 0.50) momExhDir = "CALL";
      }

      if (momExhDir) {
        const rawProb = Number(clamp(0.50 + exhScore * 0.20, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.043 - exhScore * 0.015, 0.02, 0.05).toFixed(4));
        const consProb = Number((rawProb - 0.67 * uncert).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.015) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "MOMENTUM_EXHAUSTION",
            correlationGroup: this.correlationGroup,
            direction: momExhDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.53 + exhScore * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { r1, r2, accel, bodyRatio0: body0 / range0 },
            reasons: [
              `Exaustão de velocidade (derivada de momentum em queda)`,
              `Encolhimento do corpo da vela (${(body0 / range0 * 100).toFixed(0)}%)`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `MOMEXH_${momExhDir}_${c0.timestamp}`,
          });
        }
      }
    }

    return opportunities;
  }
}
