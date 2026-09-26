/**
 * reversion-family.js - Família 2: Reversão / Exaustão (4 Subestratégias Autônomas Calibradas por ATR e Níveis Estruturais)
 * Oracle Quant Signals — Active Quant Optimizer
 *
 * Subestratégias:
 * 2A. Statistical Exhaustion: Exaustão estatística estrita (|Z| >= 1.85 ou |Z| >= 1.60 em topo/fundo de 15m) com frenagem cinemática.
 * 2B. Wick Rejection Reversal: Absorção institucional em vela relevante (>= 0.85 ATR) varrendo liquidez de topo/fundo com pavio >= 42%.
 * 2C. Failed Breakout: Varredura de liquidez (Stop Hunt) acima/abaixo da máxima/mínima das últimas 15 velas com retorno imediato para dentro do range.
 * 2D. Momentum Exhaustion: Desaceleração real de retornos individuais por vela (u2 >= u1 > u0 em unidades de ATR) com contração de corpo em região esticada.
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups, computeWilsonLowerBound } from "../pool/opportunity-pool.js";

function computeReversionStructure(candles) {
  const n = candles.length;
  const c0 = candles[n - 1];

  // 1. ATR-14 para medir significância real da vela e varredura de liquidez
  const atrPeriod = Math.min(14, n - 1);
  let trSum = 0;
  for (let i = n - atrPeriod; i < n; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trSum += tr;
  }
  const atr14 = Math.max(1e-6, trSum / Math.max(1, atrPeriod));

  // 2. Z-Score de 20 períodos
  const w20 = Math.min(20, n);
  let sum20 = 0;
  for (let i = n - w20; i < n; i++) sum20 += candles[i].close;
  const mean20 = sum20 / w20;
  let varSum = 0;
  for (let i = n - w20; i < n; i++) {
    const d = candles[i].close - mean20;
    varSum += d * d;
  }
  const std20 = Math.max(1e-6, Math.sqrt(varSum / w20));
  const zScore20 = (c0.close - mean20) / std20;

  // 3. Extremos Estruturais de 10 e 15 velas fechadas (excluindo c0)
  const start15 = Math.max(0, n - 16);
  const start10 = Math.max(0, n - 11);
  let swingHigh15 = -Infinity;
  let swingLow15 = Infinity;
  let swingHigh10 = -Infinity;
  let swingLow10 = Infinity;

  for (let i = start15; i < n - 1; i++) {
    if (candles[i].high > swingHigh15) swingHigh15 = candles[i].high;
    if (candles[i].low < swingLow15) swingLow15 = candles[i].low;
    if (i >= start10) {
      if (candles[i].high > swingHigh10) swingHigh10 = candles[i].high;
      if (candles[i].low < swingLow10) swingLow10 = candles[i].low;
    }
  }

  return { atr14, zScore20, swingHigh15, swingLow15, swingHigh10, swingLow10 };
}

export class ReversionFamily {
  constructor(config = {}) {
    this.familyId = "REVERSION";
    this.familyName = "Reversão / Exaustão";
    this.correlationGroup = CorrelationGroups.REVERSAL;
    this.lookbackWindow = config.lookbackWindow || 20;
  }

  /**
   * Avalia a série e gera candidatos das 4 subestratégias de Reversão.
   */
  evaluate({ candles = [], featureMap = {}, microMetrics = null, payout = 0.80, regime = "ranging" }) {
    const n = candles.length;
    if (n < this.lookbackWindow + 2) return [];

    const breakeven = 1 / (1 + payout);
    const opportunities = [];

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    const struct = computeReversionStructure(candles);
    const atr14 = struct.atr14;

    const range0 = Math.max(1e-6, c0.high - c0.low);
    const range1 = Math.max(1e-6, c1.high - c1.low);
    const body0 = Math.abs(c0.close - c0.open);
    const body1 = Math.abs(c1.close - c1.open);
    const rangeToAtr = range0 / atr14;

    const closePos = featureMap.closePosition !== undefined ? featureMap.closePosition : (c0.close - c0.low) / range0;
    const upperWick = featureMap.upperWickRatio !== undefined ? featureMap.upperWickRatio : (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick = featureMap.lowerWickRatio !== undefined ? featureMap.lowerWickRatio : (Math.min(c0.open, c0.close) - c0.low) / range0;

    // Retornos individuais reais por vela em unidades de ATR (corrige o bug algébrico do r2 acumulado)
    const u0 = (c0.close - c0.open) / atr14;
    const u1 = (c1.close - c1.open) / atr14;
    const u2 = (c2.close - c2.open) / atr14;
    const accel = featureMap.priceAcceleration || 0;

    const zScore = featureMap.zScore20 !== undefined ? featureMap.zScore20 : struct.zScore20;
    const pressure = microMetrics?.pressure || 0;
    const integratedFlow = microMetrics?.integratedFlowPressure !== undefined ? microMetrics.integratedFlowPressure : pressure;
    const pressureVel = microMetrics?.pressureVelocity || 0;
    const kinematicRejection = microMetrics?.kinematicRejection || 0;
    const tickPriceAccel = microMetrics?.priceAcceleration || 0;
    const lastTicksDir = microMetrics?.lastTicksDirection || 0;

    const regimeComp = regime === "ranging" || regime === "compression" ? 1.05 : regime === "trend" ? 0.88 : 1.0;

    // =========================================================================
    // 2A — STATISTICAL EXHAUSTION (|Z| >= 1.85 ou |Z| >= 1.60 em Extremo de 15m + Frenagem)
    // =========================================================================
    {
      const absZ = Math.abs(zScore);
      let statDir = null;
      let statScore = 0;

      const atUpperExtreme = zScore >= 1.85 || (zScore >= 1.60 && c0.high >= struct.swingHigh15);
      const atLowerExtreme = zScore <= -1.85 || (zScore <= -1.60 && c0.low <= struct.swingLow15);

      if (atUpperExtreme) {
        const hasRejectionOrBraking =
          upperWick >= 0.28 || kinematicRejection < -0.08 || tickPriceAccel < -0.02 || u0 < u1 * 0.75;

        if (hasRejectionOrBraking) {
          const zStrength = clamp((absZ - 1.55) / 1.25, 0.25, 1.0);
          const wickStrength = clamp(upperWick / 0.42, 0, 1.0);
          const momentumDecay = accel < 0 || tickPriceAccel < 0 || u0 < u1 ? 0.20 : 0.04;
          const pressureDecay = pressureVel < 0 || integratedFlow < 0.20 ? 0.18 : 0.04;
          const kinRejBonus = kinematicRejection < 0 ? Math.abs(kinematicRejection) * 0.16 : 0;

          statScore = zStrength * 0.36 + wickStrength * 0.26 + momentumDecay + pressureDecay + kinRejBonus;
          if (statScore >= 0.60) statDir = "PUT";
        }
      } else if (atLowerExtreme) {
        const hasRejectionOrBraking =
          lowerWick >= 0.28 || kinematicRejection > 0.08 || tickPriceAccel > 0.02 || u0 > u1 * 0.75;

        if (hasRejectionOrBraking) {
          const zStrength = clamp((absZ - 1.55) / 1.25, 0.25, 1.0);
          const wickStrength = clamp(lowerWick / 0.42, 0, 1.0);
          const momentumDecay = accel > 0 || tickPriceAccel > 0 || u0 > u1 ? 0.20 : 0.04;
          const pressureDecay = pressureVel > 0 || integratedFlow > -0.20 ? 0.18 : 0.04;
          const kinRejBonus = kinematicRejection > 0 ? kinematicRejection * 0.16 : 0;

          statScore = zStrength * 0.36 + wickStrength * 0.26 + momentumDecay + pressureDecay + kinRejBonus;
          if (statScore >= 0.60) statDir = "CALL";
        }
      }

      if (statDir) {
        const rawProb = Number(clamp(0.50 + statScore * 0.19, 0.50, 0.705).toFixed(4));
        const uncert = Number(clamp(0.041 - statScore * 0.014, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 42, 102);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.022) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "STATISTICAL_EXHAUSTION",
            correlationGroup: this.correlationGroup,
            direction: statDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.56 + statScore * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { zScore: Number(zScore.toFixed(2)), upperWick, lowerWick, kinematicRejection },
            reasons: [
              `Exaustão estatística severa (Z-Score: ${zScore.toFixed(2)})`,
              `Frenagem terminal e rejeição nos extremos da distribuição`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `STATEXH_${statDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 2B — WICK REJECTION REVERSAL (Absorção Institucional com Amplitude >= 0.85 ATR em Nível Estrutural)
    // =========================================================================
    {
      let wickDir = null;
      let wickScore = 0;

      // Exige que a vela tenha amplitude relevante (>= 0.85 ATR) para não operar dojis de ruído
      const hasSignificantRange = rangeToAtr >= 0.85;
      const atTopZone = c0.high >= struct.swingHigh10 || zScore >= 1.15;
      const atBottomZone = c0.low <= struct.swingLow10 || zScore <= -1.15;

      if (hasSignificantRange && atTopZone && upperWick >= 0.42 && closePos <= 0.45 && lastTicksDir <= 0) {
        const magnitude = clamp((upperWick - 0.38) / 0.32, 0.4, 1.15);
        const closePull = clamp((0.55 - closePos) / 0.40, 0.3, 1.0);
        const flowDrop = integratedFlow < 0.10 || kinematicRejection < 0 ? 0.22 : 0.06;
        wickScore = magnitude * 0.42 + closePull * 0.34 + flowDrop;
        if (wickScore >= 0.62) wickDir = "PUT";
      } else if (hasSignificantRange && atBottomZone && lowerWick >= 0.42 && closePos >= 0.55 && lastTicksDir >= 0) {
        const magnitude = clamp((lowerWick - 0.38) / 0.32, 0.4, 1.15);
        const closePull = clamp((closePos - 0.45) / 0.40, 0.3, 1.0);
        const flowDrop = integratedFlow > -0.10 || kinematicRejection > 0 ? 0.22 : 0.06;
        wickScore = magnitude * 0.42 + closePull * 0.34 + flowDrop;
        if (wickScore >= 0.62) wickDir = "CALL";
      }

      if (wickDir) {
        const rawProb = Number(clamp(0.50 + wickScore * 0.185, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.042 - wickScore * 0.014, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 42, 100);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.022) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "WICK_REJECTION",
            correlationGroup: this.correlationGroup,
            direction: wickDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.56 + wickScore * 0.36, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { upperWick, lowerWick, closePos, rangeToAtr: Number(rangeToAtr.toFixed(2)) },
            reasons: [
              `Pavio de absorção institucional (${((wickDir === "PUT" ? upperWick : lowerWick) * 100).toFixed(0)}%) em vela de ${rangeToAtr.toFixed(1)}x ATR`,
              `Rejeição confirmada em extremo estrutural`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `WICKREJ_${wickDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 2C — FAILED BREAKOUT (Liquidity Sweep / Stop Hunt sobre Máxima/Mínima de 15 Velas)
    // =========================================================================
    {
      const prevHighMax = struct.swingHigh15;
      const prevLowMin = struct.swingLow15;

      let fbDir = null;
      let fbScore = 0;

      // Rompimento falso de topo: varreu liquidez acima de swingHigh15 e fechou de volta abaixo com pavio >= 36%
      if (
        rangeToAtr >= 0.80 &&
        c0.high > prevHighMax + 0.05 * atr14 &&
        c0.close < prevHighMax - 0.03 * atr14 &&
        upperWick >= 0.36 &&
        closePos <= 0.48
      ) {
        const penetration = (c0.high - prevHighMax) / range0;
        const returnStrength = (prevHighMax - c0.close) / range0;
        fbScore = 0.34 + clamp(penetration * 2.2, 0.10, 0.32) + clamp(returnStrength * 2.0, 0.10, 0.32);
        if (integratedFlow < 0 || kinematicRejection < 0) fbScore += 0.14;
        if (fbScore >= 0.62) fbDir = "PUT";
      } else if (
        rangeToAtr >= 0.80 &&
        c0.low < prevLowMin - 0.05 * atr14 &&
        c0.close > prevLowMin + 0.03 * atr14 &&
        lowerWick >= 0.36 &&
        closePos >= 0.52
      ) {
        const penetration = (prevLowMin - c0.low) / range0;
        const returnStrength = (c0.close - prevLowMin) / range0;
        fbScore = 0.34 + clamp(penetration * 2.2, 0.10, 0.32) + clamp(returnStrength * 2.0, 0.10, 0.32);
        if (integratedFlow > 0 || kinematicRejection > 0) fbScore += 0.14;
        if (fbScore >= 0.62) fbDir = "CALL";
      }

      if (fbDir) {
        const rawProb = Number(clamp(0.50 + fbScore * 0.19, 0.50, 0.705).toFixed(4));
        const uncert = Number(clamp(0.041 - fbScore * 0.014, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 42, 100);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.022) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "FAILED_BREAKOUT",
            correlationGroup: this.correlationGroup,
            direction: fbDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.57 + fbScore * 0.35, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { prevHighMax, prevLowMin, close: c0.close, rangeToAtr: Number(rangeToAtr.toFixed(2)) },
            reasons: [
              `Stop Hunt / Falha de rompimento no extremo de 15 velas (${fbDir === "PUT" ? "topo" : "fundo"} varrido)`,
              `Rejeição imediata de volta para dentro da estrutura`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `FAILBRK_${fbDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 2D — MOMENTUM EXHAUSTION (Desaceleração Real de Retornos Individuais u2, u1, u0 em ATR)
    // =========================================================================
    {
      let momExhDir = null;
      let exhScore = 0;

      // Exaustão de Alta: impulso prévio forte (u1 > 0 e u1 + max(0, u2) >= 1.20 ATR), vela atual c0 perde força drasticamente (0 <= u0 <= 0.55 * u1) em zona esticada (zScore >= 1.30) com pavio superior
      const priorBullThrust = u1 > 0.45 && u1 + Math.max(0, u2) >= 1.20;
      const priorBearThrust = u1 < -0.45 && Math.abs(u1) + Math.max(0, -u2) >= 1.20;

      if (
        priorBullThrust &&
        zScore >= 1.30 &&
        u0 <= u1 * 0.55 &&
        body0 < body1 * 0.68 &&
        upperWick >= 0.25 &&
        (pressureVel < 0 || kinematicRejection < 0 || accel < 0)
      ) {
        const decayRate = clamp((u1 - Math.max(0, u0)) / Math.max(0.1, u1), 0.30, 1.0);
        const shrinkRate = clamp(1 - body0 / Math.max(1e-6, body1), 0.30, 0.85);
        exhScore = 0.36 + decayRate * 0.28 + shrinkRate * 0.24 + (pressureVel < 0 || kinematicRejection < 0 ? 0.14 : 0);
        if (exhScore >= 0.62) momExhDir = "PUT";
      } else if (
        priorBearThrust &&
        zScore <= -1.30 &&
        Math.abs(u0) <= Math.abs(u1) * 0.55 &&
        body0 < body1 * 0.68 &&
        lowerWick >= 0.25 &&
        (pressureVel > 0 || kinematicRejection > 0 || accel > 0)
      ) {
        const decayRate = clamp((Math.abs(u1) - Math.max(0, -u0)) / Math.max(0.1, Math.abs(u1)), 0.30, 1.0);
        const shrinkRate = clamp(1 - body0 / Math.max(1e-6, body1), 0.30, 0.85);
        exhScore = 0.36 + decayRate * 0.28 + shrinkRate * 0.24 + (pressureVel > 0 || kinematicRejection > 0 ? 0.14 : 0);
        if (exhScore >= 0.62) momExhDir = "CALL";
      }

      if (momExhDir) {
        const rawProb = Number(clamp(0.50 + exhScore * 0.185, 0.50, 0.695).toFixed(4));
        const uncert = Number(clamp(0.043 - exhScore * 0.014, 0.023, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 40, 96);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.020) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "MOMENTUM_EXHAUSTION",
            correlationGroup: this.correlationGroup,
            direction: momExhDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.55 + exhScore * 0.36, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: {
              u0: Number(u0.toFixed(2)),
              u1: Number(u1.toFixed(2)),
              u2: Number(u2.toFixed(2)),
              zScore: Number(zScore.toFixed(2)),
            },
            reasons: [
              `Exaustão real de deslocamento em ATR (u1=${u1.toFixed(2)} → u0=${u0.toFixed(2)})`,
              `Contração abrupta de corpo (${((body0 / Math.max(1e-6, body1)) * 100).toFixed(0)}%) em zona esticada`,
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
