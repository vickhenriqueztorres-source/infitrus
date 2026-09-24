/**
 * market-sync-stability.test.js - Testes de Estabilidade de Feed e Sincronização de Ativos (ARBITRIUM)
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MarketAnalyzer,
  extractSymbolFromPayload,
  detectActiveSymbolFromDOM,
} from "../src/content/analyzer.js";
import { handleServiceWorkerMessage } from "../src/background/service-worker.js";

test("extractSymbolFromPayload: Extrai símbolo de múltiplos formatos heterogêneos de brokers", () => {
  // 1. Objeto direto com 'pair'
  assert.equal(extractSymbolFromPayload({ pair: "EURUSD" }), "EURUSD");

  // 2. Objeto direto com 'symbol'
  assert.equal(extractSymbolFromPayload({ symbol: "BTCUSD" }), "BTCUSD");

  // 3. Objeto direto com 'asset' (comum em brokers OTC como B2Trading Arbitrium)
  assert.equal(extractSymbolFromPayload({ asset: "ARBITRIUM_otc" }), "ARBITRIUM_OTC");

  // 4. Objeto direto com 'ticker'
  assert.equal(extractSymbolFromPayload({ ticker: "ETHUSD" }), "ETHUSD");

  // 5. Envelope 'messages' com par no elemento da mensagem
  assert.equal(
    extractSymbolFromPayload({
      messages: [{ pair: "ARBITRIUM_otc", data: { close: 1.05 } }],
    }),
    "ARBITRIUM_OTC"
  );

  // 6. Envelope 'messages' com par dentro de 'data'
  assert.equal(
    extractSymbolFromPayload({
      messages: [{ name: "tick", data: { pair: "SOLUSD", close: 150.0 } }],
    }),
    "SOLUSD"
  );

  // 7. Envelope 'data' direto
  assert.equal(
    extractSymbolFromPayload({
      data: { asset: "ARBITRIUM_otc", close: 1.05 },
    }),
    "ARBITRIUM_OTC"
  );

  // 8. Payload nulo ou inválido
  assert.equal(extractSymbolFromPayload(null), null);
  assert.equal(extractSymbolFromPayload("invalid"), null);
  assert.equal(extractSymbolFromPayload({}), null);
});

test("detectActiveSymbolFromDOM: Detecta o ativo ativo a partir de elementos do DOM do TradingView", () => {
  const origDoc = globalThis.document;
  try {
    // Simula presença do título do gráfico TradingView "ARBITRIUM_otc · 1"
    globalThis.document = {
      querySelector: (selector) => {
        if (selector === '[data-name="legend-source-title"]') {
          return { textContent: "ARBITRIUM_otc · 1" };
        }
        return null;
      },
    };

    const detected = detectActiveSymbolFromDOM();
    assert.equal(detected, "ARBITRIUM_OTC");
  } finally {
    globalThis.document = origDoc;
  }
});

test("MarketAnalyzer: Ingesta candles de ARBITRIUM_otc para warm-up mas só adota par ativo após canal subscribe", () => {
  const analyzer = new MarketAnalyzer();

  const arbitriumPayload = {
    asset: "ARBITRIUM_otc",
    messages: [
      {
        name: "tick",
        data: {
          time: 1727010180000,
          open: 100.0,
          high: 101.5,
          low: 99.5,
          close: 100.8,
          volume: 50,
        },
      },
    ],
  };

  analyzer.processRealtimePayload(arbitriumPayload);

  // Sem canal ativo, currentSymbol permanece null (não há adoção/troca por tick)
  assert.equal(analyzer.currentSymbol, null);
  // O candle foi devidamente guardado no Store para warm-up
  const last = analyzer.store.getLast("ARBITRIUM_OTC", 60);
  assert.ok(last);
  assert.equal(last.close, 100.8);

  // Somente com evento formal de canal é que o símbolo é adotado
  analyzer.activeChannel.onChannel({
    action: "subscribe",
    pair: "ARBITRIUM_OTC",
    tf: 60,
  });

  assert.equal(analyzer.currentSymbol, "ARBITRIUM_OTC");
  assert.equal(analyzer.activeSymbols.has("ARBITRIUM_OTC"), true);

  analyzer.destroy();
});

test("MarketAnalyzer: Transição via canal de WebSocket para ARBITRIUM_OTC", () => {
  const analyzer = new MarketAnalyzer();

  analyzer.activeChannel.onChannel({
    action: "subscribe",
    pair: "ARBITRIUM_OTC",
    tf: 60,
  });

  assert.equal(analyzer.currentSymbol, "ARBITRIUM_OTC");
  assert.deepEqual(analyzer.activeChannel.get(), { pair: "ARBITRIUM_OTC", tf: 60 });

  analyzer.destroy();
});

test("MarketAnalyzer: Desconexão breve de WebSocket não derruba qualidade imediatamente se há ticks recentes", () => {
  const analyzer = new MarketAnalyzer();

  // Simula tick recente
  analyzer.processRealtimePayload({
    pair: "EURUSD",
    messages: [
      {
        name: "tick",
        data: { time: 1727010180000, open: 1.08, high: 1.09, low: 1.07, close: 1.085 },
      },
    ],
  });

  assert.equal(analyzer.socketStatus, "conectado");

  // Recebe socket closed
  analyzer.handleSocketStatus({ status: "closed" });

  // Devido aos ticks recentes (< 5s), status NÃO foi rebaixado instantaneamente (carência de 4s ativa)
  assert.equal(analyzer.socketStatus, "conectado");
  assert.ok(analyzer._disconnectTimer !== null, "Timer de carência de desconexão deve estar ativo");

  // Novo socket connected chega antes do término da carência
  analyzer.handleSocketStatus({ status: "connected" });

  assert.equal(analyzer.socketStatus, "conectado");
  assert.equal(analyzer._disconnectTimer, null, "Timer de carência deve ter sido limpo sem oscilar o estado");

  analyzer.destroy();
});

test("Service Worker: Trava CLAIM_COMPUTE rejeita segundo frame e ORACLE_SAVE_TAB_STATE rejeita frame não-proprietário", () => {
  const origChrome = globalThis.chrome;
  const sessionStorage = {};
  const localStorage = {};

  globalThis.chrome = {
    storage: {
      session: {
        get: (keys, cb) => {
          const res = {};
          for (const k of keys) {
            if (sessionStorage[k] !== undefined) res[k] = sessionStorage[k];
          }
          cb(res);
        },
        set: (obj, cb) => {
          Object.assign(sessionStorage, obj);
          if (cb) cb();
        },
        remove: (keys, cb) => {
          for (const k of keys) delete sessionStorage[k];
          if (cb) cb();
        },
      },
      local: {
        set: (obj, cb) => {
          Object.assign(localStorage, obj);
          if (cb) cb();
        },
      },
    },
  };

  try {
    const tabId = 42;
    let resClaim1 = null;
    let resClaim2 = null;

    // Frame 100 reivindica posse de cálculo para tab 42
    handleServiceWorkerMessage(
      { type: "CLAIM_COMPUTE", tabId, frameId: 100 },
      { tab: { id: tabId }, frameId: 100 },
      (res) => { resClaim1 = res; }
    );
    assert.deepEqual(resClaim1, { granted: true, frameId: 100, tabId });

    // Frame 200 (segundo frame) tenta reivindicar para a mesma tab 42 -> DENIED
    handleServiceWorkerMessage(
      { type: "CLAIM_COMPUTE", tabId, frameId: 200 },
      { tab: { id: tabId }, frameId: 200 },
      (res) => { resClaim2 = res; }
    );
    assert.deepEqual(resClaim2, { granted: false, reason: "DENIED" });

    // Frame 100 (proprietário) grava estado da aba -> permitido
    let resSaveOwner = null;
    handleServiceWorkerMessage(
      { type: "ORACLE_SAVE_TAB_STATE", tabId, frameId: 100, state: { symbol: "EURUSD" } },
      { tab: { id: tabId }, frameId: 100 },
      (res) => { resSaveOwner = res; }
    );
    assert.deepEqual(resSaveOwner, { saved: true });
    assert.deepEqual(sessionStorage[`ifx:session:tab:${tabId}:state`], { symbol: "EURUSD" });
    assert.equal(localStorage[`ifx:tab:${tabId}:state`], undefined);

    // Frame 200 (não-proprietário) tenta gravar estado -> rejeitado com DENIED_NOT_OWNER
    let resSaveImposter = null;
    handleServiceWorkerMessage(
      { type: "ORACLE_SAVE_TAB_STATE", tabId, frameId: 200, state: { symbol: "BTCUSD" } },
      { tab: { id: tabId }, frameId: 200 },
      (res) => { resSaveImposter = res; }
    );
    assert.deepEqual(resSaveImposter, { saved: false, reason: "DENIED_NOT_OWNER" });
    // Estado gravado no storage de sessão não foi adulterado pelo frame invasor
    assert.deepEqual(sessionStorage[`ifx:session:tab:${tabId}:state`], { symbol: "EURUSD" });
    assert.equal(localStorage[`ifx:tab:${tabId}:state`], undefined);
  } finally {
    globalThis.chrome = origChrome;
  }
});
