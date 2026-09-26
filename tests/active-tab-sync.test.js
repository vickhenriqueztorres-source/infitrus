import test from "node:test";
import assert from "node:assert/strict";
import { MarketAnalyzer, detectActiveSymbolsFromDOM, detectOpenChartCountFromDOM } from "../src/content/analyzer.js";
import { Phase } from "../src/strategy/signal-lifecycle.js";

test("Active Tab Sync — 1 Aba Aberta: Troca de ativo remove ativo antigo, cancela PRE_SIGNAL e atualiza currentSymbol", async () => {
  const origDoc = globalThis.document;
  let currentIframePair = "APPLE_OTC";

  try {
    globalThis.document = {
      title: "B2Trading Broker",
      querySelector: () => null,
      querySelectorAll: (sel) => {
        if (sel.includes("iframe")) {
          return [{ getAttribute: (attr) => (attr === "src" ? `https://chart.b2trading.io/?pair=${currentIframePair}` : null) }];
        }
        return [];
      },
    };

    const analyzer = new MarketAnalyzer();
    analyzer.tabId = 501;

    // 1. Abre 1º ativo: APPLE_OTC
    analyzer.handleChannelEvent({ action: "subscribe", pair: "APPLE_OTC", tf: 60, source: "ws_send" });

    const t0 = 1727100000;
    const barsApple = [];
    for (let i = 0; i < 30; i++) {
      barsApple.push({ time: t0 - (29 - i) * 60, open: 500, high: 505, low: 495, close: 502 });
    }
    analyzer.handleMarketEvent({
      sourceType: "history",
      payload: { bars: barsApple },
      meta: { pair: "APPLE_OTC", tf: 60 },
    });

    await analyzer.processRealtimePayload(
      { pair: "APPLE_OTC", messages: [{ data: { time: t0 * 1000, open: 502, high: 503, low: 501, close: 502.5 } }] },
      { pair: "APPLE_OTC", tf: 60 }
    );

    assert.equal(analyzer.currentSymbol, "APPLE_OTC");
    assert.deepEqual(Array.from(analyzer.activeSymbols), ["APPLE_OTC"]);
    assert.deepEqual(analyzer.buildPanelData().allSymbols, ["APPLE_OTC"]);

    // Simula PRE_SIGNAL em APPLE_OTC aos 50s
    const snapPre = analyzer.tickLifecycle({
      nowSec: t0 + 50,
      decide: () => ({ action: "CALL", probability: 0.71, edge: 0.08, ev: 0.14 }),
      dataOk: true,
    });
    assert.equal(snapPre.current.phase, Phase.PRE_SIGNAL);

    // 2. Usuário troca o ativo na única aba de gráfico para ARBITRIUM_OTC
    currentIframePair = "ARBITRIUM_OTC";
    const barsArb = [];
    for (let i = 0; i < 30; i++) {
      barsArb.push({ time: t0 - (29 - i) * 60, open: 498, high: 499, low: 497, close: 498.5 });
    }
    analyzer.handleMarketEvent({
      sourceType: "history",
      payload: { bars: barsArb },
      meta: { pair: "ARBITRIUM_OTC", tf: 60 },
    });

    // Verifica que APPLE_OTC foi removido imediatamente e ARBITRIUM_OTC assumiu
    assert.equal(analyzer.currentSymbol, "ARBITRIUM_OTC", "currentSymbol deve atualizar imediatamente para ARBITRIUM_OTC");
    assert.equal(analyzer.activeSymbols.has("APPLE_OTC"), false, "APPLE_OTC deve ser removido de activeSymbols");
    assert.equal(analyzer.activeSymbols.has("ARBITRIUM_OTC"), true, "ARBITRIUM_OTC deve estar em activeSymbols");
    assert.equal(analyzer.activeChannel.hasPair("APPLE_OTC"), false, "APPLE_OTC deve ser desinscrito de activeChannel");
    assert.deepEqual(analyzer.buildPanelData().allSymbols, ["ARBITRIUM_OTC"], "Painel deve listar apenas ARBITRIUM_OTC");

    // Verifica que o PRE_SIGNAL de APPLE_OTC foi cancelado
    const appleSnapAfter = analyzer.lifecycle.snapshot("APPLE_OTC", 60, t0 + 52);
    assert.notEqual(appleSnapAfter?.current?.phase, Phase.PRE_SIGNAL, "PRE_SIGNAL do ativo fechado deve ser cancelado");

    // 3. Ticks residuais de background para APPLE_OTC NÃO devem reativá-lo
    analyzer.handleChannelEvent({ action: "subscribe", pair: "APPLE_OTC", tf: 60, source: "ws_tick" });
    await analyzer.processRealtimePayload(
      { pair: "APPLE_OTC", messages: [{ data: { time: (t0 + 55) * 1000, open: 502, high: 504, low: 501, close: 503.9 } }] },
      { pair: "APPLE_OTC", tf: 60 }
    );

    assert.equal(analyzer.activeSymbols.has("APPLE_OTC"), false, "Tick residual não pode ressuscitar APPLE_OTC");
    assert.equal(analyzer.currentSymbol, "ARBITRIUM_OTC");

    analyzer.destroy();
  } finally {
    globalThis.document = origDoc;
  }
});

