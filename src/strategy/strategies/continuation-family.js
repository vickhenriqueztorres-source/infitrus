/**
 * continuation-family.js - Família 1: Continuação / Momentum (4 Subestratégias Autônomas Calibradas por ATR e Estrutura)
 * Oracle Quant Signals — Active Quant Optimizer
 *
 * Subestratégias:
 * 1A. Impulse Continuation: Deslocamento limpo normalizado por ATR (0.80x–2.15x), com trava anti-exaustão (|Z| < 1.85) e sem rejeição em topo/fundo estrutural.
 * 1B. Persistent Momentum: 2 a 3 fechamentos progressivos alinhados à EMA9/EMA20, bloqueando a 4ª+ vela consecutiva de exaustão em OTC.
 * 1C. Pullback Continuation: Impulso prévio >= 0.85 ATR seguido de teste da zona de retração (Fibonacci 30%–70%) com absorção no pavio e retomada de fluxo.
 * 1D. Late Acceleration: Ignição terminal nos últimos ticks (v > 0, a > 0) estritamente alinhada à estrutura gráfica e longe de sobrecompra/sobrevenda.
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups, computeWilsonLowerBound } from "../pool/opportunity-pool.js";

function computeStructuralContext(candles) {
  const n = candles.length;
  const c0 = candles[n - 1];

  // 1. ATR-14 (Average True Range) para invariância de escala entre qualquer par/OTC
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

  // 2. EMA-9 e EMA-20 + Z-Score de 20 períodos
  const w20 = Math.min(20, n);
  let sum20 = 0;
  let ema9 = candles[n - w20].close;
  let ema20 = candles[n - w20].close;
  const k9 = 2 / 10;
  const k20 = 2 / 21;

  for (let i = n - w20; i < n; i++) {
    const cl = candles[i].close;
    sum20 += cl;
    ema9 = (cl - ema9) * k9 + ema9;
    ema20 = (cl - ema20) * k20 + ema20;
  }
  const mean20 = sum20 / w20;
  let varSum = 0;
  for (let i = n - w20; i < n; i++) {
    const diff = candles[i].close - mean20;
    varSum += diff * diff;
  }
  const std20 = Math.max(1e-6, Math.sqrt(varSum / w20));
  const zScore20 = (c0.close - mean20) / std20;

  // 3. Topo e Fundo Estrutural das últimas 15 velas fechadas (excluindo c0)
  const lookbackStart = Math.max(0, n - 16);
  let swingHigh15 = -Infinity;
  let swingLow15 = Infinity;
  for (let i = lookbackStart; i < n - 1; i++) {
    if (candles[i].high > swingHigh15) swingHigh15 = candles[i].high;
    if (candles[i].low < swingLow15) swingLow15 = candles[i].low;
  }

  // 4. Contagem de velas consecutivas da mesma direção (trava contra 4ª+ vela de exaustão em OTC)
  let consecutiveUp = 0;
  let consecutiveDown = 0;
  for (let i = n - 1; i >= Math.max(0, n - 6); i--) {
    if (candles[i].close > candles[i].open) {
      if (consecutiveDown > 0) break;
      consecutiveUp++;
    } else if (candles[i].close < candles[i].open) {
      if (consecutiveUp > 0) break;
      consecutiveDown++;
    } else {
      break;
    }
  }

  return { atr14, ema9, ema20, zScore20, swingHigh15, swingLow15, consecutiveUp, consecutiveDown };
}

export class ContinuationFamily {
  constructor(config = {}) {
    this.familyId = "CONTINUATION";
    this.familyName = "Continuação / Momentum";
    this.correlationGroup = CorrelationGroups.MOMENTUM;
    this.minWarmingCandles = config.minWarmingCandles || 8;
  }

  /**
   * Avalia os dados e gera candidatos independentes das 4 subestratégias de Continuação.
   */
  evaluate({ candles = [], featureMap = {}, microMetrics = null, payout = 0.80, regime = "trend" }) {
    const n = candles.length;
    if (n < this.minWarmingCandles) return [];

    const breakeven = 1 / (1 + payout);
    const opportunities = [];

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    const struct = computeStructuralContext(candles);
    const atr14 = struct.atr14;
    const zScore = featureMap.zScore20 !== undefined ? featureMap.zScore20 : struct.zScore20;

    // Variáveis contínuas normalizadas por ATR e amplitude
    const r1 = featureMap.r1 !== undefined ? featureMap.r1 : Math.log(c0.close / Math.max(1e-6, c1.close));
    const r2 = featureMap.r2 !== undefined ? featureMap.r2 : Math.log(c0.close / Math.max(1e-6, c2.close));
    const accel = featureMap.priceAcceleration || 0;
    const range0 = Math.max(1e-6, c0.high - c0.low);
    const range1 = Math.max(1e-6, c1.high - c1.low);
    const body0 = Math.abs(c0.close - c0.open);
    const body1 = Math.abs(c1.close - c1.open);
    const rangeRatio = range0 / range1;
    const rangeToAtr = range0 / atr14;

    const closePos = featureMap.closePosition !== undefined ? featureMap.closePosition : (c0.close - c0.low) / range0;
    const upperWick = featureMap.upperWickRatio !== undefined ? featureMap.upperWickRatio : (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick = featureMap.lowerWickRatio !== undefined ? featureMap.lowerWickRatio : (Math.min(c0.open, c0.close) - c0.low) / range0;
    const bodyRatio = featureMap.bodyRatio !== undefined ? featureMap.bodyRatio : body0 / range0;
    const dirEfficiency = featureMap.directionalEfficiency || clamp(Math.abs(c0.close - c2.open) / (range0 + range1 + 1e-6), 0, 1);

    const pressure = microMetrics?.pressure || 0;
    const integratedFlow = microMetrics?.integratedFlowPressure !== undefined ? microMetrics.integratedFlowPressure : pressure;
    const pressureVel = microMetrics?.pressureVelocity || 0;
    const pressureAccel = microMetrics?.pressureAcceleration || 0;
    const kinematicConvergence = microMetrics?.kinematicConvergence || 0;
    const kinematicRejection = microMetrics?.kinematicRejection || 0;
    const lastTicksDir = microMetrics?.lastTicksDirection || 0;

    const regimeComp = regime === "trend" || regime === "expansion" ? 1.05 : regime === "compression" ? 0.85 : 0.95;

    // Trava estrutural de barreira: verifica se c0 bateu na máxima/mínima de 15 velas e falhou em romper
    const rejectedAtSwingHigh = c0.high >= struct.swingHigh15 && c0.close < struct.swingHigh15 - 0.10 * range0;
    const rejectedAtSwingLow = c0.low <= struct.swingLow15 && c0.close > struct.swingLow15 + 0.10 * range0;

    // =========================================================================
    // 1A — IMPULSE CONTINUATION (Impulso Limpo Normalizado por ATR + Anti-Exaustão)
    // =========================================================================
    {
      let bullScore = 0;
      let bearScore = 0;
      const bullEv = {};
      const bearEv = {};

      // Proíbe comprar topo esticado (zScore >= 1.85 ou clímax > 2.20 ATR ou rejeição em topo de 15m)
      const bullNotExhausted = zScore < 1.85 && rangeToAtr >= 0.75 && rangeToAtr <= 2.20 && !rejectedAtSwingHigh;
      const bearNotExhausted = zScore > -1.85 && rangeToAtr >= 0.75 && rangeToAtr <= 2.20 && !rejectedAtSwingLow;

      if (r1 > 0 && c0.close > c0.open && bullNotExhausted && kinematicRejection >= -0.25) {
        bullScore += 0.22;
        const posFactor = clamp((closePos - 0.60) / 0.40, 0, 1);
        bullScore += 0.25 * posFactor;
        const wickFactor = clamp(1 - upperWick / 0.25, 0, 1);
        bullScore += 0.16 * wickFactor;
        const atrFactor = clamp((rangeToAtr - 0.75) / 0.85, 0, 1);
        bullScore += 0.15 * atrFactor;
        if (accel >= 0) bullScore += 0.08;
        if (struct.ema9 >= struct.ema20) bullScore += 0.06;
        if (integratedFlow > 0.10) bullScore += 0.14 * clamp(integratedFlow / 0.50, 0, 1);
        if (kinematicConvergence > 0) bullScore += 0.08 * kinematicConvergence;

        bullEv.r1 = r1;
        bullEv.closePos = closePos;
        bullEv.rangeToAtr = Number(rangeToAtr.toFixed(2));
        bullEv.pressure = integratedFlow;
      } else if (r1 < 0 && c0.close < c0.open && bearNotExhausted && kinematicRejection <= 0.25) {
        bearScore += 0.22;
        const posFactor = clamp((0.40 - closePos) / 0.40, 0, 1);
        bearScore += 0.25 * posFactor;
        const wickFactor = clamp(1 - lowerWick / 0.25, 0, 1);
        bearScore += 0.16 * wickFactor;
        const atrFactor = clamp((rangeToAtr - 0.75) / 0.85, 0, 1);
        bearScore += 0.15 * atrFactor;
        if (accel <= 0) bearScore += 0.08;
        if (struct.ema9 <= struct.ema20) bearScore += 0.06;
        if (integratedFlow < -0.10) bearScore += 0.14 * clamp(-integratedFlow / 0.50, 0, 1);
        if (kinematicConvergence < 0) bearScore += 0.08 * Math.abs(kinematicConvergence);

        bearEv.r1 = r1;
        bearEv.closePos = closePos;
        bearEv.rangeToAtr = Number(rangeToAtr.toFixed(2));
        bearEv.pressure = integratedFlow;
      }

      const impulseDir =
        bullScore >= 0.72 && dirEfficiency >= 0.60 && bodyRatio >= 0.58 && bullScore > bearScore
          ? "CALL"
          : bearScore >= 0.72 && dirEfficiency >= 0.60 && bodyRatio >= 0.58
          ? "PUT"
          : null;

      if (impulseDir) {
        const score = impulseDir === "CALL" ? bullScore : bearScore;
        const rawProb = Number(clamp(0.50 + score * 0.185, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.042 - score * 0.014, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 42, 105);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "IMPULSE_CONTINUATION",
            correlationGroup: this.correlationGroup,
            direction: impulseDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.56 + score * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: impulseDir === "CALL" ? bullEv : bearEv,
            reasons: [
              `Impulso M1 calibrado (${rangeToAtr.toFixed(1)}x ATR, sem exaustão Z=${zScore.toFixed(2)})`,
              `Fechamento firme no extremo (${(closePos * 100).toFixed(0)}%) com pavio oposto mínimo`,
              `Fluxo integrado favorável (${(integratedFlow * 100).toFixed(0)}%)`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `IMPULSE_${impulseDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 1B — PERSISTENT MOMENTUM (2–3 Velas Alinhadas à EMA, Bloqueando 4ª+ Vela de Exaustão)
    // =========================================================================
    {
      const upCloses = (c0.close > c1.close ? 1 : 0) + (c1.close > c2.close ? 1 : 0);
      const downCloses = (c0.close < c1.close ? 1 : 0) + (c1.close < c2.close ? 1 : 0);

      let pScoreBull = 0;
      let pScoreBear = 0;

      // Bloqueia se já houver >= 4 velas seguidas da mesma cor (exaustão clássica de M1 OTC) ou |Z| >= 1.75
      const validBullSeq = upCloses >= 2 && struct.consecutiveUp <= 3 && zScore < 1.75 && !rejectedAtSwingHigh;
      const validBearSeq = downCloses >= 2 && struct.consecutiveDown <= 3 && zScore > -1.75 && !rejectedAtSwingLow;

      if (
        validBullSeq &&
        dirEfficiency >= 0.62 &&
        upperWick <= 0.24 &&
        body0 >= body1 * 0.72 &&
        struct.ema9 >= struct.ema20 * 0.9998 &&
        kinematicRejection >= -0.20
      ) {
        pScoreBull =
          0.32 +
          dirEfficiency * 0.34 +
          (r2 > 0 ? 0.14 : 0) +
          (integratedFlow > 0.12 ? 0.18 : 0) +
          (body0 >= body1 ? 0.08 : 0);
      } else if (
        validBearSeq &&
        dirEfficiency >= 0.62 &&
        lowerWick <= 0.24 &&
        body0 >= body1 * 0.72 &&
        struct.ema9 <= struct.ema20 * 1.0002 &&
        kinematicRejection <= 0.20
      ) {
        pScoreBear =
          0.32 +
          dirEfficiency * 0.34 +
          (r2 < 0 ? 0.14 : 0) +
          (integratedFlow < -0.12 ? 0.18 : 0) +
          (body0 >= body1 ? 0.08 : 0);
      }

      const pDir = pScoreBull >= 0.68 ? "CALL" : pScoreBear >= 0.68 ? "PUT" : null;
      if (pDir) {
        const score = pDir === "CALL" ? pScoreBull : pScoreBear;
        const rawProb = Number(clamp(0.50 + score * 0.18, 0.50, 0.695).toFixed(4));
        const uncert = Number(clamp(0.040 - score * 0.013, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 42, 100);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PERSISTENT_MOMENTUM",
            correlationGroup: this.correlationGroup,
            direction: pDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.54 + dirEfficiency * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: regimeComp,
            evidence: { dirEfficiency, upCloses, downCloses, zScore: Number(zScore.toFixed(2)) },
            reasons: [
              `Momentum persistente alinhado à EMA9/20 (eficiência: ${(dirEfficiency * 100).toFixed(0)}%)`,
              `Corpos sustentados sem sinal de clímax (${pDir === "CALL" ? struct.consecutiveUp : struct.consecutiveDown}ª vela)`,
            ],
            timestamp: c0.timestamp,
            fingerprint: `PERSISTENT_${pDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 1C — PULLBACK CONTINUATION (Retração Fibonacci em ATR com Rejeição a Favor da Tendência)
    // =========================================================================
    {
      const impulseMove = c1.close - c2.open;
      const impulseAtr = impulseMove / atr14;

      let pullbackDir = null;
      let pbScore = 0;
      const pbReasons = [];

      // Pullback de Alta: impulso prévio >= 0.85 ATR em tendência de alta, c0 testa a zona de retração deixando pavio inferior e retoma alta
      if (
        impulseAtr >= 0.85 &&
        struct.ema9 >= struct.ema20 * 0.9995 &&
        zScore < 1.65 &&
        c0.low < c1.close &&
        c0.low >= c2.open + 0.25 * impulseMove &&
        range0 <= range1 * 0.92
      ) {
        const testedAndRejected = lowerWick >= 0.26 && closePos >= 0.52;
        const flowResuming = integratedFlow > 0.08 || pressureVel > 0.04 || kinematicRejection > 0.05;

        if (testedAndRejected && flowResuming) {
          pullbackDir = "CALL";
          pbScore =
            0.38 +
            clamp((1 - range0 / range1) * 0.22, 0.05, 0.22) +
            clamp(lowerWick * 0.35, 0.08, 0.20) +
            clamp(integratedFlow * 0.35, 0.04, 0.20);
          pbReasons.push(`Pullback saudável na zona de valor após impulso de +${impulseAtr.toFixed(1)} ATR`);
          pbReasons.push(`Absorção compradora no pavio inferior (${(lowerWick * 100).toFixed(0)}%) e retomada de fluxo`);
        }
      } else if (
        impulseAtr <= -0.85 &&
        struct.ema9 <= struct.ema20 * 1.0005 &&
        zScore > -1.65 &&
        c0.high > c1.close &&
        c0.high <= c2.open + 0.25 * impulseMove &&
        range0 <= range1 * 0.92
      ) {
        const testedAndRejected = upperWick >= 0.26 && closePos <= 0.48;
        const flowResuming = integratedFlow < -0.08 || pressureVel < -0.04 || kinematicRejection < -0.05;

        if (testedAndRejected && flowResuming) {
          pullbackDir = "PUT";
          pbScore =
            0.38 +
            clamp((1 - range0 / range1) * 0.22, 0.05, 0.22) +
            clamp(upperWick * 0.35, 0.08, 0.20) +
            clamp(-integratedFlow * 0.35, 0.04, 0.20);
          pbReasons.push(`Pullback saudável na zona de valor após impulso de ${impulseAtr.toFixed(1)} ATR`);
          pbReasons.push(`Absorção vendedora no pavio superior (${(upperWick * 100).toFixed(0)}%) e retomada de fluxo`);
        }
      }

      if (pullbackDir && pbScore >= 0.62) {
        const rawProb = Number(clamp(0.50 + pbScore * 0.19, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.042 - pbScore * 0.014, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 40, 98);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.020) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PULLBACK_CONTINUATION",
            correlationGroup: this.correlationGroup,
            direction: pullbackDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.56 + pbScore * 0.35, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { impulseAtr: Number(impulseAtr.toFixed(2)), rangeRatio, pressure: integratedFlow, pressureVel },
            reasons: pbReasons,
            timestamp: c0.timestamp,
            fingerprint: `PULLBACK_${pullbackDir}_${c0.timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 1D — LATE ACCELERATION (Ignição Terminal nos Ticks Alinhada à Estrutura)
    // =========================================================================
    {
      let lateDir = null;
      let lateScore = 0;

      // Exige alinhamento com a estrutura gráfica (corpo a favor, sem rejeição de topo/fundo e |Z| < 1.80)
      if (
        lastTicksDir > 0 &&
        c0.close > c0.open &&
        c0.close >= struct.ema20 * 0.9995 &&
        zScore < 1.80 &&
        !rejectedAtSwingHigh &&
        pressureAccel > 0.10 &&
        pressureVel > 0.12 &&
        closePos >= 0.66 &&
        upperWick <= 0.22 &&
        kinematicRejection >= -0.10
      ) {
        lateDir = "CALL";
        lateScore =
          0.42 +
          clamp(pressureAccel * 1.8, 0, 0.25) +
          clamp(pressureVel * 1.4, 0, 0.22) +
          clamp(kinematicConvergence * 0.15, 0, 0.12);
      } else if (
        lastTicksDir < 0 &&
        c0.close < c0.open &&
        c0.close <= struct.ema20 * 1.0005 &&
        zScore > -1.80 &&
        !rejectedAtSwingLow &&
        pressureAccel < -0.10 &&
        pressureVel < -0.12 &&
        closePos <= 0.34 &&
        lowerWick <= 0.22 &&
        kinematicRejection <= 0.10
      ) {
        lateDir = "PUT";
        lateScore =
          0.42 +
          clamp(-pressureAccel * 1.8, 0, 0.25) +
          clamp(-pressureVel * 1.4, 0, 0.22) +
          clamp(Math.abs(kinematicConvergence) * 0.15, 0, 0.12);
      }

      if (lateDir && lateScore >= 0.64) {
        const rawProb = Number(clamp(0.50 + lateScore * 0.185, 0.50, 0.695).toFixed(4));
        const uncert = Number(clamp(0.044 - lateScore * 0.014, 0.023, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 40, 95);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.020) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "LATE_ACCELERATION",
            correlationGroup: this.correlationGroup,
            direction: lateDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(0.54 + lateScore * 0.38, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: regimeComp,
            evidence: { pressureAccel, pressureVel, lastTicksDir, kinematicConvergence },
            reasons: [
              `Aceleração terminal convergente nos últimos segundos (+${(Math.abs(pressureAccel) * 100).toFixed(0)}%)`,
              `Rompimento intraminuto alinhado à estrutura sem sobreextensão`,
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
