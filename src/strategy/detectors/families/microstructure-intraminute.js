/**
 * microstructure-intraminute.js - Família F: Microestrutura Intraminuto
 * Oracle Quant Signals
 *
 * Grandezas medidas:
 * - Pressure_t = (sum ΔP+ - sum |ΔP-|) / sum |ΔP|
 * - Velocity(Pressure) e Acceleration(Pressure)
 * - Velocidade de chegada dos ticks (ticks/seg) e aceleração de fluxo
 * - Tempo relativo próximo das extremidades (High/Low)
 * - Direção e momento dos últimos N ticks
 * - Contagem de reversões intraminuto
 */

import { createContinuousSignal, clamp } from "../detector-types.js";

export class MicrostructureIntraminuteFamily {
  evaluate(microMetrics = null) {
    if (!microMetrics || microMetrics.tickCount < 3) {
      return {
        signals: {},
        rawFeatures: {
          pressure: 0,
          pressureVelocity: 0,
          pressureAcceleration: 0,
          tickArrivalRate: 0,
          timeNearHighRatio: 0.5,
          timeNearLowRatio: 0.5,
          lastTicksDirection: 0,
          flowImbalance: 0,
        },
      };
    }

    const pressure = Number(microMetrics.pressure ?? 0);
    const pressureVelocity = Number(microMetrics.pressureVelocity ?? 0);
    const pressureAcceleration = Number(microMetrics.pressureAcceleration ?? 0);
    const tickArrivalRate = Number(microMetrics.tickArrivalRate ?? 0);
    const tickArrivalAcceleration = Number(microMetrics.tickArrivalAcceleration ?? 0);
    const timeNearHighRatio = Number(microMetrics.timeNearHighRatio ?? 0.5);
    const timeNearLowRatio = Number(microMetrics.timeNearLowRatio ?? 0.5);
    const lastTicksDirection = Number(microMetrics.lastTicksDirection ?? 0);
    const reversalCount = Number(microMetrics.reversalCount ?? 0);
    const flowImbalance = Number(microMetrics.flowImbalance ?? 0);
    const tickCount = Number(microMetrics.tickCount ?? 0);

    // 1. Sinal de Pressão Direcional Pura
    const pressureDir = pressure > 0.15 ? "CALL" : pressure < -0.15 ? "PUT" : "NEUTRAL";
    const pressureStrength = clamp(Math.abs(pressure), 0, 1);
    const pressureConf = clamp(tickCount / 30, 0.4, 0.95);

    // 2. Sinal de Dinâmica da Pressão (Aceleração / Deterioração)
    // Ex: Pressão positiva mas velocidade negativa indica que os compradores estão perdendo o fôlego
    let dynamicDir = "NEUTRAL";
    let dynamicStrength = 0;
    if (pressure > 0 && pressureVelocity > 0 && pressureAcceleration > 0) {
      dynamicDir = "CALL"; // Pressão compradora acelerando
      dynamicStrength = clamp(pressureVelocity * 2, 0, 1);
    } else if (pressure > 0 && pressureVelocity < -0.1) {
      dynamicDir = "PUT"; // Pressão compradora se esvaindo
      dynamicStrength = clamp(Math.abs(pressureVelocity) * 2, 0, 1);
    } else if (pressure < 0 && pressureVelocity < 0 && pressureAcceleration < 0) {
      dynamicDir = "PUT"; // Pressão vendedora acelerando
      dynamicStrength = clamp(Math.abs(pressureVelocity) * 2, 0, 1);
    } else if (pressure < 0 && pressureVelocity > 0.1) {
      dynamicDir = "CALL"; // Pressão vendedora se esvaindo
      dynamicStrength = clamp(pressureVelocity * 2, 0, 1);
    }

    // 3. Sinal de Fechamento nos Extremos do Fluxo (Tempo próximo de High/Low)
    let extremeDir = "NEUTRAL";
    let extremeStrength = 0;
    if (timeNearHighRatio > 0.60 && lastTicksDirection >= 0) {
      extremeDir = "CALL";
      extremeStrength = clamp(timeNearHighRatio, 0, 1);
    } else if (timeNearLowRatio > 0.60 && lastTicksDirection <= 0) {
      extremeDir = "PUT";
      extremeStrength = clamp(timeNearLowRatio, 0, 1);
    }

    const signals = {
      micro_pressure: createContinuousSignal(
        pressureDir,
        pressureStrength,
        pressureConf,
        clamp(Math.abs(pressure) > 0.7 ? 0.75 : 0.15, 0, 1),
        pressure,
        { pressure, pressureVelocity }
      ),
      micro_pressure_dynamics: createContinuousSignal(
        dynamicDir,
        dynamicStrength,
        clamp(pressureConf * 0.9, 0.35, 0.9),
        clamp(Math.abs(pressureAcceleration) > 0.3 ? 0.8 : 0.2, 0, 1),
        pressureVelocity,
        { pressureVelocity, pressureAcceleration }
      ),
      micro_extremes: createContinuousSignal(
        extremeDir,
        extremeStrength,
        clamp(pressureConf * 0.85, 0.3, 0.85),
        0.2,
        timeNearHighRatio - timeNearLowRatio,
        { timeNearHighRatio, timeNearLowRatio }
      ),
    };

    const rawFeatures = {
      pressure: Number(pressure.toFixed(4)),
      pressureVelocity: Number(pressureVelocity.toFixed(4)),
      pressureAcceleration: Number(pressureAcceleration.toFixed(4)),
      tickArrivalRate: Number(tickArrivalRate.toFixed(2)),
      tickArrivalAcceleration: Number(tickArrivalAcceleration.toFixed(2)),
      timeNearHighRatio: Number(timeNearHighRatio.toFixed(3)),
      timeNearLowRatio: Number(timeNearLowRatio.toFixed(3)),
      lastTicksDirection,
      reversalCount,
      flowImbalance: Number(flowImbalance.toFixed(4)),
    };

    return { signals, rawFeatures };
  }
}
