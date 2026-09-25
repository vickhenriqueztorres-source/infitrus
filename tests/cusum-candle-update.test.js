/**
 * cusum-candle-update.test.js
 * Teste para Etapa 6: Passagem correta de vela individual com timestamp e features ao CUSUM
 */

import test from "node:test";
import assert from "node:assert/strict";

import { QuantPortfolio } from "../src/strategy/quant-portfolio.js";

function generateCandles(count = 20, startTs = 1727180000) {
  const candles = [];
  let price = 500.0;
  for (let i = 0; i < count; i++) {
    const open = price;
    const change = (i % 2 === 0 ? 0.3 : -0.2);
    const close = open + change;
    const high = Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    price = close;
    candles.push({
      timestamp: startTs + i * 60,
      open,
      high,
      low,
      close,
      volume: 100 + i * 5,
      closed: true,
    });
  }
  return candles;
}

test("Etapa 6: QuantPortfolio.observeClosedCandle atualiza o CUSUM com vela individual e timestamp válido", () => {
  const portfolio = new QuantPortfolio({ symbol: "EURUSD", payout: 0.85 });
  const candles = generateCandles(25, 1727180000);
  const last = candles[candles.length - 1];

  assert.equal(portfolio.regimeDetector.lastObservedCandle, 0, "Inicialmente lastObservedCandle deve ser 0");

  // Ingestão de lista de velas fechadas
  portfolio.observeClosedCandle(candles);

  assert.equal(
    portfolio.regimeDetector.lastObservedCandle,
    last.timestamp,
    "lastObservedCandle no CUSUM deve ser atualizado para o timestamp da última vela fechada"
  );

  // Idempotência: reenviar a mesma vela não deve alterar o timestamp nem duplicar CUSUM
  const sPosBefore = portfolio.regimeDetector.sPos;
  portfolio.observeClosedCandle(last);
  assert.equal(portfolio.regimeDetector.lastObservedCandle, last.timestamp);
  assert.equal(portfolio.regimeDetector.sPos, sPosBefore);

  // Ingestão de um novo candle individual
  const nextCandle = {
    timestamp: last.timestamp + 60,
    open: last.close,
    close: last.close + 0.5,
    high: last.close + 0.6,
    low: last.close - 0.1,
    closed: true,
  };
  portfolio.observeClosedCandle(nextCandle, { r1: 0.001, sigma5: 0.0005, vr3_20: 1.1 });

  assert.equal(
    portfolio.regimeDetector.lastObservedCandle,
    nextCandle.timestamp,
    "CUSUM deve registrar a nova vela individual avançando o timestamp"
  );
});

test("Etapa 6: evaluate() permanece 100% puro e não muta lastObservedCandle do CUSUM", () => {
  const portfolio = new QuantPortfolio({ symbol: "ARBITRIUM", payout: 0.87 });
  const candles = generateCandles(20, 1727181000);

  portfolio.observeClosedCandle(candles);
  const observedTs = portfolio.regimeDetector.lastObservedCandle;

  // Realiza múltiplas avaliações
  for (let i = 0; i < 10; i++) {
    portfolio.evaluate({ candles, timeframe: 60 });
  }

  assert.equal(
    portfolio.regimeDetector.lastObservedCandle,
    observedTs,
    "evaluate() não deve alterar o estado do CUSUM"
  );
});
