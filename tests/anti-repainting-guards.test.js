import test from "node:test";
import assert from "node:assert/strict";
import { CandleStore } from "../src/market/candle-store.js";
import { MarketAnalyzer } from "../src/content/analyzer.js";
import {
  rec,
  swGetRecords,
  swResetRecords,
  configureFlightRecorder,
} from "../src/diagnostics/flight-recorder.js";
import {
  handleServiceWorkerMessage,
  migrateLegacyStateKeys,
} from "../src/background/service-worker.js";
import { selectTabView } from "../src/ui/tab-view-selector.js";

configureFlightRecorder({ ctx: "sw" });

test("R1 & R5: applyTick rejeita ticks fora da janela estrita (+2s) e registra TICK_REJECTED_OUT_OF_ORDER", () => {
  swResetRecords();
  const store = new CandleStore({ tabId: 101 });
  const symbol = "EURUSD";
  const timeframe = 60;

  // 1. Primeiro tick inicializa vela aberta
  const res1 = store.applyTick({
    symbol,
    timeframe,
    timestamp: 1000,
    open: 1.0850,
    high: 1.0855,
    low: 1.0845,
    close: 1.0850,
  });
  assert.equal(res1.action, "CREATED");
  assert.equal(res1.candle.closed, false);
  assert.equal(res1.candle.frozen, false);

  // 2. Tick com timestamp <= candle fechado + 60s é REJEITADO (TICK_ANTIGO_CANDLE_FECHADO)
  // candle.timestamp foi normalizado para Math.floor(1000 / 60) * 60 = 960 (ou base de tempo)
  // Para timeframe 60 em ms, limite = candle.timestamp + 60000
  const candleTs = res1.candle.timestamp;
  const resOld = store.applyTick({
    symbol,
    timeframe,
    timestamp: candleTs + 50000, // <= candleTs + 60000
    open: 1.0850,
    high: 1.0860,
    low: 1.0840,
    close: 1.0855,
  });
  assert.equal(resOld.action, "REJECTED");
  assert.equal(resOld.reason, "TICK_ANTIGO_CANDLE_FECHADO");

  // 3. Tick com timestamp > candle fechado + 62s é REJEITADO (TICK_MUITO_ATRASADO)
  // candleCloseTime = candleTs + 60000; tolerancia = 2000; limite = candleTs + 62000
  const resTooLate = store.applyTick({
    symbol,
    timeframe,
    timestamp: candleTs + 63000, // > candleTs + 62000
    open: 1.0850,
    high: 1.0870,
    low: 1.0830,
    close: 1.0865,
  });
  assert.equal(resTooLate.action, "REJECTED");
  assert.equal(resTooLate.reason, "TICK_MUITO_ATRASADO");

  // 4. Tick dentro da janela de tolerância (+2s, ex.: candleTs + 61000) é ACEITO e atualiza vela
  const resValid = store.applyTick({
    symbol,
    timeframe,
    timestamp: candleTs + 61000, // 60000 < timestamp <= 62000
    open: 1.0850,
    high: 1.0880,
    low: 1.0840,
    close: 1.0875,
  });
  assert.equal(resValid.action, "UPDATED");
  assert.equal(resValid.candle.high, 1.0880);
  assert.equal(resValid.candle.close, 1.0875);

  // 5. Verifica R5: Flight Recorder registrou ambos os eventos com motivo e parâmetros
  const records = swGetRecords().filter((r) => r.type === "TICK_REJECTED_OUT_OF_ORDER");
  assert.equal(records.length, 2);

  assert.equal(records[0].payload.symbol, "EURUSD");
  assert.equal(records[0].payload.reason, "TICK_ANTIGO_CANDLE_FECHADO");
  assert.equal(records[0].payload.tickTimestamp, candleTs + 50000);
  assert.equal(records[0].payload.candleTimestamp, candleTs);

  assert.equal(records[1].payload.symbol, "EURUSD");
  assert.equal(records[1].payload.reason, "TICK_MUITO_ATRASADO");
  assert.equal(records[1].payload.tickTimestamp, candleTs + 63000);
  assert.equal(records[1].payload.candleTimestamp, candleTs);
});

