/**
 * shadow-policy.test.js
 * Teste para Etapa 7: Calibrar frequência e seletividade (política SHADOW)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { EdgeSelector } from "../src/strategy/decision/edge-selector.js";

test("Etapa 7: Candidato isolado em modo SHADOW marca isActionable=false", () => {
  const selector = new EdgeSelector({ minEdge: 0.015, minQuality: 0.50 });
  const payout = 0.85;

  const candidateShadow = {
    action: "CALL",
    name: "Strategy Prototype",
    subStrategy: "PROTO_MOMENTUM",
    strategy: "continuation",
    edge: 0.04,
    adjustedEdge: 0.04,
    conservativeProbability: 0.62,
    calibratedProbability: 0.64,
    quality: 0.70,
    confidence: 0.75,
    maturity: "SHADOW",
    reasons: ["Sinal preliminar de modelo em teste"],
  };

  const decision = selector.selectCompetitive({
    candidates: [candidateShadow],
    payout,
  });

  assert.equal(decision.action, "CALL");
  assert.equal(decision.maturity, "SHADOW");
  assert.equal(decision.isActionable, false, "Estratégia em SHADOW isolada não deve ser acionável");
  assert.ok(
    decision.reasons.some((r) => r.includes("SHADOW")),
    "Deve conter motivo indicando modo SHADOW"
  );
});

test("Etapa 7: Candidato em SHADOW com confluência de estratégia ACTIVE torna-se acionável (isActionable=true)", () => {
  const selector = new EdgeSelector({ minEdge: 0.015, minQuality: 0.50 });
  const payout = 0.85;

  const candidateShadow = {
    action: "CALL",
    name: "Strategy Prototype",
    subStrategy: "PROTO_MOMENTUM",
    strategy: "continuation",
    correlationGroup: "continuation",
    edge: 0.05,
    adjustedEdge: 0.05,
    conservativeProbability: 0.63,
    calibratedProbability: 0.65,
    quality: 0.72,
    confidence: 0.75,
    maturity: "SHADOW",
  };

  const candidateActive = {
    action: "CALL",
    name: "Vol Expansion Active",
    subStrategy: "VOL_EXPANSION",
    strategy: "volatility",
    correlationGroup: "volatility",
    edge: 0.03,
    adjustedEdge: 0.03,
    conservativeProbability: 0.60,
    calibratedProbability: 0.61,
    quality: 0.70,
    confidence: 0.70,
    maturity: "ACTIVE",
  };

  const decision = selector.selectCompetitive({
    candidates: [candidateShadow, candidateActive],
    payout,
  });

  assert.equal(decision.action, "CALL");
  assert.equal(decision.isConfluence, true, "Deve detectar confluência de grupos independentes");
  assert.equal(decision.isActionable, true, "Confluência com estratégia ACTIVE deve tornar o sinal acionável");
});
