/**
 * price-positioning.js - Família G: Posição do Preço no Microcontexto
 * Oracle Quant Signals
 *
 * Fórmula:
 *   Position_n = (C - L_n) / (H_n - L_n)
 *
 * Janelas calculadas: 3, 5, 10 e 20 velas
 *
 * Objetivo:
 * Diferenciar momentum no centro do range de momentum no extremo superior/inferior.
 */

import { createContinuousSignal, clamp } from "../detector-types.js";

export class PricePositioningFamily {
  evaluate(candles = []) {
    const n = candles.length;
    if (n < 4) {
      return { signals: {}, rawFeatures: {} };
    }

    const currentClose = candles[n - 1].close;

    const getPosition = (window) => {
      const w = Math.min(window, n);
      let high = -Infinity;
      let low = Infinity;
      for (let i = n - w; i < n; i++) {
        if (candles[i].high > high) high = candles[i].high;
        if (candles[i].low < low) low = candles[i].low;
      }
      const range = high - low;
      return range > 0 ? (currentClose - low) / range : 0.5;
    };

    const pos3 = getPosition(3);
    const pos5 = getPosition(5);
    const pos10 = getPosition(10);
    const pos20 = getPosition(20);

    // Sinal de rompimento/extremo de canal
    let breakoutDir = "NEUTRAL";
    let breakoutStrength = 0;
    if (pos20 > 0.90 && pos5 > 0.85) {
      breakoutDir = "CALL"; // Testando/rompendo máxima do canal de 20 períodos
      breakoutStrength = clamp((pos20 - 0.90) * 10, 0, 1);
    } else if (pos20 < 0.10 && pos5 < 0.15) {
      breakoutDir = "PUT"; // Testando/rompendo mínima do canal de 20 períodos
      breakoutStrength = clamp((0.10 - pos20) * 10, 0, 1);
    }

    // Sinal de oscilação em zona central (pullback ideal)
    const isInCentralZone = pos20 >= 0.40 && pos20 <= 0.60;

    const signals = {
      channel_position: createContinuousSignal(
        pos20 > 0.65 ? "CALL" : pos20 < 0.35 ? "PUT" : "NEUTRAL",
        clamp(Math.abs(pos20 - 0.5) * 2, 0, 1),
        clamp(n >= 20 ? 0.85 : n / 25, 0.4, 0.85),
        clamp(pos20 > 0.95 || pos20 < 0.05 ? 0.8 : 0.2, 0, 1),
        pos20 - 0.5,
        { pos3, pos5, pos10, pos20 }
      ),
      channel_breakout: createContinuousSignal(
        breakoutDir,
        breakoutStrength,
        breakoutStrength > 0 ? 0.80 : 0.2,
        breakoutStrength > 0.5 ? 0.85 : 0.1,
        breakoutDir === "CALL" ? breakoutStrength : -breakoutStrength
      ),
    };

    const rawFeatures = {
      pos3: Number(pos3.toFixed(4)),
      pos5: Number(pos5.toFixed(4)),
      pos10: Number(pos10.toFixed(4)),
      pos20: Number(pos20.toFixed(4)),
      isCentralZone: isInCentralZone ? 1 : 0,
    };

    return { signals, rawFeatures };
  }
}
