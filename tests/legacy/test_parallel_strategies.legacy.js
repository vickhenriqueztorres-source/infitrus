import assert from "node:assert";
import { QuantPortfolio } from "./src/strategy/quant-portfolio.js";
import { EdgeSelector } from "./src/strategy/decision/edge-selector.js";
import { ContinuationStrategy } from "./src/strategy/strategies/continuation-strategy.js";
import { ReversionStrategy } from "./src/strategy/strategies/reversion-strategy.js";
import { MicrostructureStrategy } from "./src/strategy/strategies/microstructure-strategy.js";
import { VolatilityExpansionStrategy } from "./src/strategy/strategies/volatility-expansion-strategy.js";
import { HistoricalAnalogyStrategy } from "./src/strategy/strategies/historical-analogy-strategy.js";

console.log("--- TESTANDO AS 5 ESTRATÉGIAS PARALELAS E O EDGE SELECTOR ---");

// Helper para gerar série sintética de velas M1
function generateCandles(count = 30, trend = "bull") {
  const candles = [];
  let price = 100.0;
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < count; i++) {
    const delta = trend === "bull" ? 0.08 : trend === "bear" ? -0.08 : (Math.random() - 0.5) * 0.05;
    const open = price;
    const close = open + delta;
    const high = Math.max(open, close) + 0.02;
    const low = Math.min(open, close) - 0.02;
    candles.push({
      timestamp: now - (count - i) * 60,
      open,
      high,
      low,
      close,
    });
    price = close;
  }
  return candles;
}

// 1. Teste de Instanciação do QuantPortfolio
const portfolio = new QuantPortfolio({ payout: 0.80, minEdge: 0.015 });
assert(portfolio.strategyContinuation instanceof ContinuationStrategy, "ContinuationStrategy instanciada");
assert(portfolio.strategyReversion instanceof ReversionStrategy, "ReversionStrategy instanciada");
assert(portfolio.strategyMicrostructure instanceof MicrostructureStrategy, "MicrostructureStrategy instanciada");
assert(portfolio.strategyVolatility instanceof VolatilityExpansionStrategy, "VolatilityExpansionStrategy instanciada");
assert(portfolio.strategyAnalogy instanceof HistoricalAnalogyStrategy, "HistoricalAnalogyStrategy instanciada");
console.log("✓ Teste 1: Instanciação das 5 estratégias autônomas OK");

// 2. Teste da Estratégia de Continuação (Momentum Bullish)
const bullCandles = generateCandles(25, "bull");
const bullMicro = { pressure: 0.65, pressureVelocity: 0.1, tickCount: 20, timeNearHighRatio: 0.55 };
const resCont = portfolio.strategyContinuation.evaluate({ candles: bullCandles, microMetrics: bullMicro, payout: 0.80 });
console.log("Continuação Bullish:", resCont.candidateAction, "ProbUp:", resCont.probUp, "Edge:", resCont.edge);
assert(resCont.candidateAction === "CALL", "Continuação deve gerar CALL sob forte momentum de alta");
assert(resCont.edge > 0.015, "Edge deve ser superior a 1.5%");
console.log("✓ Teste 2: Estratégia 1 (Continuação) operando autonomamente OK");

// 3. Teste da Estratégia de Reversão (Exaustão em Z-Score Alto)
// Simula 25 velas com esticada extrema no final e pavio superior
const stretchCandles = generateCandles(25, "neutral");
const last = stretchCandles[stretchCandles.length - 1];
last.open = 105.0;
last.close = 105.1;
last.high = 106.0; // Enorme pavio superior
last.low = 104.9;
const resRev = portfolio.strategyReversion.evaluate({ candles: stretchCandles, microMetrics: { pressure: 0.05, pressureVelocity: -0.2 }, payout: 0.80 });
console.log("Reversão Exaustão:", resRev.candidateAction, "ProbDown:", resRev.probDown, "ZScore:", resRev.zScore);
console.log("✓ Teste 3: Estratégia 2 (Reversão) calculando Z-score e pavio de absorção OK");

// 4. Teste da Estratégia de Microestrutura isolada de candles
const flowMicroBull = {
  pressure: 0.75,
  pressureVelocity: 0.2,
  pressureAcceleration: 0.1,
  timeNearHighRatio: 0.60,
  timeNearLowRatio: 0.05,
  lastTicksDirection: 1,
  flowImbalance: 0.5,
  tickCount: 28,
};
const resMicro = portfolio.strategyMicrostructure.evaluate({ microMetrics: flowMicroBull, payout: 0.80 });
console.log("Microestrutura Fluxo:", resMicro.candidateAction, "ProbUp:", resMicro.probUp, "Edge:", resMicro.edge);
assert(resMicro.candidateAction === "CALL", "Microestrutura deve gerar CALL sob pressão agressora compradora");
console.log("✓ Teste 4: Estratégia 3 (Microestrutura de Ticks) gerando oportunidade autônoma OK");