test("R2: Congelamento com timer (frozen=false inicialmente, frozen=true após delay) e reabertura com tick intermediário", async () => {
  swResetRecords();
  const store = new CandleStore({ freezeDelay: 40, tabId: 202 });
  const symbol = "BTCUSD";
  const tf = 60;
  const baseTs = 1727000000;

  // Ingestão da primeira vela
  store.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs,
    open: 60000,
    high: 60100,
    low: 59900,
    close: 60050,
  });

  // Chegada do próximo candle contíguo -> fecha a 1ª vela
  const resNext = store.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs + tf,
    open: 60050,
    high: 60200,
    low: 60000,
    close: 60150,
  });

  assert.equal(resNext.status, "NEW_CANDLE");
  // Inicialmente vela anterior fecha com closed=true e frozen=false
  assert.equal(resNext.closedCandle.closed, true);
  assert.equal(resNext.closedCandle.frozen, false);

  const closedInStore = store.getClosedCandles(symbol, tf, 5);
  assert.equal(closedInStore[0].closed, true);
  assert.equal(closedInStore[0].frozen, false);

  // Aguarda expiração do freezeDelay (40ms)
  await new Promise((r) => setTimeout(r, 60));

  // Agora deve estar congelada e com log CANDLE_FROZEN registrado
  const closedAfterTimer = store.getClosedCandles(symbol, tf, 5);
  assert.equal(closedAfterTimer[0].frozen, true);

  const frozenLogs = swGetRecords().filter((r) => r.type === "CANDLE_FROZEN");
  assert.ok(frozenLogs.length >= 1, "Deve registrar CANDLE_FROZEN no Flight Recorder");
  assert.equal(frozenLogs[0].payload.symbol, symbol);
  assert.equal(frozenLogs[0].payload.timestamp, baseTs);

  // Teste de cancelamento e reabertura (CANDLE_REOPENED)
  const store2 = new CandleStore({ freezeDelay: 80, tabId: 203 });
  const baseTs2 = 1728000000;
  store2.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs2,
    open: 60000,
    high: 60050,
    low: 59950,
    close: 60020,
  });

  // Abre nova vela (inicia timer de 80ms no candle anterior)
  store2.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs2 + tf,
    open: 60020,
    high: 60080,
    low: 60010,
    close: 60070,
  });

  // Tick chega DURANTE os 80ms com mesmo timestamp do candle anterior -> cancela timer e reabre
  store2.cancelFreezeTimer(symbol, tf);

  const reopenedLogs = swGetRecords().filter((r) => r.type === "CANDLE_REOPENED");
  assert.ok(reopenedLogs.length >= 1, "Deve registrar CANDLE_REOPENED quando tick chega durante timer");
  assert.equal(reopenedLogs[0].payload.reason, "TICK_DURANTE_FREEZE_TIMER");
});

test("R3: Guarda !frozen no MarketAnalyzer._evaluateOnClosedCandle bloqueia avaliação em candle congelado", async () => {
  swResetRecords();
  const analyzer = new MarketAnalyzer();
  const pair = "EURUSD";
  const tf = 60;
  const candleTs = 1727020000;

  let evalCalled = false;
  analyzer.registry.get(pair).evaluate = () => {
    evalCalled = true;
    return { shouldEmit: true, action: "CALL", probability: 0.85 };
  };

  // 1. Candle com frozen === true -> DEVE SER BLOQUEADO
  const frozenCandle = {
    symbol: pair,
    timeframeSeconds: tf,
    timestamp: candleTs,
    open: 1.0850,
    high: 1.0860,
    low: 1.0840,
    close: 1.0855,
    closed: true,
    frozen: true,
  };

  await analyzer._evaluateOnClosedCandle(pair, tf, frozenCandle, null);

  assert.equal(evalCalled, false, "evaluate() NUNCA deve ser executado quando candle.frozen === true");

  const blockedLogs = swGetRecords().filter((r) => r.type === "EVALUATE_BLOCKED_FROZEN");
  assert.equal(blockedLogs.length, 1);
  assert.equal(blockedLogs[0].payload.pair, pair);
  assert.equal(blockedLogs[0].payload.candleTimestamp, candleTs);
  assert.equal(blockedLogs[0].payload.reason, "CANDLE_JA_CONGELADO");

  // 2. Candle com closed === true e frozen === false -> DEVE PERMITIR AVALIAÇÃO
  analyzer.quality.getReport = () => ({ state: "READY" });
  analyzer.store.isReady = () => true;

  const validCandle = {
    symbol: pair,
    timeframeSeconds: tf,
    timestamp: candleTs + 60,
    open: 1.0855,
    high: 1.0870,
    low: 1.0850,
    close: 1.0865,
    closed: true,
    frozen: false,
  };

  await analyzer._evaluateOnClosedCandle(pair, tf, validCandle, null);
  assert.equal(evalCalled, true, "evaluate() deve ser executado quando candle.closed === true e frozen === false");
  analyzer.destroy();
});

