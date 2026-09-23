/**
 * frame-and-bridge.test.js - Testes de Isolamento de Frame de Cálculo e Segurança da Bridge (I-05, I-11)
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isComputeFrame, COMPUTE_HOSTS } from "../src/content/analyzer.js";
import { validateBridgeMessage } from "../src/content/bridge.js";

test("isComputeFrame: Identifica corretamente frames autorizados para cálculo", () => {
  assert.equal(isComputeFrame("chart.b2trading.io"), true, "chart.b2trading.io DEVE ser frame de cálculo");
  assert.equal(isComputeFrame("traderoom.b2trading.io"), false, "traderoom.b2trading.io NÃO pode ser frame de cálculo");
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
