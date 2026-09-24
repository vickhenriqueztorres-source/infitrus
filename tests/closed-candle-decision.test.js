import test from "node:test";
import assert from "node:assert/strict";
import { SignalDeduplicator } from "../src/strategy/signal-deduplicator.js";
import { CandleStore } from "../src/market/candle-store.js";
import { MarketAnalyzer } from "../src/content/analyzer.js";
import { StrategyEngine } from "../src/strategy/strategy-engine.js";
import { Phase } from "../src/strategy/signal-lifecycle.js";
import { marketClock } from "../src/utils/market-clock.js";
import { rec, swGetRecords, swResetRecords } from "../src/diagnostics/flight-recorder.js";

test("Deduplicação Infalível: Chave canônica do PRD e persistência em memória", () => {
  const dedup = new SignalDeduplicator({ maxMemorySize: 50 });
  const key1 = dedup.buildKey("EURUSD", 60, 1727010000, "v2.0");
  assert.equal(key1, "EURUSD:60:1727010000:v2.0");

  assert.equal(dedup.has(key1), false);
  dedup.record(key1, { action: "CALL", price: 1.0850 });
  assert.equal(dedup.has(key1), true);
  assert.equal(dedup.get(key1).action, "CALL");

  // Chave com outro par ou timestamp é independente
  const key2 = dedup.buildKey("BTCUSD", 60, 1727010000, "v2.0");
  assert.equal(dedup.has(key2), false);

  const key3 = dedup.buildKey("EURUSD", 60, 1727010060, "v2.0");
  assert.equal(dedup.has(key3), false);
});

test("CandleStore: candle.closed só vira true APÓS mudança de timestamp", () => {
  const store = new CandleStore();
  const t0 = 1727010000;

  // 1. Primeiro tick inicializa vela aberta
  const r1 = store.ingest({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: t0,
    open: 1.0850,
    high: 1.0855,
    low: 1.0848,
    close: 1.0852,
    closed: false,
    receivedAt: 1000,
  });
  assert.equal(r1.status, "INITIALIZED");
  assert.equal(store.getLast("EURUSD", 60).closed, false);

  // 2. Múltiplos ticks intrabar no mesmo timestamp NUNCA fecham a vela
  for (let s = 1; s <= 59; s++) {
    const rUpdate = store.ingest({
      symbol: "EURUSD",
      timeframeSeconds: 60,
      timestamp: t0,
      open: 1.0850,
      high: 1.0860,
      low: 1.0845,
      close: 1.0850 + (s * 0.00001),
      closed: s === 59, // mesmo se payload externo tentar marcar closed=true no segundo 59
      receivedAt: 1000 + s * 1000,
    });
    assert.equal(rUpdate.status, "UPDATED");
    assert.equal(store.getLast("EURUSD", 60).closed, false, `Vela fechou prematuramente no segundo ${s}`);
  }

  // 3. Somente na virada do timestamp (t0 + 60) a vela anterior é formalmente fechada
  const rNew = store.ingest({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: t0 + 60,
    open: 1.0856,
    high: 1.0858,
    low: 1.0854,
    close: 1.0855,
    closed: false,
    receivedAt: 61000,
  });
  assert.equal(rNew.status, "NEW_CANDLE");
  assert.equal(rNew.closedCandle.timestamp, t0);
  assert.equal(rNew.closedCandle.closed, true, "Vela anterior deve estar formalmente fechada (closed=true)");
  assert.equal(rNew.candle.closed, false, "Nova vela deve estar aberta (closed=false)");
});

test("Flight Recorder: Bloqueio estrito de ticks intrabar (DECIDE_BLOCKED)", () => {
  const analyzer = new MarketAnalyzer();
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "EURUSD", tf: 60 });
  const t0 = 1727010000;

  // Ingestão inicial
  analyzer.processRealtimePayload({
    pair: "EURUSD",
    messages: [{ data: { time: t0 * 1000, open: 1.0850, high: 1.0855, low: 1.0848, close: 1.0852 } }],
  });

  // Tick intrabar (mesmo timestamp)
  const countBefore = swGetRecords().filter((e) => e.type === "DECIDE_BLOCKED").length;

  analyzer.processRealtimePayload({
    pair: "EURUSD",
    messages: [{ data: { time: t0 * 1000 + 15000, open: 1.0850, high: 1.0858, low: 1.0848, close: 1.0856 } }],
  });

  const countAfter = swGetRecords().filter((e) => e.type === "DECIDE_BLOCKED").length;
  assert.ok(countAfter > countBefore, "Tick intrabar deve gerar evento DECIDE_BLOCKED no Flight Recorder");

  const lastBlocked = swGetRecords().filter((e) => e.type === "DECIDE_BLOCKED").pop();
  assert.equal(lastBlocked.payload.par, "EURUSD");
  assert.equal(lastBlocked.payload.closed, false);
  assert.equal(lastBlocked.payload.reason, "INTRABAR_TICK");

  analyzer.destroy();
});

