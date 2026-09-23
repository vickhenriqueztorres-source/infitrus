import test from "node:test";
import assert from "node:assert/strict";
import { QuantPortfolio } from "../src/strategy/quant-portfolio.js";
import { generateCandles } from "./mock-data-helper.js";

test("QuantPortfolio: 100 chamadas seguidas de evaluate() são estritamente puras", () => {
  const portfolio = new QuantPortfolio({ payout: 0.80, minEdge: 0.015 });
  const candles = generateCandles(60, 1.0850, "UP");

  const initialReport = portfolio.evaluate({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    candles,
    isReady: true,
  });

  // Captura estado das propriedades do portfolio antes do loop
  const initialFeatureMeans = { ...portfolio.featureBuilder.featureMeans };
  const initialFeatureVars = { ...portfolio.featureBuilder.featureVars };
  const initialFeatureCount = portfolio.featureBuilder.featureCount;
  const initialStability = portfolio.regimeDetector.marketStability;

  for (let i = 0; i < 100; i++) {
    const report = portfolio.evaluate({
      symbol: "EURUSD",
      timeframeSeconds: 60,
      candles,
      isReady: true,
    });

    assert.deepEqual(report, initialReport, `Chamada #${i + 1} de evaluate() divergiu do retorno inicial`);
  }

  // Verifica que nenhuma propriedade interna sofreu mutação
  assert.equal(portfolio.featureBuilder.featureCount, initialFeatureCount, "featureCount não pode mudar em evaluate()");
  assert.deepEqual(portfolio.featureBuilder.featureMeans, initialFeatureMeans, "featureMeans não pode mudar em evaluate()");
  assert.deepEqual(portfolio.featureBuilder.featureVars, initialFeatureVars, "featureVars não pode mudar em evaluate()");
  assert.equal(portfolio.regimeDetector.marketStability, initialStability, "marketStability não pode mudar em evaluate()");
});
