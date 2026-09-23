/**
 * volatility-multidimensional.js - Família C: Volatilidade Multidimensional
 * Oracle Quant Signals
 *
 * Grandezas medidas:
 * - σ_2, σ_3, σ_5, σ_10, σ_20, σ_50
 * - VR_3,20 = σ_3 / σ_20
 * - VR_5,50 = σ_5 / σ_50
 * - Estados de ciclo de volatilidade:
 *     compressão, pré-expansão, expansão inicial, expansão madura,
 *     desaceleração da expansão, volatilidade anormal, normalização
 *
 * Princípio do PRD:
 * "A volatilidade não decide CALL ou PUT. Ela modifica a probabilidade dos outros estados."
 */

import { createContinuousSignal, clamp } from "../detector-types.js";

export class VolatilityMultidimensionalFamily {
  evaluate(candles = []) {
    const n = candles.length;
    if (n < 10) {
      return { signals: {}, rawFeatures: {}, volatilityState: "normal" };
    }

    // Calcula desvio padrão de retornos logarítmicos para janelas dadas
    const getStd = (window) => {
      const w = Math.min(window, n - 1);
      if (w < 2) return 1e-5;
      let sum = 0;
      const rets = [];
      for (let i = n - w; i < n; i++) {
        const r = Math.log(candles[i].close / Math.max(1e-6, candles[i - 1].close));
        rets.push(r);
        sum += r;
      }
      const mean = sum / w;
      let sumVar = 0;
      for (const r of rets) {
        sumVar += (r - mean) ** 2;
      }
      const std = Math.sqrt(sumVar / w);
      return Math.max(1e-5, std);
    };

    const s2 = getStd(2);
    const s3 = getStd(3);
    const s5 = getStd(5);
    const s10 = getStd(10);
    const s20 = getStd(20);
    const s50 = getStd(Math.min(50, n - 1));

    // Razões de volatilidade multiescala
    const vr3_20 = s3 / s20;
    const vr5_50 = s5 / s50;
    const vr2_10 = s2 / s10;

    // Classificação de Estado do Ciclo de Volatilidade
    let volState = "normalização";
    let volScore = 0.5; // [0: compressão extrema, 1: expansão explosiva]

    if (vr3_20 < 0.65 && vr5_50 < 0.75) {
      volState = "compressão";
      volScore = 0.15;
    } else if (vr3_20 >= 0.65 && vr3_20 < 1.05 && s2 > s3) {
      volState = "pré-expansão";
      volScore = 0.35;
    } else if (vr3_20 >= 1.05 && vr3_20 < 1.60 && s2 > s5) {
      volState = "expansão inicial";
      volScore = 0.65;
    } else if (vr3_20 >= 1.60 && vr5_50 > 1.40) {
      volState = "expansão madura";
      volScore = 0.85;
    } else if (s2 < s3 && vr3_20 > 1.20) {
      volState = "desaceleração da expansão";
      volScore = 0.70;
    } else if (vr3_20 > 2.50 || vr5_50 > 2.50) {
      volState = "volatilidade anormal";
      volScore = 0.95;
    }

    const signals = {
      volatility_regime: createContinuousSignal(
        "NEUTRAL", // Não emite direção, é puramente modulador
        clamp(volScore, 0, 1),
        clamp(Math.min(1, n / 50), 0.5, 0.95),
        clamp(vr3_20 > 2.2 ? 0.85 : vr3_20 < 0.5 ? 0.75 : 0.1, 0, 1),
        volScore,
        { volState, vr3_20, vr5_50 }
      ),
    };

    const rawFeatures = {
      sigma2: Number(s2.toFixed(6)),
      sigma3: Number(s3.toFixed(6)),
      sigma5: Number(s5.toFixed(6)),
      sigma10: Number(s10.toFixed(6)),
      sigma20: Number(s20.toFixed(6)),
      sigma50: Number(s50.toFixed(6)),
      vr3_20: Number(vr3_20.toFixed(4)),
      vr5_50: Number(vr5_50.toFixed(4)),
      vr2_10: Number(vr2_10.toFixed(4)),
      volScore: Number(volScore.toFixed(3)),
    };

    return { signals, rawFeatures, volatilityState: volState };
  }
}