test("Gatilho de decisão em candle fechado: SIGNAL_EMIT e deduplicação SIGNAL_SKIP", async () => {
  const analyzer = new MarketAnalyzer();
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "EURUSD", tf: 60 });
  const t0 = 1727010000;

  // Carrega 30 candles históricos confirmados para aquecimento até t0
  const bars = [];
  for (let i = 0; i < 30; i++) {
    const ts = t0 - (29 - i) * 60;
    bars.push({ time: ts, open: 1.0850, high: 1.0860, low: 1.0840, close: 1.0855 });
  }
  analyzer.processHistoryPayload({ bars }, { pair: "EURUSD", tf: 60 });

  // Força decisão determinística de compra para o teste
  analyzer.registry.get("EURUSD").evaluate = () => ({
    action: "CALL",
    probability: 0.72,
    subStrategy: "MOMENTUM_BREAKOUT",
    strategyName: "CONTINUATION",
    reasons: ["Rompimento confirmado de candle fechado"],
  });

  const countEmitBefore = swGetRecords().filter((e) => e.type === "SIGNAL_EMIT").length;

  // Fecha candle t0 e abre t0 + 60
  await analyzer.processRealtimePayload({
    pair: "EURUSD",
    messages: [{ data: { time: (t0 + 60) * 1000, open: 1.0860, high: 1.0862, low: 1.0858, close: 1.0861 } }],
  });

  const countEmitAfter = swGetRecords().filter((e) => e.type === "SIGNAL_EMIT").length;
  assert.equal(countEmitAfter, countEmitBefore + 1, "Deve gerar exatamente 1 SIGNAL_EMIT no candle fechado");

  const emitEvent = swGetRecords().filter((e) => e.type === "SIGNAL_EMIT").pop();
  assert.equal(emitEvent.payload.par, "EURUSD");
  assert.equal(emitEvent.payload.action, "CALL");
  assert.ok(emitEvent.payload.chave.includes("EURUSD:60:"));

  // Tentativa de reprocessar o mesmo candle fechado deve gerar SIGNAL_SKIP
  const countSkipBefore = swGetRecords().filter((e) => e.type === "SIGNAL_SKIP").length;
  const closedCandleMock = { symbol: "EURUSD", timeframeSeconds: 60, timestamp: t0, closed: true, close: 1.0855 };
  const newCandleMock = { symbol: "EURUSD", timeframeSeconds: 60, timestamp: t0 + 60, open: 1.0860 };

  await analyzer._evaluateOnClosedCandle("EURUSD", 60, closedCandleMock, newCandleMock);

  const countSkipAfter = swGetRecords().filter((e) => e.type === "SIGNAL_SKIP").length;
  assert.equal(countSkipAfter, countSkipBefore + 1, "Segunda avaliação do mesmo candle deve ser ignorada via SIGNAL_SKIP");

  analyzer.destroy();
});

