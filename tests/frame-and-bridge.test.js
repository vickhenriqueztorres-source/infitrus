/**
 * frame-and-bridge.test.js - Testes de Isolamento de Frame de Cálculo e Segurança da Bridge (I-05, I-11)
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isComputeFrame, COMPUTE_HOSTS, MarketAnalyzer } from "../src/content/analyzer.js";
import { validateBridgeMessage } from "../src/content/bridge.js";

test("isComputeFrame: Identifica exclusivamente chart.b2trading.io como frame de cálculo (sem fallback TOP)", () => {
  assert.equal(isComputeFrame("chart.b2trading.io"), true, "chart.b2trading.io DEVE ser frame de cálculo");
  assert.equal(isComputeFrame("traderoom.b2trading.io"), false, "traderoom.b2trading.io NUNCA pode calcular");
  assert.equal(isComputeFrame("traderoom.b2trading.io", { hasChartIframe: true }), false);
  assert.equal(isComputeFrame("traderoom.b2trading.io", { hasChartIframe: false }), false);
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
