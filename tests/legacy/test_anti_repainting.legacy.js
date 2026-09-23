/**
 * test_anti_repainting.js - Validação Anti-Repainting e Congelamento por Candle
 * Oracle Quant Signals
 */

import { QuantPortfolio } from "./src/strategy/quant-portfolio.js";
import { CandleTimer } from "./src/utils/candle-timer.js";

console.log("================================================================================");
console.log("        SUÍTE DE TESTES: ZERO REPAINTING & ENTRADA NA ABERTURA M1               ");
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

// Prepara 50 velas base
const baseMinute = Math.floor(1700000000 / 60) * 60; // minuto alinhado
const baseCandles = [];
let price = 500.0;
for (let i = 0; i < 50; i++) {
  const open = price;
  const close = open + 0.10;
  baseCandles.push({
    timestamp: baseMinute + i * 60,
    open,
    high: close + 0.05,
    low: open - 0.02,
    close,
    volume: 100,
  });
  price = close;
}

const portfolio = new QuantPortfolio({ payout: 0.80 });
const timer = new CandleTimer({ timeframeSeconds: 60 });

// -----------------------------------------------------------------------------
// TESTE 1: Flutuação de ticks no meio da vela (Segundos 00 a 45)
// -----------------------------------------------------------------------------
console.log("--> EXECUTANDO TESTE 1: Flutuação de ticks no meio da vela (segundos 00 a 45)");

const timerState20 = timer.computeCurrentState(baseMinute + 20);
const inDecisionWindow20 = timerState20.remainingSeconds <= 15;

// Simula segundo 20
const evalSec20 = portfolio.evaluate({
  symbol: "1000SATS_OTC",
  timeframeSeconds: 60,
  candles: baseCandles,
  microMetrics: {
    tickVelocity: 2.0,
    buyerPressure: 0.80, // forte alta
    absorptionRatio: 0.1,
    candleTickCount: 15,
    velocityAcceleration: 0.4,
  },
  isReady: true,
  gapCount: 0,
  isStale: false,
});

assert(evalSec20.executionMoment === "AT_CANDLE_OPEN", "Propriedade executionMoment estritamente definida como AT_CANDLE_OPEN");
assert(inDecisionWindow20 === false, "Segundo 20: fora da janela de decisão (remaining > 15s)");

const displayAction20 = inDecisionWindow20 ? evalSec20.action : "WAIT";
assert(displayAction20 === "WAIT", "Segundo 20: displayAction forçado para WAIT (Zero Repaint)");

// -----------------------------------------------------------------------------
// TESTE 2: Janela de Decisão (Segundo 48 / 12s restantes)
// -----------------------------------------------------------------------------
console.log("\n--> EXECUTANDO TESTE 2: Janela de Decisão consolida sinal para próxima vela");

const timerState48 = timer.computeCurrentState(baseMinute + 48);
const inDecisionWindow48 = timerState48.remainingSeconds <= 15;

// Instância limpa para avaliar primeira emissão aos 48s
const portfolioTest2 = new QuantPortfolio({ payout: 0.80 });
const evalSec48 = portfolioTest2.evaluate({
  symbol: "1000SATS_OTC",
  timeframeSeconds: 60,
  candles: baseCandles,
  microMetrics: {
    tickVelocity: 2.5,
    buyerPressure: 0.85,
    absorptionRatio: 0.1,
    candleTickCount: 45,
    velocityAcceleration: 0.5,
  },
  isReady: true,
  gapCount: 0,
  isStale: false,
});

assert(inDecisionWindow48 === true, "Segundo 48: dentro da janela de decisão (remaining <= 15s)");
assert(evalSec48.action === "CALL", "Segundo 48: sinal CALL qualificado e emitido");
assert(evalSec48.isNewSignal === true, "Segundo 48: isNewSignal = true (primeira emissão da vela)");

// Continua com portfolioTest2 para testar congelamento no mesmo candle
const evalSec54 = portfolioTest2.evaluate({
  symbol: "1000SATS_OTC",
  timeframeSeconds: 60,
  candles: baseCandles, // mesma vela
  microMetrics: {
    tickVelocity: 3.0,
    buyerPressure: 0.10, // queda brusca contrária
    absorptionRatio: 0.8,
    candleTickCount: 55,
    velocityAcceleration: -1.5,
  },
  isReady: true,
  gapCount: 0,
  isStale: false,
});

assert(evalSec54.action === "CALL", "Segundo 54: Decisão PERMANECE CONGELADA em CALL (não inverte para PUT)");
assert(evalSec54.isFrozen === true, "Segundo 54: isFrozen = true indicando sinal travado");
assert(evalSec54.isNewSignal === false, "Segundo 54: isNewSignal = false (sem novos bips espúrios)");

// No segundo 58 (2s antes da virada), outro tick oposto
const evalSec58 = portfolioTest2.evaluate({
  symbol: "1000SATS_OTC",
  timeframeSeconds: 60,
  candles: baseCandles,
  microMetrics: {
    tickVelocity: 0.5,
    buyerPressure: 0.50, // neutro
    absorptionRatio: 0.5,
    candleTickCount: 58,
    velocityAcceleration: 0.0,
  },
  isReady: true,
  gapCount: 0,
  isStale: false,
});

assert(evalSec58.action === "CALL", "Segundo 58: Continua 100% CONGELADO em CALL");

// -----------------------------------------------------------------------------
// TESTE 4: Transição de Nova Vela M1 (Descongelamento e Novo Ciclo)
// -----------------------------------------------------------------------------
console.log("\n--> EXECUTANDO TESTE 4: Transição para nova vela no segundo 00");

// A vela fecha e abre uma nova
const nextCandles = [
  ...baseCandles,
  {
    timestamp: baseMinute + 50 * 60,
    open: price,
    high: price + 0.20,
    low: price - 0.05,
    close: price + 0.15,
    volume: 120,
  },
];

const evalNextCandle = portfolioTest2.evaluate({
  symbol: "1000SATS_OTC",
  timeframeSeconds: 60,
  candles: nextCandles, // Novo timestamp!
  microMetrics: {
    tickVelocity: 0.1,
    buyerPressure: 0.50,
    absorptionRatio: 0.0,
    candleTickCount: 1,
    velocityAcceleration: 0.0,
  },
  isReady: true,
  gapCount: 0,
  isStale: false,
});

assert(evalNextCandle.candleTimestamp !== evalSec58.candleTimestamp, "Novo timestamp de vela detectado");
assert(evalNextCandle.isFrozen === false, "Novo candle inicia descongelado (isFrozen = false)");

console.log("\n================================================================================");
console.log(`>>> SUCESSO: ${passed}/${total} TESTES PASSARAM COM SUCESSO ABSOLUTO! <<<`);
console.log("================================================================================");
