/**
 * microstructure-family.js - Família 3: Microestrutura / Fluxo de Ticks (5 Subestratégias Autônomas com Ancoragem Gráfica)
 * Oracle Quant Signals — Active Quant Optimizer
 *
 * Subestratégias:
 * 3A. Persistent Tick Pressure: Pressão de fluxo não-linear integrada (F(t)) sustentada sem rejeição de pavio oposto.
 * 3B. Pressure Acceleration: Convergência entre derivada de velocidade/aceleração do preço e aceleração da pressão.
 * 3C. Pressure Reversal: Divergência cinemática (freio v > 0, a << 0) e inversão súbita de agressão em zona esticada.
 * 3D. High/Low Acceptance: Densidade de ocupação temporal de Wasserstein concentrada nos quantis extremos sem absorção contrária.
 * 3E. End-of-Minute Flow: Explosão direcional limpa nos últimos 15s/10s alinhada ao fechamento da vela.
 */

import { clamp } from "../detectors/detector-types.js";
import { CorrelationGroups, computeWilsonLowerBound } from "../pool/opportunity-pool.js";

function extractCandleGuard(candles, featureMap) {
  if (!Array.isArray(candles) || candles.length < 5) {
    return {
      hasCandles: false,
      allowBullContinuation: true,
      allowBearContinuation: true,
      allowBearReversal: true,
      allowBullReversal: true,
      closePos: 0.5,
      upperWick: 0.1,
      lowerWick: 0.1,
      zScore: 0,
      rangeToAtr: 1.0,
    };
  }

  const n = candles.length;
  const c0 = candles[n - 1];
  const range0 = Math.max(1e-6, c0.high - c0.low);

  const atrPeriod = Math.min(14, n - 1);
  let trSum = 0;
  for (let i = n - atrPeriod; i < n; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    trSum += Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose));
  }
  const atr14 = Math.max(1e-6, trSum / Math.max(1, atrPeriod));
  const rangeToAtr = range0 / atr14;

  const closePos = featureMap.closePosition !== undefined ? featureMap.closePosition : (c0.close - c0.low) / range0;
  const upperWick = featureMap.upperWickRatio !== undefined ? featureMap.upperWickRatio : (c0.high - Math.max(c0.open, c0.close)) / range0;
  const lowerWick = featureMap.lowerWickRatio !== undefined ? featureMap.lowerWickRatio : (Math.min(c0.open, c0.close) - c0.low) / range0;
  const zScore = featureMap.zScore20 !== undefined ? featureMap.zScore20 : 0;

  // Bloqueia sinais de continuação de fluxo em micro-dojis (< 0.45 ATR), contra pavio de rejeição (> 35%) ou em exaustão severa (|Z| >= 1.90)
  const allowBullContinuation =
    rangeToAtr >= 0.45 && c0.close > c0.open && upperWick <= 0.34 && closePos >= 0.55 && zScore < 1.90;
  const allowBearContinuation =
    rangeToAtr >= 0.45 && c0.close < c0.open && lowerWick <= 0.34 && closePos <= 0.45 && zScore > -1.90;

  // Reversão de fluxo exige pavio de absorção ou extremo de Z-Score
  const allowBearReversal = rangeToAtr >= 0.65 && (upperWick >= 0.28 || zScore >= 1.25 || closePos <= 0.50);
  const allowBullReversal = rangeToAtr >= 0.65 && (lowerWick >= 0.28 || zScore <= -1.25 || closePos >= 0.50);

  return {
    hasCandles: true,
    allowBullContinuation,
    allowBearContinuation,
    allowBearReversal,
    allowBullReversal,
    closePos,
    upperWick,
    lowerWick,
    zScore,
    rangeToAtr,
  };
}

export class MicrostructureFamily {
  constructor(config = {}) {
    this.familyId = "MICROSTRUCTURE";
    this.familyName = "Microestrutura / Fluxo";
    this.correlationGroup = CorrelationGroups.MICROSTRUCTURE;
    this.minTicks = config.minTicks || 8;
  }

