import test from "node:test";
import assert from "node:assert/strict";
import { MarketAnalyzer } from "../src/content/analyzer.js";
import { Phase } from "../src/strategy/signal-lifecycle.js";
import { QuantPortfolio } from "../src/strategy/quant-portfolio.js";
import { AdaptiveKnnEngine } from "../src/strategy/engines/adaptive-knn-engine.js";
import { rec, swGetRecords, swResetRecords } from "../src/diagnostics/flight-recorder.js";

test("Fix 1: Em modo multi-ativo, vela fechada sem PRE_SIGNAL prévio bloqueia emissão", async () => {
  swResetRecords();
  const analyzer = new MarketAnalyzer();
  analyzer.activeSymbols.add("APPLE_OTC");
  analyzer.activeSymbols.add("ARBITRIUM_OTC");
  analyzer.activeSymbols.add("AUDCAD_OTC");
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "ARBITRIUM_OTC", tf: 60 });

  const t0 = 1727010000;
  // Aquece histórico para ARBITRIUM_OTC
  const bars = [];
  for (let i = 0; i < 30; i++) {
    bars.push({ time: t0 - (29 - i) * 60, open: 500.0, high: 500.5, low: 499.5, close: 500.0 });
  }
  analyzer.processHistoryPayload({ bars }, { pair: "ARBITRIUM_OTC", tf: 60 });

  const closedCandle = {
    symbol: "ARBITRIUM_OTC",
    timeframeSeconds: 60,
    timestamp: t0,
    open: 500.0,
    high: 500.5,
    low: 499.8,
    close: 500.4,
    closed: true,
  };
  const newCandle = {
    symbol: "ARBITRIUM_OTC",
    timeframeSeconds: 60,
    timestamp: t0 + 60,
    open: 500.4,
  };

  // Força decisão acionável no mock da estratégia
  analyzer.registry.get("ARBITRIUM_OTC").evaluate = () => ({
    action: "CALL",
    probability: 0.75,
    edge: 0.12,
    quality: 0.85,
    isActionable: true,
    subStrategy: "PERSISTENT_TICK_PRESSURE",
    reasons: ["Forçado para teste"],
  });

  // Avaliação no fechamento da vela sem que tenha havido PRE_SIGNAL do Governador
  await analyzer._evaluateOnClosedCandle("ARBITRIUM_OTC", 60, closedCandle, newCandle);

  const emits = swGetRecords().filter(e => e.type === "SIGNAL_EMIT");
  assert.equal(emits.length, 0, "Ativo sem PRE_SIGNAL em modo multi-ativo NUNCA deve emitir na virada");

  const blocked = swGetRecords().filter(e => e.type === "DECIDE_BLOCKED" && e.payload?.reason === "NO_PRE_SIGNAL_IN_MULTI_ASSET");
  assert.equal(blocked.length, 1, "Deve registrar DECIDE_BLOCKED com motivo NO_PRE_SIGNAL_IN_MULTI_ASSET");

  analyzer.destroy();
});

test("Fix 2: Cooldown de 2 velas bloqueia sinais consecutivos no mesmo par", async () => {
  swResetRecords();
  const analyzer = new MarketAnalyzer();
  analyzer.activeChannel.onChannel({ action: "subscribe", pair: "EURUSD", tf: 60 });

  const t0 = 1727010000;
  // Aquece histórico para EURUSD
  const bars = [];
  for (let i = 0; i < 30; i++) {
    bars.push({ time: t0 - (29 - i) * 60, open: 1.0850, high: 1.0860, low: 1.0840, close: 1.0855 });
  }
  analyzer.processHistoryPayload({ bars }, { pair: "EURUSD", tf: 60 });

  const candle1 = { symbol: "EURUSD", timeframeSeconds: 60, timestamp: t0, closed: true, close: 1.0850 };
  const candle2 = { symbol: "EURUSD", timeframeSeconds: 60, timestamp: t0 + 60, open: 1.0850 };

  analyzer.registry.get("EURUSD").evaluate = () => ({
    action: "CALL",
    probability: 0.75,
    edge: 0.10,
    quality: 0.80,
    isActionable: true,
    subStrategy: "IMPULSE_CONTINUATION",
  });

  // Primeiro sinal em t0 + 60
  await analyzer._evaluateOnClosedCandle("EURUSD", 60, candle1, candle2);
  const emits1 = swGetRecords().filter(e => e.type === "SIGNAL_EMIT");
  assert.equal(emits1.length, 1, "Primeiro sinal deve ser emitido");

  // Próxima vela imediatamente consecutiva (t0 + 60 para t0 + 120): ainda em cooldown!
  const candleNextClosed = { symbol: "EURUSD", timeframeSeconds: 60, timestamp: t0 + 60, closed: true, close: 1.0860 };
  const candleNextTarget = { symbol: "EURUSD", timeframeSeconds: 60, timestamp: t0 + 120, open: 1.0860 };

  await analyzer._evaluateOnClosedCandle("EURUSD", 60, candleNextClosed, candleNextTarget);
  const emits2 = swGetRecords().filter(e => e.type === "SIGNAL_EMIT");
  assert.equal(emits2.length, 1, "Vela consecutiva DEVE ser bloqueada pelo cooldown de 2 velas");

  const cooldownBlocks = swGetRecords().filter(e => e.type === "DECIDE_BLOCKED" && e.payload?.reason === "COOLDOWN_ACTIVE");
  assert.equal(cooldownBlocks.length, 1, "Deve registrar DECIDE_BLOCKED por COOLDOWN_ACTIVE");

  analyzer.destroy();
});

test("Fix 3: AdaptiveKnnEngine com moderação Bayesiana m=20 contrai pequenas amostras para 50%", () => {
  const knn = new AdaptiveKnnEngine({ kNeighbors: 12, shrinkageM: 20.0 });
  const candles = [];
  const baseTs = 1727280000;

  // 25 velas com tendência moderada
  for (let i = 0; i < 25; i++) {
    const isUp = i % 3 !== 0; // ~66% UP
    const open = 500.0 + i * 0.1;
    const close = isUp ? open + 0.15 : open - 0.15;
    candles.push({
      timestamp: baseTs + i * 60,
      open,
      high: Math.max(open, close) + 0.05,
      low: Math.min(open, close) - 0.05,
      close,
      closed: true,
    });
  }

  const res = knn.evaluate({ currentVector: [0.03, 0.7, 0.7, 0], candles });
  assert.ok(res.probUp < 0.68, `Probabilidade calibrada (${res.probUp}) deve estar contida (< 0.68) pelo prior Bayesiano`);
  assert.ok(res.probUp >= 0.50, "Probabilidade deve refletir leve viés sem superestimação");
});
