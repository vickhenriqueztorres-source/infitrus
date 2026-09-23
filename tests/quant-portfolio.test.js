import test from "node:test";
import assert from "node:assert/strict";

import { QuantPortfolio } from "../src/strategy/quant-portfolio.js";
import { generateCandles } from "./mock-data-helper.js";

test("QuantPortfolio: Orquestração das 5 estratégias e diagnóstico consolidado", () => {
  const portfolio = new QuantPortfolio({ payout: 0.80, minEV: 0.01 });

  const candles = generateCandles(60, 1.0850, "UP");
  const report = portfolio.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles,
    isReady: true,
  });

  assert.equal(report.symbol, "EURUSD");
  assert.equal(report.strategiesResults.length, 5);
  assert.ok(["CALL", "PUT", "WAIT"].includes(report.action));
  assert.ok(report.probability >= 0 && report.probability <= 1);
  assert.ok(typeof report.conservativeProbability === "number");
  assert.ok(typeof report.edge === "number");
  assert.ok(typeof report.quality === "number");
  assert.ok(typeof report.uncertainty === "number");
  assert.ok(typeof report.isConfluence === "boolean");
  assert.ok(typeof report.isDivergent === "boolean");

  // Testa ciclo de aprendizado contínuo após fechamento de vela
  portfolio.onCandleClosed("EURUSD", 1);
});

test("QuantPortfolio: Avaliação pura e idempotente (sem mutação de estado)", () => {
  const portfolio = new QuantPortfolio({ payout: 0.80, minEV: 0.005 });

  const candles = generateCandles(60, 1.0850, "UP");
  const rep1 = portfolio.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles,
    isReady: true,
  });

  const rep2 = portfolio.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles,
    isReady: true,
  });

  assert.deepEqual(rep1, rep2, "Avaliação consecutiva com mesmos inputs deve produzir resultado estritamente idêntico");
});
