/**
 * detectors.test.js - Testes das 8 Famílias de Detectores Contínuos e FeatureVectorBuilder
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MomentumVelocityFamily } from "../src/strategy/detectors/families/momentum-velocity.js";
import { CandleGeometryFamily } from "../src/strategy/detectors/families/candle-geometry.js";
import { VolatilityMultidimensionalFamily } from "../src/strategy/detectors/families/volatility-multidimensional.js";
import { ContinuationProbabilisticFamily } from "../src/strategy/detectors/families/continuation-probabilistic.js";
import { ReversionExhaustionFamily } from "../src/strategy/detectors/families/reversion-exhaustion.js";
import { MicrostructureIntraminuteFamily } from "../src/strategy/detectors/families/microstructure-intraminute.js";
import { PricePositioningFamily } from "../src/strategy/detectors/families/price-positioning.js";
import { SecondOrderInteractionsFamily } from "../src/strategy/detectors/families/second-order-interactions.js";
import { FeatureVectorBuilder } from "../src/strategy/detectors/feature-vector-builder.js";

function generateCandles(count = 30, trend = "bull") {
  const candles = [];
  let base = 1.0800;
  const startTs = 1727010000;

  for (let i = 0; i < count; i++) {
    const step = trend === "bull"
      ? (0.0002 + (i % 3) * 0.0001)
      : trend === "bear"
      ? -(0.0002 + (i % 3) * 0.0001)
      : (Math.sin(i) * 0.0001);
    const open = base;
    const close = base + step;
    const high = Math.max(open, close) + 0.0001;
    const low = Math.min(open, close) - 0.0001;
    base = close;

    candles.push({
      timestamp: startTs + i * 60,
      open,
      high,
      low,
      close,
      timeframeSeconds: 60,
      symbol: "EURUSD",
    });
  }
  return candles;
}

test("Detectores: Família A (Momentum e Velocidade) calcula retornos e aceleração", () => {
  const family = new MomentumVelocityFamily();
  const bullCandles = generateCandles(30, "bull");
  const { signals, rawFeatures } = family.evaluate(bullCandles);

  assert.ok(rawFeatures.r1 > 0, "r1 deve ser positivo em tendência de alta");
  assert.ok(rawFeatures.weightedReturn > 0, "Retorno ponderado deve ser positivo");
  assert.equal(signals.momentum_trend.direction, "CALL");
  assert.ok(signals.momentum_trend.strength > 0, "Força deve ser positiva");
});

test("Detectores: Família B (Geometria das Velas) calcula BodyRatio e Pavios", () => {
  const family = new CandleGeometryFamily();
  const candles = generateCandles(20, "bull");
  const { rawFeatures, signals } = family.evaluate(candles);

  assert.ok(rawFeatures.bodyRatio > 0 && rawFeatures.bodyRatio <= 1.0, "BodyRatio deve estar entre 0 e 1");
  assert.ok(rawFeatures.upperWickRatio >= 0, "UpperWickRatio deve ser >= 0");
  assert.ok(rawFeatures.lowerWickRatio >= 0, "LowerWickRatio deve ser >= 0");
  assert.ok(signals.body_dominance, "Deve produzir sinal de dominância de corpo");
});

test("Detectores: Família C (Volatilidade Multidimensional) calcula VR_3,20 e VR_5,50", () => {
  const family = new VolatilityMultidimensionalFamily();
  const candles = generateCandles(35, "bull");
  const { rawFeatures, volatilityState } = family.evaluate(candles);

  assert.ok(rawFeatures.sigma3 > 0, "sigma3 deve ser positivo");
  assert.ok(rawFeatures.sigma20 > 0, "sigma20 deve ser positivo");
  assert.ok(rawFeatures.vr3_20 > 0, "VR_3,20 deve ser positivo");
  assert.ok(typeof volatilityState === "string", "Deve retornar estado de volatilidade");
});

test("Detectores: Família D (Continuação) e Família E (Reversão e Exaustão)", () => {
  const contFamily = new ContinuationProbabilisticFamily();
  const revFamily = new ReversionExhaustionFamily();
  const candles = generateCandles(30, "bull");
  const micro = { pressure: 0.75, pressureVelocity: 0.15, tickCount: 25 };

  const contRes = contFamily.evaluate(candles, micro);
  assert.ok(contRes.signals.continuation_impulse, "Deve avaliar sinal de continuação");

  const revRes = revFamily.evaluate(candles, micro);
  assert.ok(Number.isFinite(revRes.rawFeatures.zScore), "Deve computar zScore contínuo");
});

test("Detectores: Família F (Microestrutura) e Família G (Posicionamento)", () => {
  const microFamily = new MicrostructureIntraminuteFamily();
  const posFamily = new PricePositioningFamily();

  const microMetrics = {
    tickCount: 30,
    pressure: 0.65,
    pressureVelocity: 0.10,
    pressureAcceleration: 0.05,
    timeNearHighRatio: 0.70,
    timeNearLowRatio: 0.15,
    lastTicksDirection: 1,
  };
  const microRes = microFamily.evaluate(microMetrics);
  assert.equal(microRes.signals.micro_pressure.direction, "CALL");

  const candles = generateCandles(25, "bull");
  const posRes = posFamily.evaluate(candles);
  assert.ok(posRes.rawFeatures.pos20 >= 0 && posRes.rawFeatures.pos20 <= 1.0);
});

test("Detectores: Família H (Interações de 2ª Ordem) e FeatureVectorBuilder unificado", () => {
  const builder = new FeatureVectorBuilder();
  const candles = generateCandles(30, "bull");
  const micro = { pressure: 0.60, pressureVelocity: 0.12, tickCount: 20 };

  const { vector, featureMap, signals } = builder.build(candles, micro);

  assert.ok(vector.length >= 20, `Vetor Xt deve conter dezenas de features, obtido: ${vector.length}`);
  assert.ok(featureMap.bodyXPressure !== undefined, "Deve conter interação bodyXPressure");
  assert.ok(featureMap.pressureXMomentum !== undefined, "Deve conter interação pressureXMomentum");
  assert.ok(signals.momentum_trend, "Coleção deve conter sinais contínuos");
});
