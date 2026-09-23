/**
 * reversion-exhaustion.js - Família E: Reversão e Exaustão Probabilística
 * Oracle Quant Signals
 *
 * Princípio fundamental do PRD:
 * "Não usar: subiu muito -> PUT. Utilizar combinação de afastamento + deterioração."
 *
 * Fórmula:
 *   Z_t = (P_t - μ_t) / σ_t
 *
 * Combina Z-score estatístico com:
 * - Aceleração negativa (perda de inércia)
 * - Redução de corpos (diminuição de volume direcional)
 * - Crescimento de pavios de rejeição
 * - Enfraquecimento da pressão intraminuto
 */

import { createContinuousSignal, clamp } from "../detector-types.js";

export class ReversionExhaustionFamily {
  evaluate(candles = [], microMetrics = null) {
    const n = candles.length;
    if (n < 20) {
      return { signals: {}, rawFeatures: {} };
    }

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    // 1. Cálculo de Z-Score sobre janela de 20 períodos
    let sum = 0;
    for (let i = n - 20; i < n; i++) {
      sum += candles[i].close;
    }
    const mean = sum / 20;
    let sumVar = 0;
    for (let i = n - 20; i < n; i++) {
      sumVar += (candles[i].close - mean) ** 2;
    }
    const std = Math.sqrt(sumVar / 20) || 1e-5;
    const zScore = (c0.close - mean) / std;

    // 2. Deterioração de aceleração
    const v0 = c0.close - c1.close;
    const v1 = c1.close - c2.close;
    const accel = v0 - v1;

    // 3. Deterioração de corpos
    const body0 = Math.abs(c0.close - c0.open);
    const body1 = Math.abs(c1.close - c1.open);
    const isBodyShrinking = body0 < body1 * 0.70;

    // 4. Crescimento de pavio de rejeição
    const range0 = Math.max(1e-6, c0.high - c0.low);
    const upperWick0 = (c0.high - Math.max(c0.open, c0.close)) / range0;
    const lowerWick0 = (Math.min(c0.open, c0.close) - c0.low) / range0;

    // 5. Pressão intraminuto
    const pressure = microMetrics?.pressure || 0;
    const pressureVel = microMetrics?.pressureVelocity || 0;

    // --- Condições de Exaustão de Alta (Candidato a PUT) ---
    // Z alto (+1.8 a +3.0) + aceleração negativa + corpos encolhendo + pavio superior crescendo + pressão deteriorando
    const isBullExhausted = zScore > 1.6 && accel < 0 && (isBodyShrinking || upperWick0 > 0.35) && (pressure < 0.2 || pressureVel < 0);

    // --- Condições de Exaustão de Baixa (Candidato a CALL) ---
    // Z baixo (-1.8 a -3.0) + aceleração positiva + corpos encolhendo + pavio inferior crescendo + pressão recuperando
    const isBearExhausted = zScore < -1.6 && accel > 0 && (isBodyShrinking || lowerWick0 > 0.35) && (pressure > -0.2 || pressureVel > 0);

    let exhaustionDir = "NEUTRAL";
    let exhaustionStrength = 0;
    let exhaustionConf = 0.2;

    if (isBullExhausted) {
      exhaustionDir = "PUT";
      const zFactor = clamp((zScore - 1.6) / 1.5, 0.4, 1);
      const wickFactor = clamp(upperWick0 * 1.5, 0.3, 1);
      exhaustionStrength = (zFactor + wickFactor) / 2;
      exhaustionConf = clamp(0.65 + (pressureVel < 0 ? 0.2 : 0), 0.5, 0.95);
    } else if (isBearExhausted) {
      exhaustionDir = "CALL";
      const zFactor = clamp((Math.abs(zScore) - 1.6) / 1.5, 0.4, 1);
      const wickFactor = clamp(lowerWick0 * 1.5, 0.3, 1);
      exhaustionStrength = (zFactor + wickFactor) / 2;
      exhaustionConf = clamp(0.65 + (pressureVel > 0 ? 0.2 : 0), 0.5, 0.95);
    }

    // Sinal de Reversão Estatística Simples (Mean Reversion)
    const signals = {
      exhaustion_deterioration: createContinuousSignal(
        exhaustionDir,
        exhaustionStrength,
        exhaustionConf,
        Math.abs(zScore) > 2.5 ? 0.85 : 0.25,
        exhaustionDir === "PUT" ? -exhaustionStrength : exhaustionStrength,
        { zScore, accel, upperWick0, lowerWick0 }
      ),
      mean_reversion_zscore: createContinuousSignal(
        zScore > 2.2 ? "PUT" : zScore < -2.2 ? "CALL" : "NEUTRAL",
        clamp((Math.abs(zScore) - 2.0) / 1.5, 0, 1),
        clamp(0.5 + (Math.abs(zScore) > 2.5 ? 0.3 : 0), 0.3, 0.85),
        clamp(Math.abs(zScore) / 3.5, 0, 1),
        -zScore
      ),
    };

    const rawFeatures = {
      zScore: Number(zScore.toFixed(4)),
      exhaustionStrength: Number(exhaustionStrength.toFixed(4)),
      accelDeceleration: Number(accel.toFixed(6)),
      isBodyShrinking: isBodyShrinking ? 1 : 0,
    };

    return { signals, rawFeatures };
  }
}
