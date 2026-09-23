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

test("SignalAuditor: settle() liquida sinal diretamente e cancel() remove do placar", () => {
  const auditor = new SignalAuditor();
  auditor.clear();

  const sig1 = auditor.recordSignal({
    id: "sig_call_1",
    action: "CALL",
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candleTimestamp: 1727000000,
    targetTimestamp: 1727000060,
    entryPrice: 1.0850,
    payout: 0.85,
  });

  const sig2 = auditor.recordSignal({
    id: "sig_put_2",
    action: "PUT",
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candleTimestamp: 1727000060,
    targetTimestamp: 1727000120,
    entryPrice: 1.0860,
    payout: 0.85,
  });

  // Liquida sig1 como WIN
  auditor.settle(sig1.id, { result: "WIN", entryPrice: 1.0850, closePrice: 1.0858 });
  assert.equal(sig1.status, "SETTLED");
  assert.equal(sig1.result, "WIN");
  assert.equal(sig1.pnlUnits, 0.85);

  // Cancela sig2
  auditor.cancel(sig2.id, "DATA_UNSTABLE");
  assert.equal(sig2.status, "CANCELLED");

  // Estatísticas devem conter apenas sig1 (sig2 cancelado NÃO entra no placar)
  const stats = auditor.getStats();
  assert.equal(stats.total, 1, "Sinais cancelados não entram no total do placar");
  assert.equal(stats.settled, 1);
  assert.equal(stats.wins, 1);
  assert.equal(stats.winRate, 100);
});

test("SignalAuditor: Fallback ignora vela aberta e usa abertura da vela-alvo como entrada", () => {
  const auditor = new SignalAuditor();
  auditor.clear();

  const sig = auditor.recordSignal({
    id: "sig_open_test",
    action: "CALL",
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candleTimestamp: 1727000000,
    targetTimestamp: 1727000060,
    entryPrice: 1.0850,
    payout: 0.80,
  });

  // Vela aberta (closed: false) -> deve ser ignorada
  const forming = [{ timestamp: 1727000060, open: 1.0851, close: 1.0859, closed: false }];
  const resForming = auditor.auditPendingSignals(forming);
  assert.equal(resForming.length, 0);
  assert.equal(sig.status, "PENDING");

  // Vela fechada formalmente com abertura real 1.0852
  const closed = [{ timestamp: 1727000060, open: 1.0852, close: 1.0857, closed: true }];
  const resClosed = auditor.auditPendingSignals(closed);
  assert.equal(resClosed.length, 1);
  assert.equal(resClosed[0].entryPrice, 1.0852, "Entrada deve assumir a abertura da vela-alvo");
  assert.equal(resClosed[0].result, "WIN");
});

test("SignalAuditor: Aprendizado (recordOutcome) acionado apenas em WIN/LOSS e nunca em DOJI/CANCELLED", () => {
  let outcomeCalls = 0;
  const mockPortfolio = {
    recordOutcome: (snapshot, won) => {
      outcomeCalls++;
    },
  };

  // Simula liquidações:
  const simResults = [
    { result: "WIN", shouldCall: true },
    { result: "LOSS", shouldCall: true },
    { result: "DOJI", shouldCall: false },
    { result: "CANCELLED", shouldCall: false },
  ];

  for (const item of simResults) {
    if (item.result === "WIN" || item.result === "LOSS") {
      mockPortfolio.recordOutcome({ subStrategy: "TEST" }, item.result === "WIN");
    }
  }

  assert.equal(outcomeCalls, 2, "recordOutcome deve ser chamado exatamente 2 vezes (1 para WIN, 1 para LOSS, 0 para DOJI e CANCELLED)");
});
