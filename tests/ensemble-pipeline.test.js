/**
 * ensemble-pipeline.test.js - Testes de Fusão do Ensemble, Seleção por Edge e Auditoria Multi-Ativo
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DynamicEnsemble } from "../src/strategy/ensemble/dynamic-ensemble.js";
import { EdgeSelector } from "../src/strategy/decision/edge-selector.js";
import { RegimeChangeDetector } from "../src/strategy/adaptation/regime-change-detector.js";
import { SignalAuditor } from "../src/strategy/signal-auditor.js";

test("DynamicEnsemble: Modelo discordante com baixa confiança não destrói o sinal", () => {
  const ensemble = new DynamicEnsemble();

  // Exemplo do PRD: 4 modelos apontam PUT com alta confiança, 1 aponta CALL com baixa confiança (0.48)
  const engineResults = [
    { engineId: "hierarchical_bayes", name: "Bayes", probUp: 0.41, confidence: 0.82 },
    { engineId: "adaptive_knn", name: "KNN", probUp: 0.388, confidence: 0.87 },
    { engineId: "online_logistic", name: "Logística", probUp: 0.419, confidence: 0.76 },
    { engineId: "temporal_dynamics", name: "Temporal", probUp: 0.396, confidence: 0.81 },
    { engineId: "microstructure_probabilistic", name: "Micro", probUp: 0.53, confidence: 0.48 }, // Discorda mas com menor confiança
  ];

  const report = ensemble.fuse(engineResults, { marketStability: 1.0 });

  assert.equal(report.dominantDirection, "PUT");
  assert.ok(report.probDown > 0.58, `ProbDown deve ser dominante (>58%), obtido: ${report.probDown}`);
  assert.ok(report.conservativeProbDown > 0.55, `Probabilidade conservadora deve manter Edge, obtido: ${report.conservativeProbDown}`);
});

test("RegimeChangeDetector: CUSUM detecta Change Point sem travar o sistema", () => {
  const detector = new RegimeChangeDetector({ cusumThreshold: 3.0 });
  const candles = [];
  const baseTs = 1727010000;

  // 15 candles normais
  for (let i = 0; i < 15; i++) {
    candles.push({ timestamp: baseTs + i * 60, open: 1.08, high: 1.081, low: 1.079, close: 1.0802 });
  }

  // Choque de volatilidade no 16º candle
  candles.push({ timestamp: baseTs + 15 * 60, open: 1.08, high: 1.095, low: 1.08, close: 1.094 });

  const res = detector.evaluate(candles, { r1: 0.015, sigma5: 0.001, vr3_20: 3.2 });
  assert.ok(res.isChangePoint, "Deve sinalizar Change Point no choque de volatilidade");
  assert.equal(res.uncertaintyMultiplier, 1.25, "Deve elevar a margem de incerteza temporariamente");
});

test("EdgeSelector: Decisão por Edge contra Payout e Qualidade", () => {
  const selector = new EdgeSelector({ minEdge: 0.015, minQuality: 0.50 });
  const payout = 0.80; // Breakeven = 55.6%

  const ensembleReport = {
    probUp: 0.62,
    probDown: 0.38,
    conservativeProbUp: 0.585, // 58.5% - 55.6% = +2.9% Edge
    conservativeProbDown: 0.415,
    uncertainty: 0.05,
    dominantDirection: "CALL",
    contributingEngines: [{ confidence: 0.8 }, { confidence: 0.85 }],
  };

  const decision = selector.select({ ensembleReport, payout });
  assert.equal(decision.action, "CALL");
  assert.ok(decision.edge > 0.015, `Edge deve ser > 1.5%, obtido: ${decision.edge}`);
  assert.ok(decision.ev > 0, `EV deve ser positivo, obtido: ${decision.ev}`);
});

test("SignalAuditor: Isolamento estrito multi-ativo (Zero contaminação cruzada)", () => {
  const auditor = new SignalAuditor();

  // Registra sinal em EURUSD
  auditor.recordSignal({
    action: "CALL",
    label: "CALL EURUSD",
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candleTimestamp: 1727010000,
    entryPrice: 1.0850,
    probability: 0.60,
    payout: 0.80,
  });

  // Registra sinal concorrente em AUDUSD no MESMO timestamp
  auditor.recordSignal({
    action: "PUT",
    label: "PUT AUDUSD",
    symbol: "AUDUSD",
    timeframeSeconds: 60,
    candleTimestamp: 1727010000,
    entryPrice: 0.6550,
    probability: 0.62,
    payout: 0.80,
  });

  // Vela seguinte (1727010060) fecha apenas para AUDUSD (0.6500 = WIN para PUT)
  const audCandles = [
    { timestamp: 1727010060, open: 0.6550, high: 0.6555, low: 0.6495, close: 0.6500, symbol: "AUDUSD" }
  ];

  const settledAud = auditor.auditPendingSignals(audCandles);
  assert.equal(settledAud.length, 1);
  assert.equal(settledAud[0].symbol, "AUDUSD");
  assert.equal(settledAud[0].result, "WIN");

  // EURUSD ainda DEVE estar PENDING, pois não recebeu vela de EURUSD!
  const eurSignal = auditor.signals.find((s) => s.symbol === "EURUSD");
  assert.equal(eurSignal.status, "PENDING", "Sinal do EURUSD não pode ser liquidado por vela do AUDUSD!");
});
