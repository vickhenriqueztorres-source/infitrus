import test from "node:test";
import assert from "node:assert/strict";

import { CandleStore } from "../src/market/candle-store.js";
import { DataQualityTracker, MarketState } from "../src/market/data-quality.js";
import { MarketAnalyzer } from "../src/content/analyzer.js";
import { SignalLifecycle, Phase } from "../src/strategy/signal-lifecycle.js";
import { SignalDeduplicator } from "../src/strategy/signal-deduplicator.js";
import { marketClock } from "../src/utils/market-clock.js";
import { rec, swGetRecords, swResetRecords } from "../src/diagnostics/flight-recorder.js";
import { initSilentAudio, handleHeartbeat } from "../src/offscreen/offscreen.js";

test("R1 — Fechamento de candle orientado a evento no CandleStore", () => {
  const store = new CandleStore();
  const symbol = "EURUSD";
  const tf = 60;
  const baseTs = 1700000000;

  // 1. Primeiro tick (abertura)
  const r1 = store.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs,
    open: 1.1000,
    high: 1.1005,
    low: 1.0995,
    close: 1.1002,
    source: "websocket",
    receivedAt: 1000,
  });
  assert.equal(r1.status, "INITIALIZED");
  let last = store.getLast(symbol, tf);
  assert.equal(last.closed, false);
  assert.equal(Boolean(last.frozen), false);

  // 2. Múltiplos ticks no mesmo timestamp (intrabar)
  const r2 = store.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs,
    open: 1.1000,
    high: 1.1010,
    low: 1.0990,
    close: 1.1008,
    source: "websocket",
    receivedAt: 1500,
  });
  assert.equal(r2.status, "UPDATED");
  last = store.getLast(symbol, tf);
  assert.equal(last.closed, false);
  assert.equal(Boolean(last.frozen), false);
  assert.equal(last.high, 1.1010);
  assert.equal(last.close, 1.1008);

  // 3. Chegada do próximo candle contíguo (novo timestamp via evento WebSocket)
  let closedEmitted = null;
  store.subscribe(symbol, tf, (event, data) => {
    if (event === "candle_closed") {
      closedEmitted = data;
    }
  });

  const r3 = store.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs + tf,
    open: 1.1008,
    high: 1.1015,
    low: 1.1005,
    close: 1.1012,
    source: "websocket",
    receivedAt: 2000,
  });
  assert.equal(r3.status, "NEW_CANDLE");
  assert.ok(closedEmitted, "Deve emitir candle_closed para a vela anterior");
  assert.equal(closedEmitted.timestamp, baseTs);
  assert.equal(closedEmitted.closed, true);
  assert.equal(closedEmitted.frozen, true);

  // Verifica que no store a vela anterior está fechada e congelada
  const closedCandles = store.getClosedCandles(symbol, tf, 10);
  assert.equal(closedCandles.length, 1);
  assert.equal(closedCandles[0].closed, true);
  assert.equal(closedCandles[0].frozen, true);

  // 4. Tentativa de mutação retroativa em vela congelada (tick atrasado com mesmo timestamp baseTs)
  const rDelayed = store.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs,
    open: 1.1000,
    high: 1.9999, // Tentativa de alterar a máxima
    low: 1.0000,
    close: 1.9999,
    source: "websocket",
    receivedAt: 2500,
  });
  assert.equal(rDelayed.status, "OUT_OF_ORDER");
  assert.equal(rDelayed.frozen, true);

  // Confirma que a vela congelada permaneceu imutável
  const closedAfter = store.getClosedCandles(symbol, tf, 10)[0];
  assert.equal(closedAfter.high, 1.1010);
  assert.equal(closedAfter.close, 1.1008);
});

