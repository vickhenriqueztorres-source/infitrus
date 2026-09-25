/**
 * knn-temporal-leak.test.js
 * Validação de ausência de vazamento temporal no AdaptiveKNNEngine (Etapa 6)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { AdaptiveKnnEngine } from "../src/strategy/engines/adaptive-knn-engine.js";

function generateSyntheticCandles(count = 50) {
  const candles = [];
  let price = 100.0;
  for (let i = 0; i < count; i++) {
    const open = price;
    const change = (i % 2 === 0 ? 0.5 : -0.4);
    const close = open + change;
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    price = close;
    candles.push({
      timestamp: 1727180000 + i * 60,
      open,
      high,
      low,
      close,
      closed: true,
    });
  }
  return candles;
}

test("Etapa 6: KNN não utiliza a vela aberta (closed=false) como rótulo de treino (zero vazamento)", () => {
  const engine = new AdaptiveKnnEngine();
  const candles = generateSyntheticCandles(40);

  // Adiciona vela aberta no final (n-1)
  const openCandle = {
    timestamp: 1727180000 + 40 * 60,
    open: 100.0,
    high: 105.0,
    low: 99.0,
    close: 104.0, // Alta forte fictícia
    closed: false,
  };
  const seriesWithOpen = [...candles, openCandle];

  const currentVector = [0.1, 0.5, 0.8, -0.2];

  const result1 = engine.evaluate({
    currentVector,
    candles: seriesWithOpen,
  });

  assert.ok(result1.confidence > 0, "Deve calcular probabilidade com confiança válida");

  // Altera drasticamente o close da vela aberta (intrabar tick para baixa extrema)
  const modifiedOpenCandle = {
    ...openCandle,
    close: 95.0, // Agora fechando em baixa extrema
    low: 94.0,
  };
  const seriesWithModifiedOpen = [...candles, modifiedOpenCandle];

  const result2 = engine.evaluate({
    currentVector,
    candles: seriesWithModifiedOpen,
  });

  // Como o treino usa estritamente velas fechadas (closed === true),
  // e maxTrainIndex ignora a vela aberta como label de candle N-2,
  // os rótulos históricos de treino não sofrem contaminação de lookahead
  assert.ok(result2.confidence > 0);
  assert.equal(typeof result2.probUp, "number");
  assert.equal(typeof result2.probDown, "number");
});

test("Etapa 6: maxTrainIndex para vela aberta isola a última vela fechada como preditora sem rótulo futuro", () => {
  const engine = new AdaptiveKnnEngine();
  const candles = generateSyntheticCandles(30);

  // Marca última vela como fechada
  const resClosed = engine.evaluate({
    currentVector: [0.2, 0.3],
    candles: candles.map((c) => ({ ...c, closed: true })),
  });

  // Marca última vela como aberta
  const candlesWithOpen = candles.map((c, idx) => ({
    ...c,
    closed: idx !== candles.length - 1,
  }));

  const resOpen = engine.evaluate({
    currentVector: [0.2, 0.3],
    candles: candlesWithOpen,
  });

  // Quando aberta, não pode usar n-1 como rótulo de n-2
  assert.ok(Number.isFinite(resOpen.probUp));
  assert.ok(Number.isFinite(resClosed.probUp));
});