test("Active Tab Sync — 2 Abas Abertas: Monitora exatamente os 2 ativos, higieniza payout e sincroniza troca/fechamento de aba", async () => {
  const origDoc = globalThis.document;
  let openCharts = ["ARBITRIUM OTC 92%", "1000SATS OTC +88%"];

  try {
    globalThis.document = {
      title: "B2Trading Broker",
      querySelector: () => null,
      querySelectorAll: (sel) => {
        if (sel.includes(".pane-legend-title__description")) {
          return openCharts.map((text) => ({ textContent: text }));
        }
        return [];
      },
    };

    assert.equal(detectOpenChartCountFromDOM(), 2);
    assert.deepEqual(detectActiveSymbolsFromDOM(), ["ARBITRIUM_OTC", "1000SATS_OTC"]);

    const analyzer = new MarketAnalyzer();
    analyzer.tabId = 502;

    // Inicializa ambos os gráficos abertos
    analyzer.handleChannelEvent({ action: "subscribe", pair: "ARBITRIUM_OTC", tf: 60, source: "frame_dom" });
    analyzer.handleChannelEvent({ action: "subscribe", pair: "1000SATS_OTC", tf: 60, source: "frame_dom" });

    assert.deepEqual(Array.from(analyzer.activeSymbols).sort(), ["1000SATS_OTC", "ARBITRIUM_OTC"]);
    assert.deepEqual(analyzer.buildPanelData().allSymbols.sort(), ["1000SATS_OTC", "ARBITRIUM_OTC"]);

    // Caso A: Usuário troca a 2ª aba de 1000SATS_OTC para EURUSD_OTC
    openCharts = ["ARBITRIUM OTC 92%", "EURUSD OTC 90%"];
    analyzer.handleChannelEvent({ action: "subscribe", pair: "EURUSD_OTC", tf: 60, source: "frame_dom" });

    assert.equal(analyzer.activeSymbols.has("1000SATS_OTC"), false, "1000SATS_OTC substituído deve sair de activeSymbols");
    assert.deepEqual(Array.from(analyzer.activeSymbols).sort(), ["ARBITRIUM_OTC", "EURUSD_OTC"]);
    assert.equal(analyzer.currentSymbol, "EURUSD_OTC");

    // Caso B: Usuário fecha a 2ª aba (EURUSD_OTC), restando apenas 1 gráfico aberto (ARBITRIUM_OTC)
    openCharts = ["ARBITRIUM OTC 92%"];
    analyzer._reconcileActiveSymbolsWithDOM();

    assert.equal(analyzer.activeSymbols.has("EURUSD_OTC"), false, "Aba fechada (EURUSD_OTC) deve ser removida imediatamente");
    assert.deepEqual(Array.from(analyzer.activeSymbols), ["ARBITRIUM_OTC"]);
    assert.equal(analyzer.currentSymbol, "ARBITRIUM_OTC", "currentSymbol deve voltar para a única aba aberta restante");
    assert.deepEqual(analyzer.buildPanelData().allSymbols, ["ARBITRIUM_OTC"]);

    analyzer.destroy();
  } finally {
    globalThis.document = origDoc;
  }
});

test("Active Tab Sync — Guarda de Série Congelada: Ativo sem ticks recentes não gera PRE_SIGNAL fantasma em tickLifecycle", () => {
  const analyzer = new MarketAnalyzer();
  analyzer.tabId = 503;

  const tOld = 1727100000;
  const barsGhost = [];
  for (let i = 0; i < 30; i++) {
    barsGhost.push({ time: tOld - (29 - i) * 60, open: 0.90, high: 0.91, low: 0.89, close: 0.905 });
  }
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "AUDCAD_OTC", tf: 60 });
  analyzer.processHistoryPayload({ bars: barsGhost }, { pair: "AUDCAD_OTC", tf: 60 });
  analyzer.activeSymbols.add("AUDCAD_OTC");

  let evalCalledForGhost = false;
  analyzer.registry.get("AUDCAD_OTC").evaluate = () => {
    evalCalledForGhost = true;
    return { action: "PUT", probability: 0.75, adjustedEdge: 0.12, quality: 0.8, isActionable: true };
  };

  // Avança o relógio 10 minutos além do último candle de AUDCAD_OTC (série congelada)
  const nowSec = tOld + 600 + 50; // segundo 50 da vela tOld + 600
  analyzer.tickLifecycle({ nowSec });

  assert.equal(evalCalledForGhost, false, "Série congelada não deve ser avaliada pelo Governador em tickLifecycle");

  analyzer.destroy();
});