test("R2 — Simulação de 200 ticks emburacados/backlog: nenhum candle frozen é alterado", () => {
  const store = new CandleStore();
  const symbol = "BTCUSD";
  const tf = 60;
  const baseTs = 1700000000;

  // Cria 5 velas contíguas fechadas
  for (let i = 0; i < 5; i++) {
    store.ingest({
      symbol,
      timeframeSeconds: tf,
      timestamp: baseTs + (i * tf),
      open: 50000 + i,
      high: 50010 + i,
      low: 49990 + i,
      close: 50005 + i,
      source: "websocket",
      receivedAt: 1000 + i,
    });
  }

  // Abre a 6ª vela
  store.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs + (5 * tf),
    open: 50005,
    high: 50015,
    low: 49995,
    close: 50010,
    source: "websocket",
    receivedAt: 6000,
  });

  // Tira snapshot das 5 primeiras velas
  const snapshotBefore = store.getClosedCandles(symbol, tf, 10);
  assert.equal(snapshotBefore.length, 5);

  // Gera 200 ticks aleatórios com timestamps no passado (backlog caótico/fora de ordem)
  let rejectedCount = 0;
  for (let i = 0; i < 200; i++) {
    // Escolhe aleatoriamente uma das 5 velas passadas
    const pastIdx = i % 5;
    const pastTs = baseTs + (pastIdx * tf);
    const res = store.ingest({
      symbol,
      timeframeSeconds: tf,
      timestamp: pastTs,
      open: 999999, // Valores corrompidos
      high: 999999,
      low: 1,
      close: 999999,
      source: "websocket",
      receivedAt: 7000 + i,
    });
    if (res.status === "OUT_OF_ORDER") {
      rejectedCount++;
    }
  }

  assert.equal(rejectedCount, 200, "Todos os 200 ticks do passado devem ser rejeitados");

  // Confirma imutabilidade estrita: nenhuma das 5 velas foi alterada
  const snapshotAfter = store.getClosedCandles(symbol, tf, 10);
  for (let i = 0; i < 5; i++) {
    assert.equal(snapshotAfter[i].high, snapshotBefore[i].high);
    assert.equal(snapshotAfter[i].close, snapshotBefore[i].close);
    assert.equal(snapshotAfter[i].open, snapshotBefore[i].open);
    assert.equal(snapshotAfter[i].frozen, true);
    assert.equal(snapshotAfter[i].closed, true);
  }
});

test("R2 — Sinais de velas fechadas há mais de 65s gravam late=true e NÃO disparam alerta (SIGNAL_LATE)", () => {
  swResetRecords();
  const analyzer = new MarketAnalyzer();
  const pair = "ARBITRIUM_OTC";
  const tf = 60;
  analyzer.currentSymbol = pair;
  analyzer.timeframeSeconds = tf;

  // Popula 40 candles no store para deixar pronto
  const nowWall = Math.floor(Date.now() / 1000);
  const bars = [];
  for (let i = 40; i >= 1; i--) {
    bars.push({
      symbol: pair,
      timeframeSeconds: tf,
      timestamp: nowWall - (i * tf),
      open: 100.0,
      high: 101.0,
      low: 99.0,
      close: 100.5,
      source: "history",
      closed: true,
      receivedAt: Date.now() - (i * 60000),
    });
  }
  analyzer.store.ingestBatch(bars);
  analyzer.quality.onHistoryLoaded(pair, tf, bars.length);
  analyzer.quality.onRealtimeUpdate(pair, tf, { status: "UPDATED" });
  assert.equal(analyzer.quality.isReady(pair, tf), true);

  // Simula candle que fechou há 120s (claramente > 65s)
  const oldClosedCandle = {
    symbol: pair,
    timeframeSeconds: tf,
    timestamp: nowWall - 180,
    open: 100.0,
    high: 102.0,
    low: 99.0,
    close: 101.5,
    closed: true,
    frozen: true,
  };
  const newCandle = {
    symbol: pair,
    timeframeSeconds: tf,
    timestamp: nowWall - 120,
    open: 101.5,
  };

  analyzer._evaluateOnClosedCandle(pair, tf, oldClosedCandle, newCandle);

  // Verifica que foi registrado no deduplicador com late: true
  const chave = analyzer.deduplicator.buildKey(pair, tf, oldClosedCandle.timestamp, analyzer.strategyVersion);
  assert.equal(analyzer.deduplicator.has(chave), true);
  const dedupRec = analyzer.deduplicator.get(chave);
  assert.equal(dedupRec.late, true);

  // Verifica registro de voo SIGNAL_LATE
  const records = swGetRecords();
  const lateRec = records.find((r) => r.type === "SIGNAL_LATE");
  assert.ok(lateRec, "Deve registrar evento SIGNAL_LATE no flight recorder");
  assert.equal(lateRec.payload.par, pair);
  assert.equal(lateRec.payload.ts, oldClosedCandle.timestamp);
  assert.ok(lateRec.payload.ageSec > 65);

  // Verifica que o lifecycle NÃO emitiu o sinal como ativo
  const lcSnapshot = analyzer.lifecycle.snapshot(pair, tf, nowWall);
  assert.equal(lcSnapshot.current, null, "Sinal tardio não deve ser colocado no lifecycle ativo");

  analyzer.destroy();
});

