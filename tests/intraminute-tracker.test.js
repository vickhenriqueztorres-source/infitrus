/**
 * intraminute-tracker.test.js - Testes do Rastreador de Microestrutura Intraminuto
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";
import { IntraminuteTracker } from "../src/market/intraminute-tracker.js";

test("IntraminuteTracker: Ingestão de ticks e cálculo de pressão e velocidade", () => {
  const tracker = new IntraminuteTracker();
  const symbol = "EURUSD";
  const tf = 60;
  const candleTs = 1727010000;
  const startMs = 1727010000000;

  // Simula fluxo contínuo de subida acelerada (pressão compradora)
  // Preços subindo de 1.0800 até 1.0850 em 30 ticks
  for (let i = 0; i < 30; i++) {
    const price = 1.0800 + i * 0.00015;
    const timeMs = startMs + i * 1500;
    tracker.recordTick(symbol, tf, price, candleTs, timeMs);
  }

  const metrics = tracker.computeMetrics(tracker.series.get("EURUSD:60").ticks, 1.0800, 1.0850, 1.0800, 1.0845);

  assert.equal(metrics.tickCount, 30);
  assert.ok(metrics.uptickCount > 25, "Maioria dos ticks deve ser de alta");
  assert.equal(metrics.downtickCount, 0);
  assert.ok(metrics.pressure > 0.90, `Pressão deve ser fortemente positiva, obtido: ${metrics.pressure}`);
  assert.ok(metrics.tickArrivalRate > 0, "Taxa de chegada de ticks deve ser positiva");
  assert.ok(metrics.timeNearHighRatio >= 0.15, "Deve ter passado tempo próximo da máxima");
});

test("IntraminuteTracker: Selagem no fechamento da vela e isolamento por símbolo", () => {
  const tracker = new IntraminuteTracker();
  const tf = 60;
  const ts1 = 1727010000;
  const ts2 = 1727010060;

  // Ingestão no EURUSD
  tracker.recordTick("EURUSD", tf, 1.0810, ts1, 1727010010000);
  tracker.recordTick("EURUSD", tf, 1.0815, ts1, 1727010020000);

  // Ingestão concorrente no AUDUSD
  tracker.recordTick("AUDUSD", tf, 0.6550, ts1, 1727010015000);
  tracker.recordTick("AUDUSD", tf, 0.6540, ts1, 1727010025000);

  // Nova vela no EURUSD (ts2) deve selar ts1
  tracker.recordTick("EURUSD", tf, 1.0820, ts2, 1727010061000);

  const sealedEur = tracker.getClosedMetrics("EURUSD", tf, ts1);
  assert.ok(sealedEur, "Deve ter métricas seladas para EURUSD na vela ts1");
  assert.equal(sealedEur.symbol, "EURUSD");

  // AUDUSD ainda está na vela ts1
  const audData = tracker.series.get("AUDUSD:60");
  assert.equal(audData.currentCandleTimestamp, ts1);
});
