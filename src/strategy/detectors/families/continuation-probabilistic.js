/**
 * continuation-probabilistic.js - Família D: Continuação Probabilística
 * Oracle Quant Signals
 *
 * Padrões de Continuação:
 * 1. Momentum forte + aceleração positiva + fechamento no extremo + range crescente + pavio curto
 * 2. Impulso direcional prévio -> pausa de baixa amplitude -> volatilidade sustentada -> retomada
 * 3. Tendência macro M3 favorável + M1 neutro (pullback superficial) + micropressão favorável
 */

import { createContinuousSignal, clamp } from "../detector-types.js";

export class ContinuationProbabilisticFamily {
  evaluate(candles = [], microMetrics = null) {
    const n = candles.length;
    if (n < 6) {
      return { signals: {}, rawFeatures: {} };
    }

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];
    const c3 = candles[n - 4];

    const range0 = Math.max(1e-6, c0.high - c0.low);
    const range1 = Math.max(1e-6, c1.high - c1.low);
    const body0 = Math.abs(c0.close - c0.open);
    const closePos0 = (c0.close - c0.low) / range0;
    const upperWick0 = (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick0 = (Math.min(c0.open, c0.close) - c0.low) / range0;

    const r1 = Math.log(c0.close / Math.max(1e-6, c1.close));
    const rM3 = Math.log(c0.close / Math.max(1e-6, c3.close));

    const pressure = microMetrics?.pressure || 0;

    // --- Padrão 1: Impulso Explosivo de Continuação ---
    const isBullImpulse = r1 > 0 && closePos0 > 0.80 && upperWick0 < 0.15 && range0 > range1 * 1.15;
    const isBearImpulse = r1 < 0 && closePos0 < 0.20 && lowerWick0 < 0.15 && range0 > range1 * 1.15;

    let p1Direction = "NEUTRAL";
    let p1Strength = 0;
    if (isBullImpulse) {
      p1Direction = "CALL";
      p1Strength = clamp(closePos0 * (1 - upperWick0) * (range0 / range1), 0, 1);
    } else if (isBearImpulse) {
      p1Direction = "PUT";
      p1Strength = clamp((1 - closePos0) * (1 - lowerWick0) * (range0 / range1), 0, 1);
    }

    // --- Padrão 2: Impulso -> Pausa Curta -> Retomada ---
    const body1 = Math.abs(c1.close - c1.open);
    const body2 = Math.abs(c2.close - c2.open);
    const wasStrongBull = (c2.close - c2.open) > 0 && body2 > range1 * 1.2;
    const isSmallPause = body1 < body2 * 0.40;
    const isResumingBull = c0.close > c1.high && (c0.close - c0.open) > 0;

    const wasStrongBear = (c2.open - c2.close) > 0 && body2 > range1 * 1.2;
    const isResumingBear = c0.close < c1.low && (c0.open - c0.close) > 0;

    let p2Direction = "NEUTRAL";
    let p2Strength = 0;
    if (wasStrongBull && isSmallPause && isResumingBull) {
      p2Direction = "CALL";
      p2Strength = clamp(0.65 + (pressure > 0 ? 0.25 : 0), 0, 1);
    } else if (wasStrongBear && isSmallPause && isResumingBear) {
      p2Direction = "PUT";
      p2Strength = clamp(0.65 + (pressure < 0 ? 0.25 : 0), 0, 1);
    }

    // --- Padrão 3: Retorno M3 forte + M1 neutro com micropressão ---
    let p3Direction = "NEUTRAL";
    let p3Strength = 0;
    if (rM3 > 0.0015 && Math.abs(r1) < 0.0004 && pressure > 0.25) {
      p3Direction = "CALL";
      p3Strength = clamp(Math.abs(rM3) * 100 + pressure * 0.4, 0, 1);
    } else if (rM3 < -0.0015 && Math.abs(r1) < 0.0004 && pressure < -0.25) {
      p3Direction = "PUT";
      p3Strength = clamp(Math.abs(rM3) * 100 + Math.abs(pressure) * 0.4, 0, 1);
    }

    const signals = {
      continuation_impulse: createContinuousSignal(
        p1Direction,
        p1Strength,
        p1Strength > 0 ? 0.85 : 0.2,
        range0 > range1 * 2 ? 0.75 : 0.2,
        p1Direction === "CALL" ? p1Strength : -p1Strength
      ),
      continuation_pause_resume: createContinuousSignal(
        p2Direction,
        p2Strength,
        p2Strength > 0 ? 0.80 : 0.2,
        0.35,
        p2Direction === "CALL" ? p2Strength : -p2Strength
      ),
      continuation_m3_pressure: createContinuousSignal(
        p3Direction,
        p3Strength,
        p3Strength > 0 ? 0.75 : 0.2,
        0.30,
        p3Direction === "CALL" ? p3Strength : -p3Strength
      ),
    };

    const rawFeatures = {
      contImpulseStrength: Number(p1Strength.toFixed(4)),
      contPauseStrength: Number(p2Strength.toFixed(4)),
      contM3Strength: Number(p3Strength.toFixed(4)),
      rM3: Number(rM3.toFixed(6)),
    };

    return { signals, rawFeatures };
  }
}
