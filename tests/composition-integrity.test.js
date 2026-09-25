import test from "node:test";
import assert from "node:assert/strict";
import { SignalLifecycle, Phase } from "../src/strategy/signal-lifecycle.js";
import { CandleStore } from "../src/market/candle-store.js";
import { MarketAnalyzer } from "../src/content/analyzer.js";

test("Composition Integrity: IN_TRADE preserva métricas imutáveis mesmo com PRE_SIGNAL na vela seguinte (elimina defeito de composição dos 00:08 do vídeo)", () => {
  const lc = new SignalLifecycle();
  const pair = "ARBITRIUM_OTC";
  const tf = 60;
  const baseTs = 1727010000; // Múltiplo exato de 60s

  // 1. Aos 52s da vela baseTs, emite PRE_SIGNAL de PUT com PERSISTENT_MOMENTUM
  lc.step({
    pair,
    tf,
    nowSec: baseTs + 52,
    dataOk: true,
    decide: () => ({
      action: "PUT",
      subStrategy: "PERSISTENT_MOMENTUM",
      strategyName: "PERSISTENT_MOMENTUM",
      probability: 0.62,
      conservativeProbability: 0.60,
      edge: 0.045,
      quality: 0.75,
      reasons: ["Tendência de baixa confirmada"],
    }),
  });

  // 2. Virada da vela (baseTs + 60) -> Transição para ENTRY_NOW
  lc.step({
    pair,
    tf,
    nowSec: baseTs + 60,
    dataOk: true,
    decide: () => null,
  });

  // Abertura confirmada da vela
  lc.onCandleOpen(pair, tf, baseTs + 60, 499.50);

  // 3. Segundo baseTs + 66 -> Transição para IN_TRADE
  const snapTrade = lc.step({
    pair,
    tf,
    nowSec: baseTs + 66,
    dataOk: true,
    decide: () => null,
  });

  assert.ok(snapTrade.trade, "Trade deve estar ativo em IN_TRADE");
  assert.equal(snapTrade.trade.phase, Phase.IN_TRADE);
  assert.equal(snapTrade.trade.direction, "PUT");
  assert.equal(snapTrade.trade.subStrategy, "PERSISTENT_MOMENTUM");
  assert.equal(snapTrade.trade.edge, 0.045);
  assert.equal(snapTrade.trade.quality, 0.75);
  assert.equal(snapTrade.trade.probability, 0.62);

  // 4. Aos 52s da vela em curso (baseTs + 112s), uma NOVA oportunidade de CALL é detectada para baseTs + 120s
  const snapPreSig = lc.step({
    pair,
    tf,
    nowSec: baseTs + 112,
    dataOk: true,
    decide: () => ({
      action: "CALL",
      subStrategy: "PRESSURE_ACCELERATION",
      strategyName: "PRESSURE_ACCELERATION",
      probability: 0.72,
      conservativeProbability: 0.69,
      edge: 0.094,
      quality: 0.98,
      reasons: ["Pressão de ticks compradora acelerada"],
    }),
  });

  // 5. Verificação da Integridade da Composição:
  // O trade em curso NUNCA é contaminado pelas métricas do novo pré-sinal!
  assert.ok(snapPreSig.trade, "Trade em curso ainda deve estar presente aos 52s");
  assert.equal(snapPreSig.trade.phase, Phase.IN_TRADE);
  assert.equal(snapPreSig.trade.direction, "PUT", "Trade em curso deve manter PUT");
  assert.equal(snapPreSig.trade.subStrategy, "PERSISTENT_MOMENTUM", "Trade em curso deve manter PERSISTENT_MOMENTUM");
  assert.equal(snapPreSig.trade.edge, 0.045, "Trade em curso deve manter edge de +4.5%");
  assert.equal(snapPreSig.trade.quality, 0.75, "Trade em curso deve manter qualidade 75%");
  assert.equal(snapPreSig.trade.probability, 0.62, "Trade em curso deve manter probabilidade 62%");

  // O novo pré-sinal deve carregar suas próprias métricas de CALL
  assert.ok(snapPreSig.current, "PRE_SIGNAL deve estar ativo para a próxima vela");
  assert.equal(snapPreSig.current.phase, Phase.PRE_SIGNAL);
  assert.equal(snapPreSig.current.direction, "CALL", "Pré-sinal deve ser CALL");
  assert.equal(snapPreSig.current.subStrategy, "PRESSURE_ACCELERATION");
  assert.equal(snapPreSig.current.edge, 0.094, "Pré-sinal deve ter edge de +9.4%");
  assert.equal(snapPreSig.current.quality, 0.98, "Pré-sinal deve ter qualidade 98%");
  assert.equal(snapPreSig.current.probability, 0.72);
});

