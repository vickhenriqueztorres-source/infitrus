/**
 * frame-and-bridge.test.js - Testes de Isolamento de Frame de Cálculo e Segurança da Bridge (I-05, I-11)
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isComputeFrame, COMPUTE_HOSTS, MarketAnalyzer } from "../src/content/analyzer.js";
import { validateBridgeMessage } from "../src/content/bridge.js";

test("isComputeFrame: Identifica chart.b2trading.io e traderoom.b2trading.io como frames de cálculo", () => {
  assert.equal(isComputeFrame("chart.b2trading.io"), true, "chart.b2trading.io DEVE ser frame de cálculo");
  assert.equal(isComputeFrame("traderoom.b2trading.io"), true, "traderoom.b2trading.io DEVE ser frame de cálculo no frame TOP");
  assert.equal(isComputeFrame("app.b2trading.io"), false, "Outros subdomínios não podem ser frame de cálculo");
  assert.equal(isComputeFrame(""), false, "Hostname vazio não pode ser frame de cálculo");
});

test("validateBridgeMessage: Rejeita mensagem de origem não autorizada ou diferente da janela local", () => {
  const origWindow = globalThis.window;
  try {
    globalThis.window = {
      location: { origin: "https://chart.b2trading.io" },
    };

    // Origem diferente (atacante ou janela externa)
    const eventDiffOrigin = {
      source: globalThis.window,
      origin: "https://malicious.com",
      data: {
        type: "ORACLE_MAIN_MARKET_EVENT",
        sessionId: "sess_12345_9999",
        payload: { tick: 1.05 },
      },
    };

    const resDiff = validateBridgeMessage(eventDiffOrigin);
    assert.equal(resDiff.valid, false);
    assert.match(resDiff.reason, /Domínio de origem não autorizado/);
  } finally {
    globalThis.window = origWindow;
  }
});

test("validateBridgeMessage: Rejeita mensagem com sessionId divergente (sessão forjada)", () => {
  const origWindow = globalThis.window;
  try {
    globalThis.window = {
      location: { origin: "https://chart.b2trading.io" },
    };

    const validEvent = {
      source: globalThis.window,
      origin: "https://chart.b2trading.io",
      data: {
        type: "ORACLE_MAIN_MARKET_EVENT",
        sessionId: "sess_attacker_9999",
        payload: { tick: 1.05 },
      },
    };

    const expectedSession = "sess_legit_1111";
    const res = validateBridgeMessage(validEvent, expectedSession);
    assert.equal(res.valid, false);
    assert.match(res.reason, /sessionId não corresponde à sessão esperada/);
  } finally {
    globalThis.window = origWindow;
  }
});

test("validateBridgeMessage: Aceita mensagem legítima da mesma janela com sessionId correspondente", () => {
  const origWindow = globalThis.window;
  try {
    globalThis.window = {
      location: { origin: "https://chart.b2trading.io" },
    };

    const validEvent = {
      source: globalThis.window,
      origin: "https://chart.b2trading.io",
      data: {
        type: "ORACLE_CHANNEL",
        sessionId: "sess_legit_1111",
        action: "subscribe",
        pair: "EURUSD",
        tf: 60,
      },
    };

    const res = validateBridgeMessage(validEvent, "sess_legit_1111");
    assert.equal(res.valid, true);
    assert.equal(res.data.action, "subscribe");
    assert.equal(res.data.pair, "EURUSD");
  } finally {
    globalThis.window = origWindow;
  }
});

test("MarketAnalyzer: Ticks sem canal não geram PRE_SIGNAL e currentSymbol permanece null", () => {
  const analyzer = new MarketAnalyzer();
  assert.equal(analyzer.activeChannel.get(), null);
  assert.equal(analyzer.currentSymbol, null);

  // Ticks intercalados de AUDCAD, EURUSD, GBPJPY
  const pairs = ["AUDCAD", "EURUSD", "GBPJPY"];
  for (const pair of pairs) {
    analyzer.processRealtimePayload({
      pair,
      messages: [{ data: { time: 1727010180000, open: 1.0, high: 1.1, low: 0.9, close: 1.05 } }],
    });
  }

  // currentSymbol permanece null, nenhum PRE_SIGNAL
  assert.equal(analyzer.currentSymbol, null);
  assert.equal(analyzer.signalAuditor.getSignals().length, 0);

  // Candles foram guardados no store para aquecimento
  for (const pair of pairs) {
    const last = analyzer.store.getLast(pair, 60);
    assert.ok(last, `Candle de ${pair} deve ter sido guardado no store`);
    assert.equal(last.close, 1.05);
  }

  analyzer.destroy();
});

test("MarketAnalyzer: Canal subscribe AUDCAD ignora ticks de EURUSD no lifecycle", () => {
  const analyzer = new MarketAnalyzer();

  // Assina canal AUDCAD
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "AUDCAD", tf: 60 });
  assert.equal(analyzer.currentSymbol, "AUDCAD");

  // Alimenta tick de EURUSD (outro par)
  analyzer.processRealtimePayload({
    pair: "EURUSD",
    messages: [{ data: { time: 1727010180000, open: 1.08, high: 1.09, low: 1.07, close: 1.085 } }],
  });

  // currentSymbol continua sendo estritamente AUDCAD
  assert.equal(analyzer.currentSymbol, "AUDCAD");
  assert.equal(analyzer.activeSymbols.has("EURUSD"), false);

  // Candle de EURUSD guardado no store para aquecer
  assert.ok(analyzer.store.getLast("EURUSD", 60));

  // Alimenta tick de AUDCAD
  analyzer.processRealtimePayload({
    pair: "AUDCAD",
    messages: [{ data: { time: 1727010180000, open: 0.90, high: 0.91, low: 0.89, close: 0.905 } }],
  });

  assert.equal(analyzer.currentSymbol, "AUDCAD");
  assert.equal(analyzer.activeSymbols.has("AUDCAD"), true);
  assert.equal(analyzer.lastPrice, "0.90500");

  analyzer.destroy();
});

test("MarketAnalyzer: destroy() real desliga listeners e bloqueia eventos e escritas em storage", () => {
  let storageWrites = 0;
  const origChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        if (msg?.type === "ORACLE_SAVE_TAB_STATE") {
          storageWrites++;
          if (cb) cb({ saved: true });
        }
      },
    },
  };

  try {
    const analyzer = new MarketAnalyzer();
    analyzer.tabId = 101;
    analyzer.activeChannel.onChannel({ action: "subscribe", pair: "AUDCAD", tf: 60 });

    analyzer.destroy();
    assert.equal(analyzer._isDestroyed, true);

    const prevSignalsCount = analyzer.signalAuditor.getSignals().length;
    const prevWrites = storageWrites;

    // Dispara handleMarketEvent após destroy
    analyzer.handleMarketEvent({
      type: "MARKET_EVENT",
      payload: {
        pair: "AUDCAD",
        messages: [{ data: { time: 1727010240000, open: 0.91, high: 0.92, low: 0.90, close: 0.915 } }],
      },
    });

    // Nenhuma escrita no storage e nenhum novo sinal
    assert.equal(storageWrites, prevWrites, "Nenhuma escrita em storage deve ocorrer após destroy()");
    assert.equal(analyzer.signalAuditor.getSignals().length, prevSignalsCount, "Nenhum evento de lifecycle deve ocorrer após destroy()");
  } finally {
    globalThis.chrome = origChrome;
  }
});

test("MarketAnalyzer: Suporta múltiplos gráficos simultâneos (Multi-Chart) sem descartar ticks nem contaminar ativos", async () => {
  const analyzer = new MarketAnalyzer();
  analyzer.tabId = 202;

  // Gráfico 1 subscreve ARBITRIUM_OTC
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "ARBITRIUM_OTC", tf: 60 });
  // Gráfico 2 subscreve 1000SATS_OTC
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "1000SATS_OTC", tf: 60 });

  assert.equal(analyzer.activeChannel.hasPair("ARBITRIUM_OTC"), true);
  assert.equal(analyzer.activeChannel.hasPair("1000SATS_OTC"), true);

  const baseTs = 1727050000;

  // Ticks intercalados de ambos os gráficos
  await analyzer.processRealtimePayload({
    pair: "ARBITRIUM_OTC",
    messages: [{ data: { time: baseTs * 1000, open: 495.10, high: 495.50, low: 495.00, close: 495.20 } }],
  });

  await analyzer.processRealtimePayload({
    pair: "1000SATS_OTC",
    messages: [{ data: { time: baseTs * 1000, open: 0.00025, high: 0.00028, low: 0.00024, close: 0.00026 } }],
  });

  await analyzer.processRealtimePayload({
    pair: "ARBITRIUM_OTC",
    messages: [{ data: { time: (baseTs + 10) * 1000, open: 495.10, high: 495.80, low: 495.00, close: 495.75 } }],
  });

  await analyzer.processRealtimePayload({
    pair: "1000SATS_OTC",
    messages: [{ data: { time: (baseTs + 10) * 1000, open: 0.00025, high: 0.00030, low: 0.00024, close: 0.00029 } }],
  });

  // Ambos os ativos devem estar ativos sem que um tenha cancelado o outro
  assert.equal(analyzer.activeSymbols.has("ARBITRIUM_OTC"), true);
  assert.equal(analyzer.activeSymbols.has("1000SATS_OTC"), true);

  const lastArb = analyzer.store.getLast("ARBITRIUM_OTC", 60);
  const lastSats = analyzer.store.getLast("1000SATS_OTC", 60);

  assert.ok(lastArb, "ARBITRIUM_OTC deve possuir candle no store");
  assert.ok(lastSats, "1000SATS_OTC deve possuir candle no store");

  assert.equal(lastArb.close, 495.75);
  assert.equal(lastSats.close, 0.00029);

  // Isolamento estrito de preços
  assert.equal(analyzer.lastPrices.get("ARBITRIUM_OTC"), "495.75000");
  assert.equal(analyzer.lastPrices.get("1000SATS_OTC"), "0.00029");

  // Alternância de símbolo selecionado
  analyzer.selectSymbol("ARBITRIUM_OTC");
  assert.equal(analyzer.currentSymbol, "ARBITRIUM_OTC");

  analyzer.selectSymbol("1000SATS_OTC");
  assert.equal(analyzer.currentSymbol, "1000SATS_OTC");

  analyzer.destroy();
});