  /**
   * Avalia as métricas intraminuto ancoradas na estrutura gráfica da vela e gera candidatos das 5 subestratégias.
   */
  evaluate({ candles = [], featureMap = {}, microMetrics = null, payout = 0.80, timestamp = Date.now() }) {
    const tickCount = microMetrics?.tickCount || 0;
    if (!microMetrics || tickCount < this.minTicks) return [];

    const breakeven = 1 / (1 + payout);
    const opportunities = [];
    const guard = extractCandleGuard(candles, featureMap);

    const {
      pressure = 0,
      integratedFlowPressure = pressure,
      pressureVelocity = 0,
      pressureAcceleration = 0,
      priceVelocity = 0,
      priceAcceleration = 0,
      kinematicRejection = 0,
      kinematicConvergence = 0,
      timeNearHighRatio = 0,
      timeNearLowRatio = 0,
      lastTicksDirection = 0,
      flowImbalance = 0,
      durationDensity = null,
    } = microMetrics;

    const sampleConfidence = clamp(0.52 + Math.min(0.43, tickCount / 40), 0.52, 0.95);

    // =========================================================================
    // 3A — PERSISTENT TICK PRESSURE (Pressão Integrada Não-Linear Sustentada)
    // =========================================================================
    {
      let pDir = null;
      let pScore = 0;

      if (
        guard.allowBullContinuation &&
        integratedFlowPressure >= 0.56 &&
        flowImbalance >= 0.36 &&
        tickCount >= 20 &&
        kinematicRejection >= -0.15
      ) {
        pDir = "CALL";
        pScore =
          0.36 +
          clamp(integratedFlowPressure * 0.65, 0.24, 0.46) +
          clamp(flowImbalance * 0.32, 0.10, 0.18);
      } else if (
        guard.allowBearContinuation &&
        integratedFlowPressure <= -0.56 &&
        flowImbalance <= -0.36 &&
        tickCount >= 20 &&
        kinematicRejection <= 0.15
      ) {
        pDir = "PUT";
        pScore =
          0.36 +
          clamp(-integratedFlowPressure * 0.65, 0.24, 0.46) +
          clamp(-flowImbalance * 0.32, 0.10, 0.18);
      }

      if (pDir && pScore >= 0.72) {
        const rawProb = Number(clamp(0.50 + pScore * 0.185, 0.50, 0.70).toFixed(4));
        const uncert = Number(clamp(0.041 - pScore * 0.013, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 42, 102);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PERSISTENT_TICK_PRESSURE",
            correlationGroup: this.correlationGroup,
            direction: pDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(sampleConfidence.toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: 1.0,
            evidence: { integratedFlowPressure, flowImbalance, tickCount },
            reasons: [
              `Pressão não-linear persistente de ticks (${(integratedFlowPressure * 100).toFixed(0)}%)`,
              `Desequilíbrio de agressão sustentado (${(flowImbalance * 100).toFixed(0)}%) sem rejeição`,
            ],
            timestamp,
            fingerprint: `TICKPRESS_${pDir}_${timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 3B — PRESSURE ACCELERATION (Derivada de 1ª e 2ª Ordem + Convergência Cinemática)
    // =========================================================================
    {
      let accelDir = null;
      let accelScore = 0;

      const dynamicForceBull =
        pressureVelocity * 1.45 + pressureAcceleration * 0.95 + Math.max(0, kinematicConvergence) * 0.25;
      const dynamicForceBear =
        -pressureVelocity * 1.45 - pressureAcceleration * 0.95 + Math.max(0, -kinematicConvergence) * 0.25;

      if (
        guard.allowBullContinuation &&
        dynamicForceBull >= 0.42 &&
        tickCount >= 16 &&
        priceAcceleration >= -0.02 &&
        kinematicRejection >= -0.10
      ) {
        accelDir = "CALL";
        accelScore = 0.36 + clamp(dynamicForceBull * 1.25, 0.18, 0.54);
      } else if (
        guard.allowBearContinuation &&
        dynamicForceBear >= 0.42 &&
        tickCount >= 16 &&
        priceAcceleration <= 0.02 &&
        kinematicRejection <= 0.10
      ) {
        accelDir = "PUT";
        accelScore = 0.36 + clamp(dynamicForceBear * 1.25, 0.18, 0.54);
      }

      if (accelDir && accelScore >= 0.68) {
        const rawProb = Number(clamp(0.50 + accelScore * 0.19, 0.50, 0.705).toFixed(4));
        const uncert = Number(clamp(0.043 - accelScore * 0.014, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 40, 98);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PRESSURE_ACCELERATION",
            correlationGroup: this.correlationGroup,
            direction: accelDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(sampleConfidence * 0.95, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: 1.05,
            evidence: { pressureVelocity, pressureAcceleration, kinematicConvergence },
            reasons: [
              `Aceleração diferencial da agressão (${(pressureAcceleration * 100).toFixed(0)}%)`,
              `Convergência cinemática favorável nos últimos ticks`,
            ],
            timestamp,
            fingerprint: `PRESSACC_${accelDir}_${timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 3C — PRESSURE REVERSAL (Freio Cinemático Terminal e Inversão Súbita de Agressão)
    // =========================================================================
    {
      let revDir = null;
      let revScore = 0;

      // Inversão Baixista (PUT): pressão prévia compradora que sofre freio brusco (pressureVelocity << 0 ou kinematicRejection < 0)
      if (
        guard.allowBearReversal &&
        pressure > 0.25 &&
        (pressureVelocity < -0.32 || (pressureVelocity < -0.20 && kinematicRejection < -0.18)) &&
        lastTicksDirection <= 0
      ) {
        revDir = "PUT";
        revScore =
          0.36 +
          clamp(-pressureVelocity * 1.6, 0.18, 0.44) +
          clamp(Math.abs(Math.min(0, kinematicRejection)) * 0.25, 0, 0.18);
      } else if (
        guard.allowBullReversal &&
        pressure < -0.25 &&
        (pressureVelocity > 0.32 || (pressureVelocity > 0.20 && kinematicRejection > 0.18)) &&
        lastTicksDirection >= 0
      ) {
        revDir = "CALL";
        revScore =
          0.36 +
          clamp(pressureVelocity * 1.6, 0.18, 0.44) +
          clamp(Math.max(0, kinematicRejection) * 0.25, 0, 0.18);
      }

      if (revDir && revScore >= 0.66) {
        const rawProb = Number(clamp(0.50 + revScore * 0.185, 0.50, 0.695).toFixed(4));
        const uncert = Number(clamp(0.044 - revScore * 0.014, 0.023, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 40, 96);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "PRESSURE_REVERSAL",
            correlationGroup: this.correlationGroup,
            direction: revDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(sampleConfidence * 0.92, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: 1.0,
            evidence: { pressure, pressureVelocity, kinematicRejection },
            reasons: [
              `Inversão de agressão e freio cinemático no terço final (${revDir})`,
              `Absorção da pressão prévia pelos ticks terminais`,
            ],
            timestamp,
            fingerprint: `PRESSREV_${revDir}_${timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 3D — HIGH/LOW ACCEPTANCE (Densidade de Ocupação Temporal nos Quantis Extremos)
    // =========================================================================
    {
      let accDir = null;
      let accScore = 0;

      // Usa a densidade de ocupação de Wasserstein (durationDensity[3..4] vs [0..1]) quando disponível
      const topOccupancy =
        Array.isArray(durationDensity) && durationDensity.length === 5
          ? durationDensity[3] + durationDensity[4]
          : timeNearHighRatio;
      const bottomOccupancy =
        Array.isArray(durationDensity) && durationDensity.length === 5
          ? durationDensity[0] + durationDensity[1]
          : timeNearLowRatio;

      if (
        guard.allowBullContinuation &&
        topOccupancy >= 0.52 &&
        topOccupancy > bottomOccupancy * 2.2 &&
        integratedFlowPressure >= 0.22 &&
        kinematicRejection >= -0.10
      ) {
        accDir = "CALL";
        accScore = 0.34 + clamp(topOccupancy * 0.72, 0.24, 0.54);
      } else if (
        guard.allowBearContinuation &&
        bottomOccupancy >= 0.52 &&
        bottomOccupancy > topOccupancy * 2.2 &&
        integratedFlowPressure <= -0.22 &&
        kinematicRejection <= 0.10
      ) {
        accDir = "PUT";
        accScore = 0.34 + clamp(bottomOccupancy * 0.72, 0.24, 0.54);
      }

      if (accDir && accScore >= 0.66) {
        const rawProb = Number(clamp(0.50 + accScore * 0.185, 0.50, 0.695).toFixed(4));
        const uncert = Number(clamp(0.041 - accScore * 0.013, 0.022, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 42, 100);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.025) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "HIGH_LOW_ACCEPTANCE",
            correlationGroup: this.correlationGroup,
            direction: accDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(sampleConfidence.toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "ACTIVE",
            regimeCompatibility: 1.0,
            evidence: {
              topOccupancy: Number(topOccupancy.toFixed(3)),
              bottomOccupancy: Number(bottomOccupancy.toFixed(3)),
            },
            reasons: [
              `Aceitação temporal sustentada no extremo (${((accDir === "CALL" ? topOccupancy : bottomOccupancy) * 100).toFixed(0)}% da densidade)`,
            ],
            timestamp,
            fingerprint: `EXTRACC_${accDir}_${timestamp}`,
          });
        }
      }
    }

    // =========================================================================
    // 3E — END-OF-MINUTE FLOW (Impulso Limpo de Fechamento nos Últimos 15s)
    // =========================================================================
    {
      let eomDir = null;
      let eomScore = 0;

      // Exige desbalanceamento forte (>= 0.28) e pressão integrada expressiva (>= 0.34) para não disparar em ruído
      const minEomTicks = Math.max(14, this.minTicks);
      if (
        tickCount >= minEomTicks &&
        Math.abs(integratedFlowPressure) >= 0.34 &&
        Math.abs(flowImbalance) >= 0.28
      ) {
        const directionalMagnitude = clamp(
          Math.abs(integratedFlowPressure) * 0.55 + Math.abs(flowImbalance) * 0.45,
          0,
          1
        );

        if (
          guard.allowBullContinuation &&
          lastTicksDirection > 0 &&
          integratedFlowPressure > 0 &&
          flowImbalance > 0 &&
          priceVelocity >= 0 &&
          kinematicRejection >= -0.10
        ) {
          eomDir = "CALL";
          eomScore = 0.40 + directionalMagnitude * 0.42;
        } else if (
          guard.allowBearContinuation &&
          lastTicksDirection < 0 &&
          integratedFlowPressure < 0 &&
          flowImbalance < 0 &&
          priceVelocity <= 0 &&
          kinematicRejection <= 0.10
        ) {
          eomDir = "PUT";
          eomScore = 0.40 + directionalMagnitude * 0.42;
        }
      }

      if (eomDir && eomScore >= 0.64) {
        const rawProb = Number(clamp(0.50 + eomScore * 0.185, 0.50, 0.695).toFixed(4));
        const uncert = Number(clamp(0.043 - eomScore * 0.014, 0.023, 0.05).toFixed(4));
        const structEffN = clamp(0.065 / (uncert * uncert), 40, 96);
        const consProb = Number(computeWilsonLowerBound(rawProb, structEffN, 0.6745).toFixed(4));
        const edge = Number((consProb - breakeven).toFixed(4));

        if (consProb > breakeven && edge >= 0.022) {
          opportunities.push({
            strategy: this.familyId,
            subStrategy: "END_OF_MINUTE_FLOW",
            correlationGroup: this.correlationGroup,
            direction: eomDir,
            rawProbability: rawProb,
            calibratedProbability: rawProb,
            conservativeProbability: consProb,
            uncertainty: uncert,
            quality: Number(clamp(sampleConfidence * 0.92, 0.50, 0.95).toFixed(3)),
            breakevenProbability: Number(breakeven.toFixed(4)),
            edge,
            maturity: "LEARNING",
            regimeCompatibility: 1.0,
            evidence: { lastTicksDirection, flowImbalance, integratedFlowPressure, tickCount },
            reasons: [
              `Fluxo dominante de fechamento da M1 (${eomDir})`,
              `Pressão integrada (${(integratedFlowPressure * 100).toFixed(0)}%) e desequilíbrio (${(flowImbalance * 100).toFixed(0)}%)`,
            ],
            timestamp,
            fingerprint: `EOMFLOW_${eomDir}_${timestamp}`,
          });
        }
      }
    }

    return opportunities;
  }
}
