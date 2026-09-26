import test from 'node:test';
import assert from 'node:assert/strict';

import { IntraminuteTracker } from '../src/market/intraminute-tracker.js';
import { AdaptiveKnnEngine } from '../src/strategy/engines/adaptive-knn-engine.js';
import { OpportunityPool, computeWilsonLowerBound } from '../src/strategy/pool/opportunity-pool.js';
import { EdgeSelector } from '../src/strategy/decision/edge-selector.js';
import { ContinuationFamily } from '../src/strategy/strategies/continuation-family.js';
import { ReversionFamily } from '../src/strategy/strategies/reversion-family.js';
import { MicrostructureFamily } from '../src/strategy/strategies/microstructure-family.js';

test('ActiveQuant 1: Cinemática de Ticks (Derivadas 1ª/2ª, Pressão de Fluxo Não-Linear e Densidade de Duração)', () => {
  const tracker = new IntraminuteTracker();
  const baseTs = 1711110000000;

  const ticks = [
    { price: 100.00, ts: baseTs + 1000 },
    { price: 100.25, ts: baseTs + 5000 },
    { price: 100.60, ts: baseTs + 10000 },
    { price: 101.05, ts: baseTs + 20000 },
    { price: 101.55, ts: baseTs + 30000 },
    { price: 101.95, ts: baseTs + 38000 },
    { price: 101.98, ts: baseTs + 39000 },
    { price: 101.981, ts: baseTs + 41000 },
    { price: 101.982, ts: baseTs + 42000 },
  ];

  for (const t of ticks) {
    tracker.recordTick('EURUSD_OTC', 60, t.price, baseTs, t.ts);
  }

  const metrics = tracker.getCurrentMetrics('EURUSD_OTC', 60, 100.00, 101.982, 100.00, 101.982);
  assert.ok(metrics, 'Métricas devem existir');
  assert.ok(metrics.priceVelocity >= 0, `Velocidade terminal deve ser não-negativa, obtido ${metrics.priceVelocity}`);
  assert.ok(metrics.priceAcceleration < 0, `Aceleração terminal deve ser negativa (frenagem), obtido ${metrics.priceAcceleration}`);
  assert.ok(metrics.kinematicRejection < 0, `Rejeição cinemática deve ser negativa (sinalizando exaustão compradora/PUT), obtido ${metrics.kinematicRejection}`);
  assert.ok(metrics.integratedFlowPressure > 0, `Integral de fluxo não-linear deve refletir pressão compradora acumulada, obtido ${metrics.integratedFlowPressure}`);

  assert.equal(metrics.durationDensity.length, 5);
  const sumBins = metrics.durationDensity.reduce((acc, v) => acc + v, 0);
  assert.ok(Math.abs(sumBins - 1) < 1e-3, `Soma dos 5 quantis de duração deve ser ~1.0, obtido ${sumBins}`);
});

test('ActiveQuant 2: Beta-Binomial com Fator de Esquecimento (lambda), Limite Inferior de Wilson e SGD Online', () => {
  const pool = new OpportunityPool({
    minEdge: 0.015,
    forgettingLambda: 0.985,
    learningRateEta: 0.08,
    priorStrengthM: 12.0,
  });

  const wLowN = computeWilsonLowerBound(0.65, 12, 1.0);
  const wHighN = computeWilsonLowerBound(0.65, 120, 1.0);
  assert.ok(wHighN > wLowN, `Wilson lower bound deve convergir para pHat conforme n cresce (${wHighN} > ${wLowN})`);
  assert.ok(wHighN < 0.65, 'Wilson lower bound deve ser menor que pHat');

  for (let i = 0; i < 25; i++) {
    pool.recordOutcome('IMPULSE_CONTINUATION', 'CALL', 0.64, 1, ['IMPULSE_CONTINUATION']);
  }

  const candidates = pool.process([
    {
      strategy: 'CONTINUATION',
      subStrategy: 'IMPULSE_CONTINUATION',
      correlationGroup: 'MOMENTUM',
      direction: 'CALL',
      rawProbability: 0.65,
      conservativeProbability: 0.60,
      breakevenProbability: 0.5556,
      edge: 0.0444,
      uncertainty: 0.028,
      quality: 0.80,
      maturity: 'ACTIVE',
    },
  ], { payout: 0.80 });

  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.ok(c.omegaWeight > 1.0, `Peso SGD omega deve aumentar após sequência de vitórias, obtido ${c.omegaWeight}`);
  assert.ok(c.sampleInfo.rollingAccuracy > 0.70, `Precisão Beta-Binomial deve subir acima de 0.70, obtido ${c.sampleInfo.rollingAccuracy}`);
  assert.ok(c.conservativeProbability > 0.5556, `Probabilidade conservadora (Wilson) deve superar p_be (0.5556), obtido ${c.conservativeProbability}`);
});

