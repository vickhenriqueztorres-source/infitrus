/**
 * market-clock.test.js - Testes do Relógio Único de Mercado (MarketClock)
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MarketClock } from "../src/utils/market-clock.js";

test("MarketClock: a) offset estimado pela virada da vela", () => {
  let simulatedNow = 0;
  const clock = new MarketClock({ now: () => simulatedNow });

  const abertura = 1700000040; // segundos
  const receivedAt = abertura * 1000 + 350; // ms (recebido 350ms após a virada teórica)
  simulatedNow = receivedAt;

  const offset = clock.observeCandleOpen(abertura, receivedAt);
  assert.equal(offset, -350, `Offset inicial deve ser -350ms, obtido: ${offset}`);
  assert.equal(clock.secondInCandle(60), 0, `Segundo dentro da vela deve ser 0, obtido: ${clock.secondInCandle(60)}`);
});

test("MarketClock: b) amostra fora de ±3000 ms é ignorada", () => {
  let simulatedNow = 0;
  const clock = new MarketClock({ maxOffsetMs: 3000, now: () => simulatedNow });

  const abertura = 1700000040;
  // Amostra aberrante: 4000ms de diferença
  const receivedAt = abertura * 1000 + 4000;
  simulatedNow = receivedAt;

  const offset = clock.observeCandleOpen(abertura, receivedAt);
  assert.equal(offset, 0, "Amostra fora de ±3000ms deve ser ignorada mantendo offset anterior (0)");
  assert.equal(clock.samples, 0, "Contador de amostras não deve ser incrementado");
});

test("MarketClock: c) 29 s depois → secondInCandle = 29 e remainingInCandle = 31", () => {
  const abertura = 1700000040;
  let simulatedNow = abertura * 1000; // Alinhado perfeitamente
  const clock = new MarketClock({ now: () => simulatedNow });
  clock.observeCandleOpen(abertura, simulatedNow);

  // Avança o relógio local em 29 segundos (29.0s)
  simulatedNow += 29000;

  assert.equal(clock.secondInCandle(60), 29, `secondInCandle deve ser 29, obtido: ${clock.secondInCandle(60)}`);
  assert.equal(clock.remainingInCandle(60), 31, `remainingInCandle deve ser 31, obtido: ${clock.remainingInCandle(60)}`);
});

test("MarketClock: d) EMA: segunda amostra move o offset 30% em direção à nova amostra", () => {
  const clock = new MarketClock({ alpha: 0.3, maxOffsetMs: 3000 });

  const abertura1 = 1700000040;
  const receivedAt1 = abertura1 * 1000 + 200; // Sample 1 = -200ms
  clock.observeCandleOpen(abertura1, receivedAt1);
  assert.equal(clock.offsetMs, -200);

  // Segunda amostra: sample = -100ms
  // Novo offset = -200 + 0.3 * (-100 - (-200)) = -200 + 0.3 * 100 = -170ms
  const abertura2 = 1700000100;
  const receivedAt2 = abertura2 * 1000 + 100; // Sample 2 = -100ms
  clock.observeCandleOpen(abertura2, receivedAt2);

  assert.equal(Math.round(clock.offsetMs), -170, `Offset após EMA deve ser -170ms, obtido: ${clock.offsetMs}`);
  assert.equal(clock.samples, 2);
});
