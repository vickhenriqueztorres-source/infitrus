/**
 * momentum-velocity.js - Família A: Momentum e Velocidade
 * Oracle Quant Signals
 *
 * Grandezas medidas:
 * - Retornos M1, M2, M3, M5 (log returns)
 * - Retorno ponderado temporal
 * - Velocidade e aceleração do preço
 * - Persistência direcional
 * - Razão momentum / volatilidade
 * - Momentum relativo ao histórico recente (Z-score)
 * - Diferenciação de estados: (subindo + vel ^ + acel v) vs (subindo + vel ^ + acel ^)
 */

import { createContinuousSignal, clamp } from "../detector-types.js";

export class MomentumVelocityFamily {
  /**
   * Avalia a série temporal e extrai as variáveis e sinais de momentum.
   *
   * @param {Array<{ close: number, open: number, high: number, low: number, timestamp: number }>} candles
   * @returns {{ signals: Object<string, import("../detector-types.js").ContinuousSignal>, rawFeatures: Object<string, number> }}
   */
  evaluate(candles = []) {
    const n = candles.length;
    if (n < 6) {
      return { signals: {}, rawFeatures: {} };
    }

    const c0 = candles[n - 1].close;
    const c1 = candles[n - 2].close;
    const c2 = candles[n - 3].close;
    const c3 = candles[n - 4].close;
    const c5 = candles[n - 6].close;

    // 1. Retornos logarítmicos
    const r1 = Math.log(c0 / Math.max(1e-6, c1));
    const r2 = Math.log(c0 / Math.max(1e-6, c2));
    const r3 = Math.log(c0 / Math.max(1e-6, c3));
    const r5 = Math.log(c0 / Math.max(1e-6, c5));

    // 2. Retorno ponderado por decaimento exponencial
    const weightedReturn = 0.40 * r1 + 0.30 * (r2 / 2) + 0.20 * (r3 / 3) + 0.10 * (r5 / 5);

    // 3. Velocidade e aceleração
    const v0 = (c0 - c1) / 60; // pts/segundo no último minuto
    const v1 = (c1 - c2) / 60; // pts/segundo no minuto anterior
    const v2 = (c2 - c3) / 60;

    const acceleration = (v0 - v1) / 60;
    const prevAcceleration = (v1 - v2) / 60;
    const jerk = (acceleration - prevAcceleration) / 60; // terceira derivada

    // 4. Persistência (quantas das últimas 5 velas foram na mesma direção)
    let upStreak = 0;
    let downStreak = 0;
    for (let i = n - 1; i >= Math.max(0, n - 5); i--) {
      const diff = candles[i].close - candles[i].open;
      if (diff > 0) {
        if (downStreak > 0) break;
        upStreak++;
      } else if (diff < 0) {
        if (upStreak > 0) break;
        downStreak++;
      } else {
        break;
      }
    }
    const persistence = upStreak > 0 ? upStreak / 5 : downStreak > 0 ? -downStreak / 5 : 0;

    // 5. Razão Momentum / Volatilidade local
    let sumSq = 0;
    for (let i = n - 5; i < n; i++) {
      const ret = Math.log(candles[i].close / Math.max(1e-6, candles[i - 1].close));
      sumSq += ret * ret;
    }
    const sigma5 = Math.sqrt(sumSq / 5) || 1e-5;
    const momentumVolRatio = r1 / sigma5;

    // 6. Z-score do momentum relativo às últimas 20 velas
    let sumR = 0;
    const rList = [];
    const window20 = Math.min(20, n - 1);
    for (let i = n - window20; i < n; i++) {
      const ret = Math.log(candles[i].close / Math.max(1e-6, candles[i - 1].close));
      rList.push(ret);
      sumR += ret;
    }
    const meanR = sumR / window20;
    let varR = 0;
    for (const ret of rList) {
      varR += (ret - meanR) ** 2;
    }
    const stdR = Math.sqrt(varR / window20) || 1e-5;
    const momentumZScore = (r1 - meanR) / stdR;

    // 7. Matriz de Estado Dinâmico
    // Exemplo do PRD:
    // Estado A: subindo + velocidade aumentando + aceleração diminuindo (exaustão inicial)
    // Estado B: subindo + velocidade aumentando + aceleração aumentando (impulso pleno)
    const isRising = v0 > 0;
    const isVelIncreasing = Math.abs(v0) > Math.abs(v1);
    const isAccelIncreasing = acceleration > prevAcceleration;

    let dynamicState = 0;
    if (isRising && isVelIncreasing && isAccelIncreasing) {
      dynamicState = 1.0; // Impulso explosivo de alta
    } else if (isRising && isVelIncreasing && !isAccelIncreasing) {
      dynamicState = 0.5; // Alta com perda de tração (desacelerando)
    } else if (!isRising && isVelIncreasing && isAccelIncreasing) {
      dynamicState = -1.0; // Impulso explosivo de baixa
    } else if (!isRising && isVelIncreasing && !isAccelIncreasing) {
      dynamicState = -0.5; // Baixa desacelerando
    }

    // Sinais contínuos produzidos
    const signals = {
      momentum_trend: createContinuousSignal(
        r1 > 0 ? "CALL" : r1 < 0 ? "PUT" : "NEUTRAL",
        clamp(Math.abs(momentumZScore) / 2.5, 0, 1),
        clamp(Math.min(1, Math.abs(r1) / (sigma5 * 2)), 0.3, 0.95),
        clamp(Math.abs(momentumZScore) > 2 ? 0.8 : 0.2, 0, 1),
        r1,
        { r1, momentumZScore }
      ),
      weighted_momentum: createContinuousSignal(
        weightedReturn > 0 ? "CALL" : weightedReturn < 0 ? "PUT" : "NEUTRAL",
        clamp(Math.abs(weightedReturn) / (sigma5 * 2), 0, 1),
        clamp(0.5 + Math.abs(persistence) * 0.4, 0.4, 0.95),
        clamp(Math.abs(weightedReturn) > sigma5 * 3 ? 0.75 : 0.15, 0, 1),
        weightedReturn
      ),
      acceleration_impulse: createContinuousSignal(
        acceleration > 0 ? "CALL" : acceleration < 0 ? "PUT" : "NEUTRAL",
        clamp(Math.abs(acceleration) / (sigma5 / 30), 0, 1),
        clamp(0.6 + (isAccelIncreasing ? 0.3 : 0), 0.4, 0.9),
        clamp(Math.abs(jerk) > 0.001 ? 0.7 : 0.1, 0, 1),
        acceleration,
        { dynamicState }
      ),
    };

    const rawFeatures = {
      r1: Number(r1.toFixed(6)),
      r2: Number(r2.toFixed(6)),
      r3: Number(r3.toFixed(6)),
      r5: Number(r5.toFixed(6)),
      weightedReturn: Number(weightedReturn.toFixed(6)),
      priceVelocity: Number(v0.toFixed(6)),
      priceAcceleration: Number(acceleration.toFixed(8)),
      jerk: Number(jerk.toFixed(10)),
      persistence: Number(persistence.toFixed(3)),
      momentumVolRatio: Number(momentumVolRatio.toFixed(4)),
      momentumZScore: Number(momentumZScore.toFixed(4)),
      dynamicState,
    };

    return { signals, rawFeatures };
  }
}