test('ActiveQuant 3: Distância Elástica KNN (Wasserstein-1 + Sakoe-Chiba Band DTW)', () => {
  const knn = new AdaptiveKnnEngine({ kNeighbors: 8 });

  const candles = [];
  for (let i = 0; i < 30; i++) {
    const isSetup = i % 2 === 0;
    candles.push({
      open: 100.0,
      high: 101.0,
      low: 99.8,
      close: isSetup ? 100.9 : 99.85,
      closed: true,
    });
  }
  candles.push({
    open: 100.0,
    high: 101.0,
    low: 99.8,
    close: 100.9,
    closed: true,
  });

  const res = knn.evaluate({
    currentVector: [0.009, 0.916, 0.75],
    candles,
    microMetrics: {
      durationDensity: [0.05, 0.10, 0.15, 0.25, 0.45],
    },
  });

  assert.ok(res.effectiveN > 0, `N efetivo deve ser positivo, obtido ${res.effectiveN}`);
  assert.ok(res.probDown > 0.55, `Probabilidade KNN ponderada por Wasserstein+DTW deve detectar padrão PUT, obtido ${res.probDown}`);
  assert.ok(Number.isFinite(res.wassersteinDistance), 'Distância de Wasserstein-1 deve ser calculada');
  assert.ok(Number.isFinite(res.dtwDistance), 'Distância DTW deve ser calculada');
});

test('ActiveQuant 4: Sistema de Veto Matemático 21x21 (Covariância e P(Loss | S1 ∩ S2) > 0.52)', () => {
  const pool = new OpportunityPool();
  const selector = new EdgeSelector({ minEdge: 0.015, minQuality: 0.60 });

  for (let i = 0; i < 12; i++) {
    pool.recordOutcome('IMPULSE_CONTINUATION', 'CALL', 0.62, 0, ['IMPULSE_CONTINUATION', 'EXACT_LOCAL_ANALOGY']);
  }

  const dep = pool.getPairwiseDependency('IMPULSE_CONTINUATION', 'EXACT_LOCAL_ANALOGY');
  assert.ok(dep.conditionalLossRate > 0.52, `P(Loss | S1 ∩ S2) deve exceder 0.52, obtido ${dep.conditionalLossRate}`);

  const rawCands = [
    {
      strategy: 'CONTINUATION',
      subStrategy: 'IMPULSE_CONTINUATION',
      correlationGroup: 'MOMENTUM',
      direction: 'CALL',
      action: 'CALL',
      rawProbability: 0.66,
      conservativeProbability: 0.60,
      edge: 0.0444,
      adjustedEdge: 0.0355,
      quality: 0.80,
      maturity: 'ACTIVE',
      maturityScore: 1.0,
    },
    {
      strategy: 'HISTORICAL_ANALOGY',
      subStrategy: 'EXACT_LOCAL_ANALOGY',
      correlationGroup: 'ANALOGY',
      direction: 'CALL',
      action: 'CALL',
      rawProbability: 0.64,
      conservativeProbability: 0.59,
      edge: 0.0344,
      adjustedEdge: 0.0275,
      quality: 0.80,
      maturity: 'ACTIVE',
      maturityScore: 1.0,
    },
  ];

  const decision = selector.selectCompetitive({
    candidates: rawCands,
    payout: 0.80,
    opportunityPool: pool,
  });

  assert.ok(decision.adjustedEdge < 0.0355, `AdjustedEdge deve sofrer contração covariante (${decision.adjustedEdge} < 0.0355)`);
  assert.equal(decision.isActionable, false, 'Confluência correlacionada na derrota deve ser bloqueada (isActionable = false)');
  assert.ok(decision.reasons[0].includes('Veto Bayesiano Condicional'), `Razão deve explicitar o Veto Bayesiano Condicional, obtido: ${decision.reasons[0]}`);
});