// 5. Teste do EdgeSelector: Resolução de Conflito Direcional (CALL vs PUT)
const selector = new EdgeSelector({ minEdge: 0.015, conflictThreshold: 0.010 });

// Caso A: Conflito Equilibrado (CALL +3.0% vs PUT +2.8% -> Delta 0.2% < 1.0% -> Neutraliza)
const balancedConflict = [
  { action: "CALL", candidateAction: "CALL", edge: 0.030, quality: 0.7, name: "Continuação", conservativeProb: 0.5856 },
  { action: "PUT", candidateAction: "PUT", edge: 0.028, quality: 0.7, name: "Reversão", conservativeProb: 0.5836 },
];
const decConflict = selector.selectCompetitive({ candidates: balancedConflict, payout: 0.80 });
console.log("Conflito Equilibrado:", decConflict.action, decConflict.label);
assert(decConflict.action === "WAIT", "Conflito equilibrado deve neutralizar e retornar WAIT");
assert(decConflict.isConflict === true, "isConflict deve ser true");
console.log("✓ Teste 5A: Veto por conflito direcional equilibrado OK");

// Caso B: Conflito Desempatado (CALL +4.5% vs PUT +2.0% -> Delta 2.5% >= 1.0% -> CALL Vence)
const strongCallConflict = [
  { action: "CALL", candidateAction: "CALL", edge: 0.045, quality: 0.75, name: "Continuação", conservativeProb: 0.6006, reasons: ["Momentum forte"] },
  { action: "PUT", candidateAction: "PUT", edge: 0.020, quality: 0.65, name: "Reversão", conservativeProb: 0.5756, reasons: ["Z-Score alto"] },
];
const decWinner = selector.selectCompetitive({ candidates: strongCallConflict, payout: 0.80 });
console.log("Conflito Desempatado Vencedor:", decWinner.action, decWinner.strategyName, "Edge:", decWinner.edge);
assert(decWinner.action === "CALL", "O candidato com maior Edge deve vencer o conflito");
assert(decWinner.strategyName === "Continuação", "Nome da estratégia vencedora deve ser registrado");
console.log("✓ Teste 5B: Desempate por Delta Edge significativo OK");

// Caso C: Confluência de Estratégias (Continuação CALL + Microestrutura CALL)
const confluenceCandidates = [
  { action: "CALL", candidateAction: "CALL", edge: 0.042, quality: 0.80, name: "Continuação", conservativeProb: 0.5976, reasons: ["Inércia"] },
  { action: "CALL", candidateAction: "CALL", edge: 0.035, quality: 0.75, name: "Microestrutura", conservativeProb: 0.5906, reasons: ["Pressão de ticks"] },
];
const decConfluence = selector.selectCompetitive({ candidates: confluenceCandidates, payout: 0.80 });
console.log("Confluência:", decConfluence.action, decConfluence.strategyName, "isConfluence:", decConfluence.isConfluence);
assert(decConfluence.isConfluence === true, "Deve registrar confluência positiva");
assert(decConfluence.confluentCount === 2, "Contagem de confluência deve ser 2");
console.log("✓ Teste 5C: Bônus de confluência entre múltiplas estratégias OK");

// 6. Teste Integrado com o QuantPortfolio completo
const fullReport = portfolio.evaluate({
  symbol: "EURUSD",
  timeframeSeconds: 60,
  candles: bullCandles,
  microMetrics: flowMicroBull,
  isReady: true,
});
console.log("Relatório Completo do Portfólio:", {
  action: fullReport.action,
  label: fullReport.label,
  strategyName: fullReport.strategyName,
  edge: fullReport.edge,
  strategiesCount: fullReport.strategiesResults.length,
});
assert(fullReport.strategiesResults.length === 5, "Deve retornar o resultado das 5 estratégias individuais");
console.log("✓ Teste 6: Avaliação integrada completa com 5 estratégias simultâneas OK");

console.log("\n>>> TODOS OS 6 TESTES DA NOVA ARQUITETURA PASSARAM COM 100% DE SUCESSO! <<<");