test("R4: Persistência de estado volátil em chrome.storage.session e isolamento por aba", async () => {
  const origChrome = globalThis.chrome;
  const mockSessionStorage = {};
  const mockLocalStorage = {};

  globalThis.chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        handleServiceWorkerMessage(msg, { tab: { id: 777 } }, cb || (() => {}));
      },
      lastError: null,
    },
    storage: {
      session: {
        get: (keys, cb) => {
          if (!keys) {
            const all = { ...mockSessionStorage };
            if (cb) cb(all);
            return Promise.resolve(all);
          }
          const res = {};
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) res[k] = mockSessionStorage[k];
          if (cb) cb(res);
          return Promise.resolve(res);
        },
        set: (obj, cb) => {
          Object.assign(mockSessionStorage, obj);
          if (cb) cb();
          return Promise.resolve();
        },
        remove: (keys, cb) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete mockSessionStorage[k];
          if (cb) cb();
          return Promise.resolve();
        },
      },
      local: {
        get: (keys, cb) => {
          if (!keys) {
            const all = { ...mockLocalStorage };
            if (cb) cb(all);
            return Promise.resolve(all);
          }
          const res = {};
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) res[k] = mockLocalStorage[k];
          if (cb) cb(res);
          return Promise.resolve(res);
        },
        set: (obj, cb) => {
          Object.assign(mockLocalStorage, obj);
          if (cb) cb();
          return Promise.resolve();
        },
        remove: (keys, cb) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete mockLocalStorage[k];
          if (cb) cb();
          return Promise.resolve();
        },
      },
    },
  };

  let analyzer = null;
  try {
    analyzer = new MarketAnalyzer();
    analyzer.tabId = 777;

    // Salva o estado da aba
    analyzer._saveTabState(true);

    const sessionKey = "ifx:session:tab:777:state";
    const legacyLocalKey = "ifx:tab:777:state";

    // Confirma que o estado foi gravado em chrome.storage.session
    assert.ok(mockSessionStorage[sessionKey], "Estado deve estar em chrome.storage.session");
    assert.equal(mockSessionStorage[sessionKey].tabId, 777);

    // Confirma ZERO escritas de ifx:tab:*:state em chrome.storage.local
    assert.equal(mockLocalStorage[legacyLocalKey], undefined, "NÃO deve gravar ifx:tab:*:state no storage local");

    // Confirma que selectTabView lê perfeitamente de ifx:session:tab:777:state
    const view = selectTabView(mockSessionStorage, 777);
    assert.equal(view.tabId, 777);
    assert.ok(view.state, "selectTabView deve extrair o estado da sessão");

    // Testa migração de dados legados do local para session
    mockLocalStorage["ifx:tab:888:state"] = { tabId: 888, pair: "EURUSD" };
    mockLocalStorage["unrelated_key"] = "preserve_me";

    await migrateLegacyStateKeys();

    assert.ok(mockSessionStorage["ifx:session:tab:888:state"], "Deve ter migrado chave legada para session");
    assert.equal(mockSessionStorage["ifx:session:tab:888:state"].tabId, 888);
    assert.equal(mockLocalStorage["ifx:tab:888:state"], undefined, "Deve ter removido chave legada do local");
    assert.equal(mockLocalStorage["unrelated_key"], "preserve_me", "Chaves não relacionadas não devem ser removidas");
  } finally {
    if (analyzer) analyzer.destroy();
    globalThis.chrome = origChrome;
  }
});

test("R5: Service Worker manipula FLIGHT_RECORDER_LOG e registra no ring buffer", (t, done) => {
  swResetRecords();
  const testMsg = {
    type: "FLIGHT_RECORDER_LOG",
    eventType: "TICK_REJECTED_OUT_OF_ORDER",
    payload: {
      symbol: "GBPUSD",
      timeframe: 60,
      tickTimestamp: 1727030050,
      candleTimestamp: 1727030000,
      reason: "TICK_ANTIGO_CANDLE_FECHADO",
    },
    tabId: 999,
  };

  handleServiceWorkerMessage(testMsg, { tab: { id: 999 } }, (res) => {
    assert.deepEqual(res, { ok: true });

    const records = swGetRecords().filter((r) => r.type === "TICK_REJECTED_OUT_OF_ORDER");
    assert.equal(records.length, 1);
    assert.equal(records[0].payload.symbol, "GBPUSD");
    assert.equal(records[0].payload.reason, "TICK_ANTIGO_CANDLE_FECHADO");
    assert.equal(records[0].tabId, 999);
    assert.ok(records[0].seq !== undefined, "Deve possuir seq monotônico gerado pelo SW");
    done();
  });
});