test('ActiveQuant 5: Calibração das 21 Subestratégias (Trava Anti-Exaustão, Correção Algébrica u0/u1/u2 e Guarda Estrutural de Microestrutura)', () => {
  const contFamily = new ContinuationFamily();
  const revFamily = new ReversionFamily();
  const microFamily = new MicrostructureFamily();

  // Base de 22 velas com ATR ~ 1.0
  const baseCandles = [];
  let p = 500.0;
  for (let i = 0; i < 20; i++) {
    const open = p;
    const close = p + (i % 2 === 0 ? 0.4 : -0.35);
    baseCandles.push({
      timestamp: 1727000000 + i * 60,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      closed: true,
    });
    p = close;
  }

  // 1. Vela esticada em clímax (range > 2.5x ATR e zScore = 2.4): ContinuationFamily DEVE bloquear compra de topo!
  const climaxCandles = [
    ...baseCandles,
    { timestamp: 1727001200, open: p, high: p + 0.8, low: p - 0.1, close: p + 0.7, closed: true },
    { timestamp: 1727001260, open: p + 0.7, high: p + 3.8, low: p + 0.6, close: p + 3.7, closed: true },
  ];
  const climaxOpps = contFamily.evaluate({
    candles: climaxCandles,
    featureMap: { zScore20: 2.40 },
    microMetrics: { pressure: 0.60, integratedFlowPressure: 0.65 },
    payout: 0.80,
  });
  assert.equal(
    climaxOpps.filter((o) => o.subStrategy === 'IMPULSE_CONTINUATION' && o.direction === 'CALL').length,
    0,
    'IMPULSE_CONTINUATION deve bloquear CALL quando a vela está em exaustão extrema (Z=2.40, range > 2.2 ATR)'
  );

  // 2. Micro-vela Doji com pavio de 45% (range = 0.20 << 0.85 ATR): ReversionFamily DEVE ignorar ruído em WICK_REJECTION
  const tinyDojiCandles = [
    ...baseCandles,
    { timestamp: 1727001200, open: p, high: p + 0.5, low: p - 0.5, close: p + 0.1, closed: true },
    { timestamp: 1727001260, open: p + 0.1, high: p + 0.20, low: p + 0.02, close: p + 0.08, closed: true }, // range = 0.18 (~0.18 ATR)
  ];
  const dojiRevOpps = revFamily.evaluate({
    candles: tinyDojiCandles,
    featureMap: { zScore20: 1.30 },
    microMetrics: { pressure: -0.10 },
    payout: 0.80,
  });
  assert.equal(
    dojiRevOpps.filter((o) => o.subStrategy === 'WICK_REJECTION').length,
    0,
    'WICK_REJECTION não pode disparar em micro-vela sem amplitude relevante (< 0.85 ATR)'
  );

  // 3. MicrostructureFamily ancorada nas velas: bloqueia CALL de fluxo quando a vela deixa pavio superior gigante de rejeição (upperWick = 55%)
  const rejectedTopCandles = [
    ...baseCandles,
    { timestamp: 1727001200, open: p, high: p + 1.5, low: p - 0.1, close: p + 0.5, closed: true }, // upperWick = 1.0 / 1.6 = 62.5%
  ];
  const microBlocked = microFamily.evaluate({
    candles: rejectedTopCandles,
    microMetrics: {
      tickCount: 30,
      pressure: 0.70,
      integratedFlowPressure: 0.72,
      flowImbalance: 0.50,
      lastTicksDirection: 1,
    },
    payout: 0.80,
  });
  assert.equal(
    microBlocked.filter((o) => o.direction === 'CALL').length,
    0,
    'MicrostructureFamily deve bloquear CALL quando a vela no gráfico deixou pavio superior de rejeição > 34%'
  );
});
