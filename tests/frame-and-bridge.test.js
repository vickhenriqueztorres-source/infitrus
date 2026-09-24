/**
 * frame-and-bridge.test.js - Testes de Isolamento de Frame de Cálculo e Segurança da Bridge (I-05, I-11)
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isComputeFrame, COMPUTE_HOSTS, MarketAnalyzer } from "../src/content/analyzer.js";
import { validateBridgeMessage } from "../src/content/bridge.js";

test("isComputeFrame: Identifica corretamente frames autorizados para cálculo e regra de fallback", () => {
  assert.equal(isComputeFrame("chart.b2trading.io"), true, "chart.b2trading.io DEVE ser frame de cálculo");
  assert.equal(isComputeFrame("traderoom.b2trading.io"), false, "traderoom.b2trading.io cede por padrão quando há iframe de gráfico");
  assert.equal(isComputeFrame("traderoom.b2trading.io", { hasChartIframe: true }), false, "traderoom cede cálculo se iframe existir");
  assert.equal(isComputeFrame("traderoom.b2trading.io", { hasChartIframe: false }), true, "traderoom assume como fallback se NÃO houver iframe");
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

test("MarketAnalyzer: Adota o ativo do feed em tempo real quando activeChannel ainda não possui canal explícito", () => {
  const analyzer = new MarketAnalyzer();
  // Inicialmente sem canal ativo registrado
  assert.equal(analyzer.activeChannel.get(), null);

  // Chega tick de ativo OTC (ex: AMAZON_OTC)
  const otcPayload = {
    pair: "AMAZON_OTC",
    messages: [
      {
        name: "tick",
        data: {
          time: 1727010180000,
          open: 506.70,
          high: 506.80,
          low: 506.65,
          close: 506.75,
          volume: 10,
        },
      },
    ],
  };

  analyzer.processRealtimePayload(otcPayload);

  // O analyzer deve ter adotado AMAZON_OTC sem descartar
  assert.equal(analyzer.currentSymbol, "AMAZON_OTC");
  assert.equal(analyzer.activeSymbols.has("AMAZON_OTC"), true);
  const last = analyzer.store.getLast("AMAZON_OTC", 60);
  assert.ok(last, "Candle de AMAZON_OTC deve ter sido gravado no store");
  assert.equal(last.close, 506.75);

  analyzer.destroy();
});
