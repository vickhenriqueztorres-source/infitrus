import test from 'node:test';
import assert from 'node:assert/strict';

import { IntraminuteTracker } from '../src/market/intraminute-tracker.js';
import { AdaptiveKnnEngine } from '../src/strategy/engines/adaptive-knn-engine.js';
import { OpportunityPool, computeWilsonLowerBound } from '../src/strategy/pool/opportunity-pool.js';
import { EdgeSelector } from '../src/strategy/decision/edge-selector.js';

test('ActiveQuant 1: Cinemática de Ticks (Derivadas 1ª/2ª, Pressão de Fluxo Não-Linear e Densidade de Duração)', () => {
  const tracker = new IntraminuteTracker();
  const baseTs = 1711110000000; // início exato do minuto

  // Impulso inicial forte de alta seguido de desaceleração brusca no terço final (t >= 40s)
  const ticks = [
    { price: 100.00, ts: baseTs + 1000 },
    { price: 100.25, ts: baseTs + 5000 },
    { price: 100.60, ts: baseTs + 10000 },
    { price: 101.05, ts: baseTs + 20000 },
    { price: 101.55, ts: baseTs + 30000 },
    { price: 101.95, ts: baseTs + 38000 }, // alta velocidade
    { price: 101.98, ts: baseTs + 39000 }, // pico de velocidade: +0.03/s
    { price: 101.981, ts: baseTs + 41000 }, // desaceleração brusca: dv/dt << 0
    { price: 101.982, ts: baseTs + 42000 }, // frenagem terminal mantendo v > 0 e a << 0
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

  // Verifica se a densidade de duração (5 bins) soma ~1.0
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

  // Limite de Wilson analítico deve ser monotônico com nEff e pHat
  const wLowN = computeWilsonLowerBound(0.65, 12, 1.0);
  const wHighN = computeWilsonLowerBound(0.65, 120, 1.0);
  assert.ok(wHighN > wLowN, `Wilson lower bound deve convergir para pHat conforme n cresce (${wHighN} > ${wLowN})`);
  assert.ok(wHighN < 0.65, 'Wilson lower bound deve ser menor que pHat');

  // Simula 25 vitórias consecutivas para sub-estratégia IMPULSE_CONTINUATION
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

  // Cria série de 30 velas onde velas com fechamento no topo revertem na vela seguinte (PUT)
  const candles = [];
  for (let i = 0; i < 30; i++) {
    const isSetup = i % 2 === 0;
    candles.push({
      open: 100.0,
      high: 101.0,
      low: 99.8,
      close: isSetup ? 100.9 : 99.85, // setup fecha alto, vela seguinte (i+1) fecha abaixo da abertura (outcomeUp = 0)
      closed: true,
    });
  }
  // Garante que a última vela (n-1) seja um setup idêntico aos pares
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

  // Registra 12 derrotas conjuntas quando IMPULSE_CONTINUATION e EXACT_LOCAL_ANALOGY ativam juntas
  for (let i = 0; i < 12; i++) {
    pool.recordOutcome('IMPULSE_CONTINUATION', 'CALL', 0.62, 0, ['IMPULSE_CONTINUATION', 'EXACT_LOCAL_ANALOGY']);
  }

  const dep = pool.getPairwiseDependency('IMPULSE_CONTINUATION', 'EXACT_LOCAL_ANALOGY');
  assert.ok(dep.conditionalLossRate > 0.52, `P(Loss | S1 ∩ S2) deve exceder 0.52, obtido ${dep.conditionalLossRate}`);

  // Mesmo que ambas tenham métricas individuais fortes e pertençam a famílias distintas, o seletor deve vetar a confluência
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
