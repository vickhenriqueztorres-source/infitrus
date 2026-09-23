/**
 * second-order-interactions.js - Família H: Interações de Segunda Ordem (Cross-Features)
 * Oracle Quant Signals
 *
 * Relações calculadas conforme o PRD:
 * - Momentum × Volatilidade
 * - Momentum × Acceleration
 * - ZScore × Acceleration
 * - BodyRatio × Pressure
 * - Pressure × Momentum
 * - WickRatio × ZScore
 * - VolatilityExpansion × Pressure
 *
 * Objetivo:
 * Capturar efeitos não-lineares que não aparecem olhando variáveis isoladas.
 */

import { createContinuousSignal, clamp } from "../detector-types.js";

export class SecondOrderInteractionsFamily {
  /**
   * Avalia as interações multiplicativas entre os resultados das outras famílias.
   *
   * @param {Object} rawFeatures - Dicionário de features brutas das outras famílias
   */
  evaluate(rawFeatures = {}) {
    const r1 = rawFeatures.r1 || 0;
    const sigma5 = rawFeatures.sigma5 || 1e-5;
    const accel = rawFeatures.priceAcceleration || 0;
    const zScore = rawFeatures.zScore || 0;
    const bodyRatio = rawFeatures.bodyRatio || 0.5;
    const pressure = rawFeatures.pressure || 0;
    const upperWickRatio = rawFeatures.upperWickRatio || 0.1;
    const lowerWickRatio = rawFeatures.lowerWickRatio || 0.1;
    const vr3_20 = rawFeatures.vr3_20 || 1.0;

    // 1. Momentum × Volatilidade
    const momentumXVol = r1 * sigma5 * 1000;

    // 2. Momentum × Acceleration (Confirmação de inércia ou desaceleração)
    const momentumXAccel = r1 * accel * 1e6;

    // 3. ZScore × Acceleration (Extensão com aceleração contra ou a favor)
    const zScoreXAccel = zScore * accel * 1e4;

    // 4. BodyRatio × Pressure (Candle sólido com fluxo concordante)
    const bodyXPressure = bodyRatio * pressure;

    // 5. Pressure × Momentum (Confluência intraminuto e fechamento)
    const pressureXMomentum = pressure * r1 * 100;

    // 6. WickRatio × ZScore (Pavio superior em ZScore alto = reversão iminente)
    const upperWickXZScore = upperWickRatio * zScore;
    const lowerWickXZScore = lowerWickRatio * zScore;

    // 7. VolatilityExpansion × Pressure (Expansão alimentada por fluxo direcional forte)
    const volExpXPressure = vr3_20 * pressure;

    // Sinais contínuos derivados de interações
    const isPressureMomentumConfirmed = pressureXMomentum > 0.05;
    const isPressureMomentumDivergent = pressureXMomentum < -0.05;

    let dir = "NEUTRAL";
    let strength = 0;
    if (bodyXPressure > 0.40 && pressure > 0) {
      dir = "CALL";
      strength = clamp(bodyXPressure, 0, 1);
    } else if (bodyXPressure < -0.40 && pressure < 0) {
      dir = "PUT";
      strength = clamp(Math.abs(bodyXPressure), 0, 1);
    }

    const signals = {
      body_pressure_coupling: createContinuousSignal(
        dir,
        strength,
        clamp(0.6 + Math.abs(pressure) * 0.3, 0.4, 0.95),
        clamp(Math.abs(bodyXPressure) > 0.6 ? 0.75 : 0.15, 0, 1),
        bodyXPressure,
        { bodyRatio, pressure }
      ),
      divergence_pressure_price: createContinuousSignal(
        isPressureMomentumDivergent ? (pressure > 0 ? "CALL" : "PUT") : "NEUTRAL",
        clamp(Math.abs(pressureXMomentum) * 2, 0, 1),
        isPressureMomentumDivergent ? 0.75 : 0.2,
        isPressureMomentumDivergent ? 0.85 : 0.1,
        pressureXMomentum
      ),
      exhaustion_wick_zscore: createContinuousSignal(
        upperWickXZScore > 0.80 ? "PUT" : lowerWickXZScore < -0.80 ? "CALL" : "NEUTRAL",
        clamp(Math.max(upperWickXZScore, Math.abs(lowerWickXZScore)), 0, 1),
        0.80,
        0.70,
        upperWickXZScore - Math.abs(lowerWickXZScore)
      ),
    };

    const rawInteractions = {
      momentumXVol: Number(momentumXVol.toFixed(5)),
      momentumXAccel: Number(momentumXAccel.toFixed(5)),
      zScoreXAccel: Number(zScoreXAccel.toFixed(5)),
      bodyXPressure: Number(bodyXPressure.toFixed(4)),
      pressureXMomentum: Number(pressureXMomentum.toFixed(4)),
      upperWickXZScore: Number(upperWickXZScore.toFixed(4)),
      lowerWickXZScore: Number(lowerWickXZScore.toFixed(4)),
      volExpXPressure: Number(volExpXPressure.toFixed(4)),
    };

    return { signals, rawFeatures: rawInteractions };
  }
}
