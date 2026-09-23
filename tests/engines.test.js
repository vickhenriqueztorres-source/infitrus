/**
 * engines.test.js - Testes dos 5 Motores Probabilísticos M1
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";
import { HierarchicalBayesEngine } from "../src/strategy/engines/hierarchical-bayes-engine.js";
import { AdaptiveKnnEngine } from "../src/strategy/engines/adaptive-knn-engine.js";
import { OnlineLogisticEngine } from "../src/strategy/engines/online-logistic-engine.js";
import { TemporalDynamicsEngine } from "../src/strategy/engines/temporal-dynamics-engine.js";
import { MicrostructureProbabilisticEngine } from "../src/strategy/engines/microstructure-probabilistic-engine.js";

function getSampleCandles(count = 25) {
  const candles = [];
  let base = 1.0800;
  for (let i = 0; i < count; i++) {
    const open = base;
    const close = base + 0.0002;
    candles.push({
      timestamp: 1727010000 + i * 60,
      open,
      high: close + 0.0001,
      low: open - 0.0001,
      close,
      symbol: "EURUSD",
    });
    base = close;
  }
  return candles;
}

test("Motor 1 (Bayes Hierárquico): Partial pooling herda informação de cenários pai", () => {
  const bayes = new HierarchicalBayesEngine({ shrinkageM: 10 });
  const candles = getSampleCandles(20);

  // Treina o contexto pai com 50 ocorrências de alta
  for (let i = 0; i < 50; i++) {
    bayes.update({ keyParent: "L1_normal_UP", keySpecific: "L2_other" }, 1);
  }

  // Avalia um cenário específico novo (n=0 amostras filhas) no mesmo contexto pai
  const res = bayes.evaluate({
    rawFeatures: { r1: 0.0005, r3: 0.0015, bodyRatio: 0.70, pressure: 0.40 },
    volatilityState: "normal",
    candles,
  });

  assert.ok(res.probUp > 0.55, `ProbUp deve herdar viés de alta do pai via pooling, obtido: ${res.probUp}`);
  assert.ok(res.confidence >= 0.40, "Confiança deve ser válida");
});

test("Motor 2 (KNN Adaptativo): Ponderação dual por distância e recência", () => {
  const knn = new AdaptiveKnnEngine({ tauDistance: 2.5, lambdaAge: 0.01 });
  const candles = getSampleCandles(35);
  const currentVector = [1.2, -0.5, 0.8, 1.5, 0.2];

  const res = knn.evaluate({ currentVector, candles });

  assert.ok(res.probUp >= 0.20 && res.probUp <= 0.80, "ProbUp deve estar no intervalo calibrado");
  assert.ok(res.confidence > 0, "Confiança deve ser positiva");
  assert.ok(res.effectiveN >= 0, "Tamanho amostral efetivo deve ser computado");
});

test("Motor 3 (Logística Online): Atualização SGD com regularização L2", () => {
  const logEngine = new OnlineLogisticEngine({ learningRate: 0.1, l2Penalty: 0.01 });
  const vector = [1.0, 0.5, -0.8];

  // Predição inicial (pesos zerados) deve ser neutra (50%)
  const initial = logEngine.evaluate({ currentVector: vector });
  assert.equal(initial.probUp, 0.50);

  // Treina com 10 resultados positivos consecutivos
  for (let i = 0; i < 10; i++) {
    logEngine.update(vector, 1);
  }

  const trained = logEngine.evaluate({ currentVector: vector });
  assert.ok(trained.probUp > 0.55, `Após aprendizado de alta, probUp deve aumentar, obtido: ${trained.probUp}`);
});

test("Motor 4 (Dinâmica Temporal): Sensibilidade à trajetória de pressão", () => {
  const tempEngine = new TemporalDynamicsEngine({ maxWindow: 4 });
  const candles = getSampleCandles(15);

  // Simula trajetória de pressão crescente: 0.2 -> 0.4 -> 0.6 -> 0.8
  const pressures = [0.2, 0.4, 0.6, 0.8];
  let res;
  for (const p of pressures) {
    res = tempEngine.evaluate({
      rawFeatures: { r1: 0.0003, pressure: p, bodyRatio: 0.7, priceAcceleration: 0.00001 },
      candles,
    });
  }

  assert.ok(res.probUp > 0.58, `Trajetória acelerada de pressão deve favorecer CALL, obtido: ${res.probUp}`);
  assert.ok(res.trajectorySlope > 0, "Inclinação da trajetória deve ser positiva");
});

test("Motor 5 (Microestrutura Probabilística): P(CALL|ticks) independente de candles", () => {
  const microEngine = new MicrostructureProbabilisticEngine();

  // Fluxo fortemente comprador nos ticks
  const bullMetrics = {
    tickCount: 35,
    pressure: 0.72,
    pressureVelocity: 0.20,
    timeNearHighRatio: 0.75,
    timeNearLowRatio: 0.10,
    lastTicksDirection: 1,
  };

  const res = microEngine.evaluate({ microMetrics: bullMetrics });
  assert.ok(res.probUp > 0.60, `Microestrutura compradora deve gerar probUp elevada, obtido: ${res.probUp}`);
  assert.ok(res.confidence > 0.70, "Confiança com 35 ticks deve ser alta");
});
