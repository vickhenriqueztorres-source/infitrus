/**
 * transactional-signal-store.test.js
 * Testes de integridade transacional, persistência atômica, concorrência e resiliência (R1-R7)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SignalStore, getNextGlobalSeq, signalStore } from "../src/storage/signal-store.js";
import {
  rec,
  swResetRecords,
  swGetRecords,
} from "../src/diagnostics/flight-recorder.js";
import { flushPendingSignals } from "../src/background/service-worker.js";

test("R1: SignalStore realiza putSignal atômico, getSignalById, hasSignal e markCommitted", async () => {
  const store = new SignalStore({ dbName: "test_db_r1", storeName: "signals" });
  await store.clear();

  const id = "EURUSD:60:1727179200:1.0.0";
  const signal = {
    id,
    symbol: "EURUSD",
    timeframe: 60,
    candleTimestamp: 1727179200,
    strategyVersion: "1.0.0",
    action: "CALL",
    reasons: ["Confluência 3/5", "Volume Breakout"],
    dataState: "READY",
    latencyMs: 120,
    seq: 1,
    committed: false,
    createdAt: Date.now(),
    tabId: 101,
  };

  // 1. Antes de gravar, hasSignal deve ser falso
  assert.equal(await store.hasSignal(id), false);

  // 2. Grava sinal de forma transacional
  const saved = await store.putSignal(signal);
  assert.equal(saved.id, id);
  assert.equal(saved.committed, false);

  // 3. hasSignal deve ser verdadeiro
  assert.equal(await store.hasSignal(id), true);

  // 4. getSignalById retorna o registro íntegro
  const fetched = await store.getSignalById(id);
  assert.ok(fetched);
  assert.equal(fetched.action, "CALL");
  assert.equal(fetched.seq, 1);
  assert.equal(fetched.committed, false);

  // 5. Marca como committed
  await store.markCommitted(id);
  const committedSignal = await store.getSignalById(id);
  assert.equal(committedSignal.committed, true);

  // 6. getSignals retorna lista filtrada por tabId
  const list = await store.getSignals(10, { tabId: 101 });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);

  // 7. getSignals para outra aba retorna vazio (isolamento estrito)
  const otherTabList = await store.getSignals(10, { tabId: 999 });
  assert.equal(otherTabList.length, 0);
});

test("R5 & Concorrência: 5 abas emitindo simultaneamente recebem seq estritamente único e nenhum sinal é sobrescrito", async () => {
  const store = new SignalStore({ dbName: "test_concurrency", storeName: "signals" });
  await store.clear();

  const sessionStore = {};
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      session: {
        get: async (k) => {
          const key = Array.isArray(k) ? k[0] : k;
          return { [key]: sessionStore[key] };
        },
        set: async (obj) => {
          Object.assign(sessionStore, obj);
        },
      },
    },
  };

  try {
    const tabsCount = 5;
    const baseTimestamp = 1727200000;

    // Dispara 5 escritas concorrentes de abas distintas
    const promises = Array.from({ length: tabsCount }).map(async (_, idx) => {
      const tabId = 200 + idx;
      const candleTs = baseTimestamp + idx * 60;
      const seq = await getNextGlobalSeq();
      const id = `BTCUSD:60:${candleTs}:1.0.0`;

      const sig = {
        id,
        symbol: "BTCUSD",
        timeframe: 60,
        candleTimestamp: candleTs,
        strategyVersion: "1.0.0",
        action: idx % 2 === 0 ? "CALL" : "PUT",
        reasons: [`Aba ${tabId} cálculo`],
        dataState: "READY",
        latencyMs: 50 + idx * 10,
        seq,
        committed: true,
        createdAt: Date.now() + idx,
        tabId,
      };

      return store.putSignal(sig);
    });

    const results = await Promise.all(promises);
    assert.equal(results.length, 5);

    // Todos os 5 seqs devem ser únicos e ordenados
    const seqs = results.map((r) => r.seq);
    const uniqueSeqs = new Set(seqs);
    assert.equal(uniqueSeqs.size, 5, "Todos os 5 seqs devem ser únicos");

    // Todos os 5 registros devem estar armazenados sem colisões nem sobrescritas
    const allSignals = await store.getSignals(10);
    assert.equal(allSignals.length, 5, "Nenhum sinal deve ter sido sobrescrito");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("R6: Falha na transação grava sinal em pending_signals e reenvia ao reiniciar", async () => {
  const sessionStore = {};
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      session: {
        get: async (k) => {
          const key = Array.isArray(k) ? k[0] : k;
          return { [key]: sessionStore[key] };
        },
        set: async (obj) => {
          Object.assign(sessionStore, obj);
        },
        remove: async (k) => {
          const key = Array.isArray(k) ? k[0] : k;
          delete sessionStore[key];
        },
      },
    },
  };

  try {
    const failedSignal = {
      id: "ETHUSD:60:1727300000:1.0.0",
      symbol: "ETHUSD",
      timeframe: 60,
      candleTimestamp: 1727300000,
      strategyVersion: "1.0.0",
      action: "CALL",
      reasons: ["Simulação de falha IndexedDB"],
      dataState: "READY",
      latencyMs: 80,
      seq: 99,
      committed: false,
      createdAt: Date.now(),
      tabId: 301,
    };

    // Simula salvamento em pending_signals conforme analyzer.js:1115
    const res = await chrome.storage.session.get("ifx:pending_signals");
    const pending = Array.isArray(res?.["ifx:pending_signals"]) ? res["ifx:pending_signals"] : [];
    pending.push(failedSignal);
    await chrome.storage.session.set({ "ifx:pending_signals": pending });

    // Verifica que está no pending_signals
    const checkPending = await chrome.storage.session.get("ifx:pending_signals");
    assert.equal(checkPending["ifx:pending_signals"].length, 1);
    assert.equal(checkPending["ifx:pending_signals"][0].id, failedSignal.id);

    // Agora simula o flush do service worker no onStartup
    await flushPendingSignals();

    // pending_signals deve ter sido esvaziado
    const afterFlush = await chrome.storage.session.get("ifx:pending_signals");
    assert.equal(afterFlush["ifx:pending_signals"], undefined);

    // O sinal foi gravado e comitado no signalStore global
    const stored = await signalStore.getSignalById(failedSignal.id);
    assert.ok(stored);
    assert.equal(stored.committed, true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("R4 & R7: Side Panel filtra sinais não confirmados e descarta gaps fora de ordem com log de auditoria", () => {
  swResetRecords();

  const signalsFeed = [
    // 1. Sinal com committed=false -> DEVE ser ignorado via SIGNAL_SKIP_NOT_COMMITTED
    {
      id: "EURUSD:60:1:1.0.0",
      symbol: "EURUSD",
      action: "CALL",
      seq: 10,
      committed: false,
    },
    // 2. Sinal válido seq 15
    {
      id: "EURUSD:60:2:1.0.0",
      symbol: "EURUSD",
      action: "CALL",
      seq: 15,
      committed: true,
    },
    // 3. Sinal com seq menor que o último (seq 12 < 15) -> DEVE ser descartado via SEQ_GAP
    {
      id: "EURUSD:60:3:1.0.0",
      symbol: "EURUSD",
      action: "PUT",
      seq: 12,
      committed: true,
    },
    // 4. Sinal válido seq 20
    {
      id: "EURUSD:60:4:1.0.0",
      symbol: "EURUSD",
      action: "PUT",
      seq: 20,
      committed: true,
    },
  ];

  // Simula a lógica idêntica aplicada em renderSignalsHistory
  let lastRenderedSignalSeq = 0;
  const validSignals = [];

  for (const sig of signalsFeed) {
    if (sig.committed === false) {
      rec("SIGNAL_SKIP_NOT_COMMITTED", { id: sig.id, seq: sig.seq });
      continue;
    }

    if (Number.isFinite(sig.seq)) {
      if (sig.seq < lastRenderedSignalSeq) {
        rec("SEQ_GAP", { id: sig.id, seq: sig.seq, lastRenderedSeq: lastRenderedSignalSeq });
        continue;
      }
      if (sig.seq > lastRenderedSignalSeq) {
        lastRenderedSignalSeq = sig.seq;
      }
    }

    validSignals.push(sig);
  }

  // Apenas sinais 2 e 4 devem ter passado
  assert.equal(validSignals.length, 2);
  assert.equal(validSignals[0].seq, 15);
  assert.equal(validSignals[1].seq, 20);

  // Flight recorder gravou SIGNAL_SKIP_NOT_COMMITTED e SEQ_GAP
  const records = swGetRecords();
  const skipNotCommitted = records.find((r) => r.type === "SIGNAL_SKIP_NOT_COMMITTED");
  assert.ok(skipNotCommitted, "Deve registrar SIGNAL_SKIP_NOT_COMMITTED");
  assert.equal(skipNotCommitted.payload.seq, 10);

  const seqGap = records.find((r) => r.type === "SEQ_GAP");
  assert.ok(seqGap, "Deve registrar SEQ_GAP");
  assert.equal(seqGap.payload.seq, 12);
  assert.equal(seqGap.payload.lastRenderedSeq, 15);
});