test("CandleStore: Ticks repetidos na vela N+1 nunca reabrem a vela N (closed=true permanente)", () => {
  const store = new CandleStore();
  const symbol = "BTCUSD";
  const tf = 60;
  const baseTs = 1727010000;

  // Ingestão da vela N
  store.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs,
    open: 60000,
    high: 60100,
    low: 59900,
    close: 60050,
  });

  // Chegada do primeiro tick da vela N+1 -> fecha a vela N
  const resN1 = store.ingest({
    symbol,
    timeframeSeconds: tf,
    timestamp: baseTs + tf,
    open: 60050,
    high: 60060,
    low: 60040,
    close: 60055,
  });
  assert.equal(resN1.status, "NEW_CANDLE");
  assert.equal(resN1.closedCandle.closed, true);

  // Ingestão de 30 ticks subsequentes na vela aberta N+1 (mesmo timestamp)
  for (let i = 1; i <= 30; i++) {
    const updateRes = store.ingest({
      symbol,
      timeframeSeconds: tf,
      timestamp: baseTs + tf,
      open: 60050,
      high: 60060 + i,
      low: 60040 - i,
      close: 60055 + (i % 2 === 0 ? 1 : -1),
    });
    assert.equal(updateRes.status, "UPDATED");
  }

  // A vela N deve permanecer estritamente fechada (closed === true)
  const closed = store.getClosedCandles(symbol, tf, 5);
  assert.equal(closed.length, 1, "A vela N deve constar como fechada");
  assert.equal(closed[0].timestamp, baseTs);
  assert.equal(closed[0].closed, true, "Vela N nunca pode ter closed=false");

  // A vela N+1 deve ser a vela aberta no topo
  const last = store.getLast(symbol, tf);
  assert.equal(last.timestamp, baseTs + tf);
  assert.equal(last.closed, false);
});

test("SignalLifecycle: NO_ENTRY é estado terminal para a vela-alvo quando s > 57s sem edge", () => {
  const lc = new SignalLifecycle();
  const pair = "EURUSD";
  const tf = 60;
  const baseTs = 1727010000;

  // Aos 58s sem oportunidade
  const snap58 = lc.step({
    pair,
    tf,
    nowSec: baseTs + 58,
    dataOk: true,
    decide: () => null,
  });

  assert.equal(snap58.current.phase, Phase.NO_ENTRY);

  // Aos 59s mesmo se decide() tentasse retornar um sinal, NO_ENTRY não deve aceitar
  const snap59 = lc.step({
    pair,
    tf,
    nowSec: baseTs + 59,
    dataOk: true,
    decide: () => ({ action: "CALL", probability: 0.80 }),
  });

  assert.equal(snap59.current.phase, Phase.NO_ENTRY, "NO_ENTRY é irreversível para o ciclo atual");
  assert.equal(snap59.current.direction, null);
});

test("Multi-Asset Isolation: MarketAnalyzer mantém decisões isoladas por símbolo sem cair em 50%", () => {
  const analyzer = new MarketAnalyzer();
  const pair1 = "EURUSD";
  const pair2 = "BTCUSD";

  analyzer.activeSymbols.add(pair1);
  analyzer.activeSymbols.add(pair2);
  analyzer.currentSymbol = pair1;

  // Armazena decisões para ambos os símbolos
  const dec1 = { action: "CALL", symbol: pair1, probability: 0.68, edge: 0.06, quality: 0.85, subStrategy: "IMPULSE" };
  const dec2 = { action: "PUT", symbol: pair2, probability: 0.63, edge: 0.04, quality: 0.78, subStrategy: "EXHAUSTION" };

  analyzer.decisionsBySymbol.set(pair1, dec1);
  analyzer.decisionsBySymbol.set(pair2, dec2);

  const panelData = analyzer.buildPanelData();
  const symMap = panelData.symbols;

  assert.ok(symMap[pair1], "symMap deve conter pair1");
  assert.ok(symMap[pair2], "symMap deve conter pair2");

  // Pair1 mantém suas métricas
  assert.equal(symMap[pair1].quantProbability, 0.68);
  assert.equal(symMap[pair1].edge, 0.06);
  assert.equal(symMap[pair1].quality, 0.85);

  // Pair2 (secundário) NÃO cai no fallback de 50% nem de edge 0!
  assert.equal(symMap[pair2].quantProbability, 0.63, "Ativo secundário não pode cair em 50%");
  assert.equal(symMap[pair2].edge, 0.04, "Ativo secundário não pode ter edge zerado");
  assert.equal(symMap[pair2].quality, 0.78, "Ativo secundário deve manter qualidade real");
});
