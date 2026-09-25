/**
 * integrated-validation-matrix.test.js
 * Matriz de Validação Integrada para Homologação e Liberação Controlada (Etapa 9)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CandleStore } from "../src/market/candle-store.js";
import { SignalLifecycle } from "../src/strategy/signal-lifecycle.js";
import { SignalAuditor } from "../src/strategy/signal-auditor.js";
import { formatLifecycleCard } from "../src/ui/lifecycle-card.js";
import { soundsForTransition } from "../src/ui/sound-transitions.js";
import { SignalStore } from "../src/storage/signal-store.js";

test("Etapa 9 — Matriz 1: Concorrência multi-ativo com pré-sinais opostos simultâneos sem contaminação", () => {
  const lc = new SignalLifecycle();

  // Garante que o timestamp base esteja alinhado a um múltiplo exato de 60s
  const baseMinute = Math.floor(1727180000 / 60) * 60;
  const nowSec = baseMinute + 53; // Exatamente no segundo 53 dentro da janela 45-57s

  // Ativo A (EURUSD): Edge de Alta -> CALL
  const stepA = lc.step({
    pair: "EURUSD",
    tf: 60,
    nowSec,
    dataOk: true,
    decide: () => ({
      action: "CALL",
      edge: 0.035,
      conservativeProbability: 0.60,
      quality: 0.75,
      subStrategy: "MOMENTUM_BREAKOUT",
      symbol: "EURUSD",
    }),
  });

  // Ativo B (ARBITRIUM): Edge de Baixa -> PUT no mesmo instante
  const stepB = lc.step({
    pair: "ARBITRIUM",
    tf: 60,
    nowSec,
    dataOk: true,
    decide: () => ({
      action: "PUT",
      edge: 0.040,
      conservativeProbability: 0.62,
      quality: 0.78,
      subStrategy: "VOLATILITY_EXPANSION",
      symbol: "ARBITRIUM",
    }),
  });

  // Validação: Cada ativo retém sua direção e subestratégia sem colisão
  assert.equal(stepA.current.phase, "PRE_SIGNAL");
  assert.equal(stepA.current.direction, "CALL");
  assert.equal(stepA.current.pair, "EURUSD");

  assert.equal(stepB.current.phase, "PRE_SIGNAL");
  assert.equal(stepB.current.direction, "PUT");
  assert.equal(stepB.current.pair, "ARBITRIUM");

  // Formatação independente no card
  const cardA = formatLifecycleCard(stepA, nowSec);
  const cardB = formatLifecycleCard(stepB, nowSec);

  assert.equal(cardA.opportunityCard.direction, "CALL");
  assert.equal(cardA.opportunityCard.badgeClass, "call");

  assert.equal(cardB.opportunityCard.direction, "PUT");
  assert.equal(cardB.opportunityCard.badgeClass, "put");
});

test("Etapa 9 — Matriz 2: Ticks fora de ordem na vela N+1 não reabrem vela N nem causam repainting", () => {
  const store = new CandleStore();
  const tf = 60;
  const baseTs = Math.floor(1727180000 / 60) * 60;

  // Vela N
  store.ingest({
    symbol: "EURUSD",
    timeframeSeconds: tf,
    timestamp: baseTs,
    open: 1.0850,
    high: 1.0860,
    low: 1.0845,
    close: 1.0858,
  });

  // Virada para vela N+1 (fecha vela N)
  const resN1 = store.ingest({
    symbol: "EURUSD",
    timeframeSeconds: tf,
    timestamp: baseTs + tf,
    open: 1.0858,
    high: 1.0865,
    low: 1.0855,
    close: 1.0862,
  });
  assert.equal(resN1.status, "NEW_CANDLE");
  assert.equal(resN1.closedCandle.closed, true);

  const closedCandles = store.getClosedCandles("EURUSD", tf, 5);
  assert.equal(closedCandles.length, 1);
  const candleN = closedCandles[0];
  assert.equal(candleN.timestamp, baseTs);
  assert.equal(candleN.closed, true);
  const closeN = candleN.close;

  // Ingestão de múltiplos ticks dentro da vela N+1
  for (let i = 1; i <= 15; i++) {
    store.ingest({
      symbol: "EURUSD",
      timeframeSeconds: tf,
      timestamp: baseTs + tf,
      open: 1.0858,
      high: 1.0865 + i * 0.0001,
      low: 1.0855 - i * 0.0001,
      close: 1.0860,
    });
  }

  // Garante que a vela N anterior permanece 100% fechada e inalterada
  const closedCandlesAfter = store.getClosedCandles("EURUSD", tf, 5);
  const candleNAfter = closedCandlesAfter.find((c) => c.timestamp === baseTs);
  assert.ok(candleNAfter);
  assert.equal(candleNAfter.closed, true, "Vela N fechada NUNCA pode ter closed=false");
  assert.equal(candleNAfter.close, closeN, "Preço de fechamento da vela N deve ser estritamente imutável");
});

test("Etapa 9 — Matriz 3: Timeframe não suportado (> 60s) bloqueia sinais de forma segura", () => {
  const snapshot = {
    pair: "EURUSD",
    tf: 300, // M5 não suportado
    status: "BOOTING",
  };

  const card = formatLifecycleCard(snapshot, 1727180050);
  assert.equal(card.phase, "TF_NOT_SUPPORTED");
  assert.equal(card.badgeText, "TF NO SOPORTADO");
  assert.ok(card.primaryText.includes("usa M1"));
});

test("Etapa 9 — Matriz 4: Ciclo completo com DOJI, persistência de auditoria e som dedup", async () => {
  const store = new SignalStore({ dbName: "test_db_matrix4", storeName: "signals" });
  await store.clear();

  const auditor = new SignalAuditor();
  const id = "EURUSD:60:1727180060:1.0.0";

  // Registra sinal
  auditor.recordSignal({
    id,
    action: "CALL",
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candleTimestamp: 1727180060,
    entryPrice: 1.08500,
  });

  // Vela seguinte fecha em exato empate (DOJI: open = 1.08500, close = 1.08500)
  const settlingCandles = [
    {
      symbol: "EURUSD",
      timeframe: 60,
      timestamp: 1727180120,
      open: 1.08500,
      close: 1.08500,
      high: 1.08520,
      low: 1.08480,
      closed: true,
    }
  ];

  const audited = auditor.auditPendingSignals(settlingCandles);
  assert.equal(audited.length, 1);
  assert.equal(audited[0].result, "DOJI");

  // Persiste no SignalStore
  await store.putSignal({
    id,
    symbol: "EURUSD",
    timeframe: 60,
    candleTimestamp: 1727180060,
    action: "CALL",
    entryPrice: 1.08500,
    closePrice: 1.08500,
    result: "DOJI",
    status: "SETTLED",
    seq: 1,
    committed: true,
  });

  const stored = await store.getSignalById(id);
  assert.equal(stored.result, "DOJI");
  assert.equal(stored.status, "SETTLED");

  // Validação de som para DOJI (empate)
  const played = new Set();
  const lcDoji = { lastResult: { phase: "SETTLED", result: "DOJI", id } };
  const sounds = soundsForTransition(null, lcDoji, 60, played);
  assert.deepEqual(sounds, ["doji"], "Transição para DOJI deve emitir som 'doji'");

  // Deduplicação: chamar novamente com o mesmo ID não deve tocar som repetido
  const soundsDup = soundsForTransition(lcDoji, lcDoji, 60, played);
  assert.deepEqual(soundsDup, [], "Evento já reproduzido deve ser deduplicado");
});

test("Etapa 9 — Matriz 5: Correspondência estrita entre Snapshot, Lifecycle Card e Pill State", () => {
  const nowSec = 1727180055;
  const snapshot = {
    pair: "BTCUSD",
    tf: 60,
    trade: {
      phase: "IN_TRADE",
      direction: "CALL",
      entryPrice: 65000.0,
      targetTs: 1727180000,
      pair: "BTCUSD",
    },
    current: {
      phase: "PRE_SIGNAL",
      direction: "PUT",
      targetTs: 1727180060,
      pair: "BTCUSD",
    },
  };

  const card = formatLifecycleCard(snapshot, nowSec);

  // Validação das duas áreas independentes
  assert.equal(card.tradeCard.hasTrade, true);
  assert.equal(card.tradeCard.direction, "CALL");
  assert.equal(card.tradeCard.badgeClass, "call");

  assert.equal(card.opportunityCard.hasOpportunity, true);
  assert.equal(card.opportunityCard.direction, "PUT");
  assert.equal(card.opportunityCard.badgeClass, "put");

  // Nenhuma inversão prematura ou colisão de estado
  assert.notEqual(card.tradeCard.direction, card.opportunityCard.direction);
});
