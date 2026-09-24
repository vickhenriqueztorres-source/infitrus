import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateEMA, getLatestEMAValues } from "../src/indicators/ema.js";
import { calculateRSI, getLatestRSI } from "../src/indicators/rsi.js";
import { StrategyEngine, SignalAction } from "../src/strategy/strategy-engine.js";

test("EMA: Cálculo matemático correto e inicialização por SMA", () => {
  // Série simples de 10 valores
  const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const ema3 = calculateEMA(prices, 3);

  // Primeiros 2 devem ser null
  assert.equal(ema3[0], null);
  assert.equal(ema3[1], null);
  // O 3º é a média simples: (10 + 11 + 12) / 3 = 11
  assert.equal(ema3[2], 11);

  // O 4º: multiplier = 2 / (3 + 1) = 0.5
  // EMA = (13 - 11) * 0.5 + 11 = 12
  assert.equal(ema3[3], 12);

  const latest = getLatestEMAValues(prices, 3);
  assert.ok(latest.current > latest.previous);
});

test("RSI: Cálculo correto, escala 0-100 e sensibilidade de direção", () => {
  // 1. Série estritamente crescente -> RSI deve tender a 100
  const risingPrices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
  const rsiHigh = getLatestRSI(risingPrices, 14);
  assert.ok(rsiHigh !== null && rsiHigh >= 90, `RSI de alta esperado >= 90, obtido: ${rsiHigh}`);

  // 2. Série estritamente decrescente -> RSI deve tender a 0
  const fallingPrices = [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10];
  const rsiLow = getLatestRSI(fallingPrices, 14);
  assert.ok(rsiLow !== null && rsiLow <= 10, `RSI de baixa esperado <= 10, obtido: ${rsiLow}`);
});

test("Strategy Engine: Respeito ao aquecimento de velas", () => {
  const engine = new StrategyEngine({ emaFastPeriod: 9, emaSlowPeriod: 21, rsiPeriod: 14 });

  // Somente 10 velas (insuficiente para período 21)
  const fewCandles = Array.from({ length: 10 }, (_, i) => ({
    timestamp: 1727010000 + i * 60,
    open: 1.08,
    high: 1.09,
    low: 1.07,
    close: 1.085,
    closed: true,
  }));

  const result = engine.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles: fewCandles,
    isReady: true,
  });

  assert.equal(result.action, SignalAction.WAIT);
  assert.match(result.reasons[0], /Aquecendo indicadores/);
});

test("Strategy Engine: Detecção precisa de COMPRA (BUY) no cruzamento de alta", () => {
  const engine = new StrategyEngine({ emaFastPeriod: 9, emaSlowPeriod: 21, rsiPeriod: 14 });

  // Cria 30 candles simulando reversão para alta
  const candles = [];
  let price = 100;
  for (let i = 0; i < 25; i++) {
    price -= 0.5; // queda anterior para garantir EMA9 <= EMA21
    candles.push({ timestamp: 1727010000 + i * 60, open: price, high: price + 0.2, low: price - 0.2, close: price, closed: true });
  }
  // Forte arrancada para cruzar para cima
  for (let i = 25; i < 30; i++) {
    price += 4.0;
    candles.push({ timestamp: 1727010000 + i * 60, open: price - 1, high: price + 1, low: price - 1, close: price, closed: true });
  }

  // O cruzamento ocorre exatamente no candle de índice 28 (total 29 velas)
  const resultBuy = engine.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles: candles.slice(0, 29),
    isReady: true,
  });

  assert.equal(resultBuy.action, SignalAction.BUY);
  assert.equal(resultBuy.label, "COMPRA");
  assert.ok(resultBuy.indicators.rsi14 > 50);
  assert.ok(resultBuy.isNewSignal);

  // Na vela seguinte (índice 29), sem novo cruzamento, deve retornar WAIT
  const resultWait = engine.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles: candles,
    isReady: true,
  });
  assert.equal(resultWait.action, SignalAction.WAIT);
});

test("Strategy Engine: Bloqueio estrito de candle aberto (closed=false) e dataState inválido", () => {
  const engine = new StrategyEngine();
  const openCandles = Array.from({ length: 25 }, (_, i) => ({
    timestamp: 1727010000 + i * 60,
    open: 1.08,
    high: 1.09,
    low: 1.07,
    close: 1.085,
    closed: false,
  }));

  // Candle aberto deve retornar null
  const resOpen = engine.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles: openCandles,
    isReady: true,
  });
  assert.equal(resOpen, null, "Candle aberto deve bloquear evaluate()");

  // dataState diferente de READY ou CANDLE_CLOSED deve retornar null
  const closedCandles = openCandles.map((c) => ({ ...c, closed: true }));
  const resStale = engine.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles: closedCandles,
    dataState: "STALE",
  });
  assert.equal(resStale, null, "dataState STALE deve bloquear evaluate()");
});

test("Strategy Engine: Deduplicação e garantia somente leitura", () => {
  const engine = new StrategyEngine();
  // Garante que o motor não expõe métodos de execução
  assert.equal(typeof engine.executeOrder, "undefined");
  assert.equal(typeof engine.send, "undefined");
  assert.equal(typeof engine.buy, "undefined");
});
