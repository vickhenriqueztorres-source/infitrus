import test from "node:test";
import assert from "node:assert/strict";
import { PortfolioRegistry } from "../src/strategy/portfolio-registry.js";
import { QuantPortfolio } from "../src/strategy/quant-portfolio.js";
import { generateCandles } from "./mock-data-helper.js";

test("PortfolioRegistry: Instâncias para EURUSD e BTCUSD são independentes", () => {
  const registry = new PortfolioRegistry((pair) => new QuantPortfolio({ payout: 0.80 }));

  const eurusd = registry.get("EURUSD");
  const btcusd = registry.get("BTCUSD");

  assert.notEqual(eurusd, btcusd, "Portfólios para pares diferentes devem ser instâncias distintas");
  assert.equal(registry.get("EURUSD"), eurusd, "Chamadas subsequentes para o mesmo par devem retornar a mesma instância");
});

test("PortfolioRegistry: Atualizar payout de um par não afeta o outro", () => {
  const registry = new PortfolioRegistry((pair) => new QuantPortfolio({ payout: 0.80 }));

  registry.setPayout("EURUSD", 0.92);

  assert.equal(registry.get("EURUSD").payout, 0.92);
  assert.equal(registry.get("BTCUSD").payout, 0.80, "BTCUSD deve manter seu payout original de 0.80");

  registry.setGlobalPayout(0.85);
  assert.equal(registry.get("EURUSD").payout, 0.85);
  assert.equal(registry.get("BTCUSD").payout, 0.85);
});

test("PortfolioRegistry: evaluate() em EURUSD não afeta estado do BTCUSD", () => {
  const registry = new PortfolioRegistry((pair) => new QuantPortfolio({ payout: 0.80 }));
  const candles = generateCandles(60, 1.0850, "UP");

  const eurusdPortfolio = registry.get("EURUSD");
  const btcusdPortfolio = registry.get("BTCUSD");

  eurusdPortfolio.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles,
    isReady: true,
  });

  assert.equal(btcusdPortfolio.featureBuilder.featureCount, 0, "BTCUSD não pode ter features calculadas por avaliação de EURUSD");
});
