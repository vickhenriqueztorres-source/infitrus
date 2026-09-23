import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateBreakevenWinRate,
  calculateExpectedValue,
  evaluateExpectation,
} from "../src/strategy/payout-calculator.js";

test("PayoutCalculator: Ponto de equilíbrio para diferentes payouts", () => {
  // Payout 80% => 1 / 1.80 = 55.56%
  const be80 = calculateBreakevenWinRate(0.80);
  assert.equal(Number((be80 * 100).toFixed(2)), 55.56);

  // Payout 70% => 1 / 1.70 = 58.82%
  const be70 = calculateBreakevenWinRate(0.70);
  assert.equal(Number((be70 * 100).toFixed(2)), 58.82);

  // Payout 90% => 1 / 1.90 = 52.63%
  const be90 = calculateBreakevenWinRate(0.90);
  assert.equal(Number((be90 * 100).toFixed(2)), 52.63);
});

test("PayoutCalculator: Expectativa Matemática (EV) correta", () => {
  // 60% com payout 80%: 0.60 * 0.80 - 0.40 * 1.0 = +0.08
  const ev60 = calculateExpectedValue(0.60, 0.80);
  assert.equal(Number(ev60.toFixed(4)), 0.08);

  // 54% com payout 80%: 0.54 * 0.80 - 0.46 * 1.0 = -0.028
  const ev54 = calculateExpectedValue(0.54, 0.80);
  assert.equal(Number(ev54.toFixed(4)), -0.028);

  // Avaliação de vantagem (minEV = 0.02)
  const eval60 = evaluateExpectation(0.60, 0.80, 0.02);
  assert.equal(eval60.isFavorable, true);
  assert.equal(eval60.ev, 0.08);

  const eval54 = evaluateExpectation(0.54, 0.80, 0.02);
  assert.equal(eval54.isFavorable, false);
});
