import test from "node:test";
import assert from "node:assert/strict";

import { SignalAuditor } from "../src/strategy/signal-auditor.js";

test("SignalAuditor: Gravação de sinal pendente e auditoria em t+1 (WIN)", () => {
  const auditor = new SignalAuditor();
  auditor.clear();

  // Registra sinal CALL no timestamp 1727000000 com preço 1.0850 e payout 0.80
  const record = auditor.recordSignal({
    action: "CALL",
    label: "CALL (Contexto)",
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candleTimestamp: 1727000000,
    entryPrice: 1.0850,
    probability: 0.60,
    ev: 0.08,
    payout: 0.80,
    isConfluence: false,
    primaryStrategyName: "Contexto Bayesiano",
    reasons: ["Vantagem estatística"],
  });

  assert.ok(record !== null);
  assert.equal(record.status, "PENDING");
  assert.equal(record.targetTimestamp, 1727000060);

  // Simula chegada do candle seguinte (timestamp 1727000060) com alta (fechamento 1.0855 > 1.0850)
  const closedCandles = [
    { timestamp: 1727000000, close: 1.0850 },
    { timestamp: 1727000060, close: 1.0855 },
  ];

  const settled = auditor.auditPendingSignals(closedCandles);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, "SETTLED");
  assert.equal(settled[0].result, "WIN");
  assert.equal(settled[0].pnlUnits, 0.80);

  const stats = auditor.getStats();
  assert.equal(stats.total, 1);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 0);
  assert.equal(stats.winRate, 100);
  assert.equal(stats.netProfitUnits, 0.80);
});

test("SignalAuditor: Auditoria em t+1 de LOSS e DOJI", () => {
  const auditor = new SignalAuditor();
  auditor.clear();

  // Sinal 1: PUT no timestamp 1727000100 com entrada 1.0860
  auditor.recordSignal({
    action: "PUT",
    label: "PUT (Markov)",
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candleTimestamp: 1727000100,
    entryPrice: 1.0860,
    probability: 0.58,
    ev: 0.044,
    payout: 0.80,
    isConfluence: false,
  });

  // Sinal 2: CALL no timestamp 1727000200 com entrada 1.0870
  auditor.recordSignal({
    action: "CALL",
    label: "CALL (k-NN)",
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candleTimestamp: 1727000200,
    entryPrice: 1.0870,
    probability: 0.62,
    ev: 0.116,
    payout: 0.80,
    isConfluence: true,
    confluence: { count: 3, total: 5 },
  });

  // Candlestick 1 alvo (1727000160) fecha em ALTA (1.0865 > 1.0860) => PUT perde (LOSS)
  // Candlestick 2 alvo (1727000260) fecha IGUAL (1.0870 == 1.0870) => DOJI
  const closedCandles = [
    { timestamp: 1727000160, close: 1.0865 },
    { timestamp: 1727000260, close: 1.0870 },
  ];

  const settled = auditor.auditPendingSignals(closedCandles);
  assert.equal(settled.length, 2);

  const sig1 = settled.find((s) => s.direction === "PUT");
  assert.equal(sig1.result, "LOSS");
  assert.equal(sig1.pnlUnits, -1.0);

  const sig2 = settled.find((s) => s.direction === "CALL");
  assert.equal(sig2.result, "DOJI");
  assert.equal(sig2.pnlUnits, 0.0);

  const stats = auditor.getStats();
  assert.equal(stats.total, 2);
  assert.equal(stats.losses, 1);
  assert.equal(stats.dojis, 1);
  assert.equal(stats.wins, 0);
  assert.equal(stats.netProfitUnits, -1.0);
});
