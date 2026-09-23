/**
 * candle-geometry.js - Família B: Estrutura Geométrica das Velas
 * Oracle Quant Signals
 *
 * Grandezas medidas:
 * - BodyRatio = |C - O| / (H - L)
 * - UpperWickRatio = (H - max(O, C)) / (H - L)
 * - LowerWickRatio = (min(O, C) - L) / (H - L)
 * - Posição do fechamento e abertura dentro do range
 * - Crescimento/redução do corpo e expansão/compressão do range
 * - Assimetria e dinâmica de pavios das últimas 2, 3 e 5 velas
 */

import { createContinuousSignal, clamp } from "../detector-types.js";

export class CandleGeometryFamily {
  evaluate(candles = []) {
    const n = candles.length;
    if (n < 6) {
      return { signals: {}, rawFeatures: {} };
    }

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];

    // Helper de geometria de uma vela
    const getGeom = (c) => {
      const range = Math.max(1e-6, c.high - c.low);
      const body = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const closePos = (c.close - c.low) / range;
      const openPos = (c.open - c.low) / range;
      const bodyRatio = body / range;
      const upperWickRatio = upperWick / range;
      const lowerWickRatio = lowerWick / range;
      const asymmetry = upperWick - lowerWick; // positivo = pavio superior maior
      return { range, body, upperWick, lowerWick, closePos, openPos, bodyRatio, upperWickRatio, lowerWickRatio, asymmetry };
    };

    const g0 = getGeom(c0);
    const g1 = getGeom(c1);
    const g2 = getGeom(c2);

    // 1. Variações dimensionais
    const bodyGrowth = g0.body / Math.max(1e-6, g1.body);
    const rangeExpansion = g0.range / Math.max(1e-6, g1.range);
    const upperWickDelta = g0.upperWickRatio - g1.upperWickRatio;
    const lowerWickDelta = g0.lowerWickRatio - g1.lowerWickRatio;

    // 2. Relação média corpo/range das últimas 5 velas
    let sumBodyRatio5 = 0;
    let sumRange5 = 0;
    let sumAsym5 = 0;
    for (let i = n - 5; i < n; i++) {
      const g = getGeom(candles[i]);
      sumBodyRatio5 += g.bodyRatio;
      sumRange5 += g.range;
      sumAsym5 += g.asymmetry;
    }
    const avgBodyRatio5 = sumBodyRatio5 / 5;
    const avgRange5 = sumRange5 / 5;
    const avgAsym5 = sumAsym5 / 5;

    // 3. Assimetria composta (2, 3 e 5 velas)
    const asym2 = g0.asymmetry + g1.asymmetry;
    const asym3 = asym2 + g2.asymmetry;
    const asym5 = sumAsym5;

    // Sinais contínuos geométricos
    // Fechamento no extremo superior (> 0.85) com corpo dominante e pavio superior minúsculo indica pressão compradora
    const isBullishDominant = g0.closePos > 0.75 && g0.bodyRatio > 0.60 && g0.upperWickRatio < 0.15;
    const isBearishDominant = g0.closePos < 0.25 && g0.bodyRatio > 0.60 && g0.lowerWickRatio < 0.15;

    // Pavio de rejeição inferior (martelo/absorção)
    const isLowerRejection = g0.lowerWickRatio > 0.50 && g0.closePos > 0.55;
    // Pavio de rejeição superior (estrela cadente/absorção)
    const isUpperRejection = g0.upperWickRatio > 0.50 && g0.closePos < 0.45;

    const signals = {
      body_dominance: createContinuousSignal(
        isBullishDominant ? "CALL" : isBearishDominant ? "PUT" : "NEUTRAL",
        clamp(g0.bodyRatio, 0, 1),
        clamp(g0.range / Math.max(1e-6, avgRange5), 0.3, 0.95),
        clamp(bodyGrowth > 2.0 ? 0.7 : 0.1, 0, 1),
        g0.bodyRatio,
        { closePos: g0.closePos, bodyRatio: g0.bodyRatio }
      ),
      wick_rejection: createContinuousSignal(
        isLowerRejection ? "CALL" : isUpperRejection ? "PUT" : "NEUTRAL",
        clamp(Math.max(g0.lowerWickRatio, g0.upperWickRatio), 0, 1),
        clamp(0.5 + Math.abs(g0.upperWickRatio - g0.lowerWickRatio) * 0.5, 0.4, 0.95),
        clamp(Math.max(g0.lowerWickRatio, g0.upperWickRatio) > 0.65 ? 0.8 : 0.2, 0, 1),
        g0.lowerWickRatio - g0.upperWickRatio,
        { lowerWickRatio: g0.lowerWickRatio, upperWickRatio: g0.upperWickRatio }
      ),
      range_expansion: createContinuousSignal(
        g0.close > g0.open ? "CALL" : "PUT",
        clamp((rangeExpansion - 1.0) / 1.5, 0, 1),
        clamp(avgBodyRatio5, 0.3, 0.9),
        clamp(rangeExpansion > 2.5 ? 0.85 : 0.1, 0, 1),
        rangeExpansion
      ),
    };

    const rawFeatures = {
      bodyRatio: Number(g0.bodyRatio.toFixed(4)),
      upperWickRatio: Number(g0.upperWickRatio.toFixed(4)),
      lowerWickRatio: Number(g0.lowerWickRatio.toFixed(4)),
      closePosition: Number(g0.closePos.toFixed(4)),
      openPosition: Number(g0.openPos.toFixed(4)),
      bodyGrowth: Number(bodyGrowth.toFixed(4)),
      rangeExpansion: Number(rangeExpansion.toFixed(4)),
      upperWickDelta: Number(upperWickDelta.toFixed(4)),
      lowerWickDelta: Number(lowerWickDelta.toFixed(4)),
      avgBodyRatio5: Number(avgBodyRatio5.toFixed(4)),
      asymmetry2: Number(asym2.toFixed(6)),
      asymmetry3: Number(asym3.toFixed(6)),
      asymmetry5: Number(asym5.toFixed(6)),
    };

    return { signals, rawFeatures };
  }
}