test("Imutabilidade: Sinal em IN_TRADE não sofre repainting durante ticks intrabar", async () => {
  const analyzer = new MarketAnalyzer();
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "EURUSD", tf: 60 });
  const t0 = 1727013600; // Alinhado ao minuto (múltiplo de 60s)

  // Carrega histórico até t0
  const bars = [];
  for (let i = 0; i < 30; i++) {
    bars.push({ time: t0 - (29 - i) * 60, open: 1.0850, high: 1.0860, low: 1.0840, close: 1.0855 });
  }
  analyzer.processHistoryPayload({ bars }, { pair: "EURUSD", tf: 60 });

  // Mock retorna CALL
  analyzer.registry.get("EURUSD").evaluate = () => ({
    action: "CALL",
    probability: 0.68,
    subStrategy: "REVERSION",
  });

  const originalNow = marketClock._now;
  let simulatedTime = (t0 + 60) * 1000;
  marketClock._now = () => simulatedTime;

  // Abre nova vela em t0 + 60 (emite sinal CALL para a vela t0 + 60)
  await analyzer.processRealtimePayload({
    pair: "EURUSD",
    messages: [{ data: { time: (t0 + 60) * 1000, open: 1.0860, high: 1.0861, low: 1.0859, close: 1.0860 } }],
  });

  // Verifica que o lifecycle está em ENTRY_NOW
  let snap = analyzer.lifecycle.snapshot("EURUSD", 60, t0 + 60);
  assert.ok(snap.trade, "Trade ativo deve existir no segundo 0");
  assert.equal(snap.trade.phase, Phase.ENTRY_NOW);
  assert.equal(snap.trade.direction, "CALL");

  // Avança tempo para segundo 20 da vela (fase IN_TRADE)
  simulatedTime = (t0 + 80) * 1000;
  snap = analyzer.lifecycle.step({ pair: "EURUSD", tf: 60, nowSec: t0 + 80, dataOk: true });
  assert.equal(snap.trade.phase, Phase.IN_TRADE);
  assert.equal(snap.trade.direction, "CALL");

  // Agora manda múltiplos ticks intrabar violentos na direção contrária (PUT)
  for (let s = 21; s <= 58; s++) {
    simulatedTime = (t0 + 60 + s) * 1000;
    await analyzer.processRealtimePayload({
      pair: "EURUSD",
      messages: [{ data: { time: (t0 + 60) * 1000 + s * 1000, open: 1.0860, high: 1.0860, low: 1.0810, close: 1.0815 } }],
    });

    const stepSnap = analyzer.lifecycle.step({ pair: "EURUSD", tf: 60, nowSec: t0 + 60 + s, dataOk: true });
    assert.equal(stepSnap.trade.direction, "CALL", `Sinal inverteu no segundo ${s}!`);
    assert.equal(stepSnap.trade.phase, Phase.IN_TRADE);
  }

  // No segundo 60 com vela fechada, sinal é liquidado formalmente
  simulatedTime = (t0 + 120) * 1000;
  await analyzer.processRealtimePayload({
    pair: "EURUSD",
    messages: [{ data: { time: (t0 + 120) * 1000, open: 1.0815, high: 1.0820, low: 1.0810, close: 1.0818 } }],
  });

  const settledSnap = analyzer.lifecycle.snapshot("EURUSD", 60, t0 + 121);
  assert.equal(settledSnap.lastResult.phase, Phase.SETTLED);
  assert.equal(settledSnap.lastResult.result, "LOSS"); // close 1.0815 < entry 1.0860

  marketClock._now = originalNow;
  analyzer.destroy();
});

test("Replay de voo: Zero recálculo após candle fechado", async () => {
  const analyzer = new MarketAnalyzer();
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "ARBITRIUM", tf: 60 });
  const t0 = 1727010000;

  // 1. Simulação de replay de ticks de voo gravados
  const flightTicks = [
    // Vela 1 em andamento
    { time: t0 * 1000 + 45000, open: 500.0, high: 500.2, low: 499.8, close: 500.1 },
    { time: t0 * 1000 + 50000, open: 500.0, high: 500.3, low: 499.8, close: 500.2 },
    { time: t0 * 1000 + 55000, open: 500.0, high: 500.4, low: 499.8, close: 500.3 },
    // Virada para Vela 2 (Fechamento da Vela 1)
    { time: (t0 + 60) * 1000, open: 500.3, high: 500.5, low: 500.2, close: 500.4 },
    // Vela 2 em andamento
    { time: (t0 + 60) * 1000 + 10000, open: 500.3, high: 500.6, low: 500.2, close: 500.5 },
    { time: (t0 + 60) * 1000 + 30000, open: 500.3, high: 500.7, low: 500.1, close: 500.2 },
    { time: (t0 + 60) * 1000 + 50000, open: 500.3, high: 500.7, low: 500.0, close: 500.1 },
    // Virada para Vela 3 (Fechamento da Vela 2)
    { time: (t0 + 120) * 1000, open: 500.1, high: 500.3, low: 500.0, close: 500.2 },
  ];

  let evalCallCount = 0;
  analyzer.registry.get("ARBITRIUM").evaluate = () => {
    evalCallCount++;
    return { action: "WAIT", probability: 0.5 };
  };

  // Executa o replay
  for (const tick of flightTicks) {
    await analyzer.processRealtimePayload({
      pair: "ARBITRIUM",
      messages: [{ data: tick }],
    });
  }

  // evaluate() deve ser chamado EXATAMENTE no fechamento da vela 1 e no fechamento da vela 2 (total 2 vezes)
  // e NUNCA durante os ticks intrabar (45s, 50s, 55s, 10s, 30s, 50s)!
  assert.equal(evalCallCount, 2, `Esperado exatamente 2 avaliações em fechamento, obtido: ${evalCallCount}`);

  analyzer.destroy();
});
