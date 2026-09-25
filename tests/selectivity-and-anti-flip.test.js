/**
 * selectivity-and-anti-flip.test.js
 * Validação de alta seletividade, confluência obrigatória e bloqueio anti-flip
 */

import test from "node:test";
import assert from "node:assert/strict";

import { QuantPortfolio } from "../src/strategy/quant-portfolio.js";
import { EdgeSelector } from "../src/strategy/decision/edge-selector.js";

test("Selectivity: QuantPortfolio propaga isActionable e maturity no objeto de decisão", () => {
  const qp = new QuantPortfolio();
  const candles = [];
  let price = 100.0;
  for (let i = 0; i < 30; i++) {
    candles.push({
      timestamp: 1727180000 + i * 60,
      open: price,
      high: price + 0.1,
      low: price - 0.1,
      close: price + 0.01,
      closed: true,
    });
    price += 0.01;
  }

  const res = qp.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles,
    microMetrics: null,
    isReady: true,
    dataState: "READY",
  });

  assert.notEqual(res.isActionable, undefined, "isActionable NUNCA deve ser undefined no retorno de evaluate()");
  assert.notEqual(res.maturity, undefined, "maturity NUNCA deve ser undefined no retorno de evaluate()");
  assert.equal(typeof res.isActionable, "boolean", "isActionable deve ser um boolean");
});

test("Selectivity: Conflito direcional equilibrado (CALL vs PUT) neutraliza para WAIT", () => {
  const selector = new EdgeSelector();
  const payout = 0.85;

  const candidateCall = {
    action: "CALL",
    subStrategy: "MOMENTUM_IMPULSE",
    correlationGroup: "continuation",
    edge: 0.040,
    adjustedEdge: 0.040,
    quality: 0.70,
    confidence: 0.70,
    maturity: "ACTIVE",
  };

  const candidatePut = {
    action: "PUT",
    subStrategy: "STATISTICAL_REVERSION",
    correlationGroup: "reversion",
    edge: 0.035, // Delta = 0.005 < conflictThreshold (0.025)
    adjustedEdge: 0.035,
    quality: 0.70,
    confidence: 0.70,
    maturity: "ACTIVE",
  };

  const decision = selector.selectCompetitive({
    candidates: [candidateCall, candidatePut],
    payout,
  });

  assert.equal(decision.action, "WAIT", "Conflito equilibrado entre CALL e PUT deve neutralizar para WAIT");
  assert.equal(decision.isConflict, true);
  assert.equal(decision.isActionable, false, "Decisão em conflito não pode ser acionável");
});

test("Selectivity: Estratégia sem confluência e sem alta convicção marca isActionable=false", () => {
  const selector = new EdgeSelector();
  const payout = 0.85;

  // Candidato isolado com edge modesto e qualidade moderada
  const candidateIsolated = {
    action: "CALL",
    subStrategy: "WEAK_SIGNAL",
    correlationGroup: "continuation",
    edge: 0.026,
    adjustedEdge: 0.026,
    quality: 0.62,
    confidence: 0.55,
    maturity: "ACTIVE",
  };

  const decision = selector.selectCompetitive({
    candidates: [candidateIsolated],
    payout,
  });

  assert.equal(decision.action, "CALL");
  assert.equal(decision.isActionable, false, "Sinal isolado sem confluência e sem alta convicção não deve ser acionável");
});

test("Selectivity: Confluência de 2 famílias independentes torna o sinal acionável", () => {
  const selector = new EdgeSelector();
  const payout = 0.85;

  const candidateMom = {
    action: "CALL",
    subStrategy: "IMPULSE_CONTINUATION",
    correlationGroup: "continuation",
    edge: 0.035,
    adjustedEdge: 0.035,
    quality: 0.75,
    confidence: 0.75,
    maturity: "ACTIVE",
  };

  const candidateMicro = {
    action: "CALL",
    subStrategy: "PRESSURE_IMBALANCE",
    correlationGroup: "microstructure",
    edge: 0.030,
    adjustedEdge: 0.030,
    quality: 0.72,
    confidence: 0.70,
    maturity: "ACTIVE",
  };

  const decision = selector.selectCompetitive({
    candidates: [candidateMom, candidateMicro],
    payout,
  });

  assert.equal(decision.action, "CALL");
  assert.equal(decision.isConfluence, true);
  assert.equal(decision.isActionable, true, "Confluência de 2 famílias deve ser acionável");
});
