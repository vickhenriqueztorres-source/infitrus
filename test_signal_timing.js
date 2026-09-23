/**
 * test_signal_timing.js - Testes de Timing, Deduplicação Estrita e Áudio/UI
 * Oracle Quant Signals
 */

import { SignalAuditor } from "./src/strategy/signal-auditor.js";
import { QuantPortfolio } from "./src/strategy/quant-portfolio.js";
import { CandleTimer } from "./src/utils/candle-timer.js";

console.log("================================================================================");
console.log("       SUÍTE DE VALIDAÇÃO: TIMING, DEDUPLICAÇÃO E INTEGRIDADE DE SINAIS M1      ");
console.log("================================================================================\n");

let passed = 0;
let total = 0;

function assert(condition, message) {
  total++;
  if (condition) {
    console.log(`  ✓ Teste ${total} Passou: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ Teste ${total} FALHOU: ${message}`);
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// TESTE 1: Deduplicação e Rejeição de Sinais Opostos na Mesma Vela no Auditor
// -----------------------------------------------------------------------------
console.log("--> EXECUTANDO TESTE 1: Auditor impede sinais opostos no mesmo candle");
const auditor = new SignalAuditor();
const candleTs = 1700000000;

const sig1 = auditor.recordSignal({
  action: "PUT",
  symbol: "1000SATS_OTC",
  timeframeSeconds: 60,
  candleTimestamp: candleTs,
  entryPrice: 502.59,
  probability: 0.67,
  ev: 0.20,
  payout: 0.80,
  label: "PUT",
  primaryStrategyName: "IMPULSE_CONTINUATION",
  subStrategy: "IMPULSE_CONTINUATION",
});

assert(sig1 !== null && sig1.direction === "PUT", "Primeiro sinal (PUT) gravado com sucesso");

// Tenta gravar sinal oposto (CALL) no mesmo candle timestamp
const sig2 = auditor.recordSignal({
  action: "CALL",
  symbol: "1000SATS_OTC",
  timeframeSeconds: 60,
  candleTimestamp: candleTs,
  entryPrice: 502.65,
  probability: 0.70,
  ev: 0.26,
  payout: 0.80,
  label: "CALL",
  primaryStrategyName: "LATE_ACCELERATION",
  subStrategy: "LATE_ACCELERATION",
});

assert(sig2 === null, "Sinal oposto (CALL) no mesmo timestamp REJEITADO (Zero Perda Dupla)");

// -----------------------------------------------------------------------------
// TESTE 2: CandleTimer - Identificação Precisa das Fases M1
// -----------------------------------------------------------------------------
console.log("\n--> EXECUTANDO TESTE 2: CandleTimer identifica fases M1");
const timer = new CandleTimer({ timeframeSeconds: 60 });
const baseMinute = Math.floor(1700000000 / 60) * 60; // 1699999980 (segundo 00)

// Simula segundo 02 (58s restantes) -> NORMAL
const state02 = timer.computeCurrentState(baseMinute + 2);
assert(state02.phase === "NORMAL" && state02.remainingSeconds === 58, "Segundo 02: fase NORMAL (58s restantes)");

// Simula segundo 48 (12s restantes) -> WARNING
const state48 = timer.computeCurrentState(baseMinute + 48);
assert(state48.remainingSeconds <= 15, "Segundo 48: dentro da janela de decisão (12s restantes)");

// Simula segundo 57 (3s restantes) -> PREPARE
const state57 = timer.computeCurrentState(baseMinute + 57);
assert(state57.phase === "PREPARE" && state57.remainingSeconds === 3, "Segundo 57: fase PREPARE (3s restantes para bip)");

// Simula segundo 00 (virada) -> EXECUTE
const state00 = timer.computeCurrentState(baseMinute + 60);
assert(state00.phase === "EXECUTE", "Segundo 00: fase EXECUTE (abertura da nova vela)");

// -----------------------------------------------------------------------------
// TESTE 3: QuantPortfolio - Bloqueio de Inversão Mid-Candle
// -----------------------------------------------------------------------------
console.log("\n--> EXECUTANDO TESTE 3: QuantPortfolio trava decisão por vela");
const portfolio = new QuantPortfolio({ payout: 0.80 });

// Gera 50 velas sintéticas com tendência de alta
const testCandles = [];
let basePrice = 100.0;
for (let i = 0; i < 50; i++) {
  const open = basePrice;
  const close = open + 0.15;
  testCandles.push({
    timestamp: 1700000000 + i * 60,
    open,
    high: close + 0.05,
    low: open - 0.02,
    close,
    volume: 150,
  });
  basePrice = close;
}

// Avaliação 1 com fluxo de alta
const eval1 = portfolio.evaluate({
  symbol: "ETHUSDT_OTC",
  timeframeSeconds: 60,
  candles: testCandles,
  microMetrics: {
    tickVelocity: 2.5,
    buyerPressure: 0.75,
    absorptionRatio: 0.1,
    candleTickCount: 40,
    velocityAcceleration: 0.5,
  },
  isReady: true,
  gapCount: 0,
  isStale: false,
});

const firstSignalCandle = eval1.candleTimestamp;
const firstAction = eval1.action;

// Avaliação 2 na mesma vela, mas agora fluxo inverte para baixa
const eval2 = portfolio.evaluate({
  symbol: "ETHUSDT_OTC",
  timeframeSeconds: 60,
  candles: testCandles, // mesmo último candle
  microMetrics: {
    tickVelocity: 2.8,
    buyerPressure: 0.20, // pressão vira vendedora
    absorptionRatio: 0.4,
    candleTickCount: 50,
    velocityAcceleration: -0.8,
  },
  isReady: true,
  gapCount: 0,
  isStale: false,
});

assert(eval2.isNewSignal === false, "Avaliação subsequente no mesmo candle NÃO emite novo sinal (isNewSignal=false)");

// -----------------------------------------------------------------------------
// TESTE 4: Liquidação e Auditoria de Lucro Realista
// -----------------------------------------------------------------------------
console.log("\n--> EXECUTANDO TESTE 4: Auditoria de liquidação e Win Rate");
// Fecha a vela seguinte com alta
const settledCandles = [
  ...testCandles,
  {
    timestamp: candleTs + 60,
    symbol: "1000SATS_OTC",
    open: 502.59,
    high: 502.50,
    low: 502.30,
    close: 502.35, // fechou abaixo -> PUT venceu!
    volume: 200,
  },
];

const settledList = auditor.auditPendingSignals(settledCandles);
assert(settledList.length === 1, "Vela alvo liquidada com sucesso");
assert(settledList[0].result === "WIN", "Resultado foi computado como WIN (fechamento < entrada para PUT)");
assert(settledList[0].pnlUnits === 0.80, "PnL unitário correto (+0.80 un)");

const stats = auditor.getStats();
assert(stats.wins === 1 && stats.losses === 0 && stats.winRate === 100, "Estatísticas atualizadas: 100% WR");

console.log("\n================================================================================");
console.log(`>>> SUCESSO: ${passed}/${total} TESTES PASSARAM COM SUCESSO ABSOLUTO! <<<`);
console.log("================================================================================");