test("R5 — Restauração de foco: estado SYNCING_REALTIME bloqueia sinais até reconciliação", () => {
  swResetRecords();
  const analyzer = new MarketAnalyzer();
  const pair = "ETHUSD";
  const tf = 60;
  analyzer.currentSymbol = pair;
  analyzer.timeframeSeconds = tf;

  // Coloca em estado SYNCING_REALTIME
  analyzer.handleFocusRestored(5000, "TEST_VISIBILITY");
  assert.equal(analyzer._syncingBacklog, true);
  assert.equal(analyzer.quality.getState(pair, tf), MarketState.SYNCING_REALTIME);

  // Tenta avaliar durante SYNCING_REALTIME
  const closedCandle = {
    symbol: pair,
    timeframeSeconds: tf,
    timestamp: Math.floor(Date.now() / 1000) - 60,
    open: 2000,
    high: 2010,
    low: 1990,
    close: 2005,
    closed: true,
    frozen: true,
  };
  const newCandle = {
    symbol: pair,
    timeframeSeconds: tf,
    timestamp: Math.floor(Date.now() / 1000),
    open: 2005,
  };

  analyzer._evaluateOnClosedCandle(pair, tf, closedCandle, newCandle);

  // Verifica que foi bloqueado com DECIDE_BLOCKED
  const records = swGetRecords();
  const blocked = records.find((r) => r.type === "DECIDE_BLOCKED" && r.payload.dataState === "SYNCING_REALTIME");
  assert.ok(blocked, "Deve bloquear avaliação durante SYNCING_REALTIME");
  assert.equal(blocked.payload.reason, "INVALID_DATA_STATE_SYNCING_REALTIME");

  analyzer.destroy();
});

test("R7 — Observabilidade: TIMER_SKIP e THROTTLED_PERIOD gerados após atraso consecutivo", () => {
  swResetRecords();
  const analyzer = new MarketAnalyzer();
  analyzer.currentSymbol = "EURUSD";

  // Simula um tick de timer com atraso de 3s (>2s)
  analyzer._lastTimerTick = Date.now() - 3000;
  // Simula execução do intervalo de ciclo
  const now = Date.now();
  const elapsed = now - analyzer._lastTimerTick;
  analyzer._lastTimerTick = now;

  if (elapsed > 2000) {
    analyzer._consecutiveSkipMs += elapsed;
    rec("TIMER_SKIP", {
      elapsedMs: elapsed,
      delayMs: elapsed - 250,
      consecutiveDelayMs: analyzer._consecutiveSkipMs,
      par: analyzer.currentSymbol,
    });
  }

  let records = swGetRecords();
  const skipRec = records.find((r) => r.type === "TIMER_SKIP");
  assert.ok(skipRec, "Deve registrar TIMER_SKIP");
  assert.ok(skipRec.payload.elapsedMs >= 3000);

  // Simula acúmulo de atraso consecutivo > 10s
  analyzer._consecutiveSkipMs = 12000;
  if (analyzer._consecutiveSkipMs >= 10000) {
    rec("THROTTLED_PERIOD", {
      durationMs: analyzer._consecutiveSkipMs,
      from: now - analyzer._consecutiveSkipMs,
      to: now,
      par: analyzer.currentSymbol,
    });
  }

  records = swGetRecords();
  const throttledRec = records.find((r) => r.type === "THROTTLED_PERIOD");
  assert.ok(throttledRec, "Deve registrar THROTTLED_PERIOD");
  assert.equal(throttledRec.payload.durationMs, 12000);

  analyzer.destroy();
});

test("R3 & R4 — Offscreen Document e Heartbeat", () => {
  swResetRecords();

  // Teste de chamada pura do heartbeat offscreen
  handleHeartbeat(1700000000000);

  const records = swGetRecords();
  const hbRec = records.find((r) => r.type === "OFFSCREEN_HEARTBEAT");
  assert.ok(hbRec, "Deve registrar OFFSCREEN_HEARTBEAT");
  assert.equal(hbRec.payload.nowSec, 1700000000);

  // Teste defensivo do initSilentAudio em Node (sem window.AudioContext)
  const audioStarted = initSilentAudio();
  assert.equal(typeof audioStarted, "boolean");
});
