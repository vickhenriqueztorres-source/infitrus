import test from "node:test";
import assert from "node:assert/strict";
import { SignalLifecycle, Phase } from "../src/strategy/signal-lifecycle.js";

test("SignalLifecycle: a) PRE_SIGNAL aos 52 s quando há edge", () => {
  const lc = new SignalLifecycle();
  const pair = "EURUSD";
  const tf = 60;
  const baseTs = 1727010000;

  // No segundo 52 da vela formando baseTs (alvo: baseTs + 60)
  const snap = lc.step({
    pair,
    tf,
    nowSec: baseTs + 52,
    dataOk: true,
    decide: () => ({ action: "CALL", probability: 0.65, edge: 0.05, subStrategy: "MOMENTUM" }),
  });

  assert.equal(snap.current.phase, Phase.PRE_SIGNAL);
  assert.equal(snap.current.direction, "CALL");
  assert.equal(snap.current.probability, 0.65);
});

test("SignalLifecycle: b) Bloqueio de repaint: tick aos 55 s na direção oposta NÃO inverte o sinal", () => {
  const lc = new SignalLifecycle();
  const pair = "EURUSD";
  const tf = 60;
  const baseTs = 1727010000;

  // Segundo 52 dispara CALL
  lc.step({
    pair,
    tf,
    nowSec: baseTs + 52,
    dataOk: true,
    decide: () => ({ action: "CALL", probability: 0.65, edge: 0.05, subStrategy: "MOMENTUM" }),
  });

  // Segundo 55 tenta mudar para PUT
  const snap55 = lc.step({
    pair,
    tf,
    nowSec: baseTs + 55,
    dataOk: true,
    decide: () => ({ action: "PUT", probability: 0.70, edge: 0.08, subStrategy: "EXHAUSTION" }),
  });

  assert.equal(snap55.current.phase, Phase.PRE_SIGNAL);
  assert.equal(snap55.current.direction, "CALL", "Sinal travado não pode sofrer repaint para PUT");
  assert.equal(snap55.current.subStrategy, "MOMENTUM");
});

test("SignalLifecycle: c) ENTRY_NOW no segundo 0 da vela seguinte", () => {
  const lc = new SignalLifecycle();
  const pair = "EURUSD";
  const tf = 60;
  const baseTs = 1727010000;

  lc.step({
    pair,
    tf,
    nowSec: baseTs + 52,
    dataOk: true,
    decide: () => ({ action: "CALL", probability: 0.65 }),
  });

  // Segundo 0 da nova vela (targetTs = baseTs + 60)
  const snap0 = lc.step({
    pair,
    tf,
    nowSec: baseTs + 60.0,
    dataOk: true,
    decide: () => null,
  });

  assert.ok(snap0.trade, "Trade deve estar ativo na nova vela");
  assert.equal(snap0.trade.phase, Phase.ENTRY_NOW);
  assert.equal(snap0.trade.direction, "CALL");
});

test("SignalLifecycle: d) IN_TRADE do segundo 1 ao 59 da vela seguinte", () => {
  const lc = new SignalLifecycle();
  const pair = "EURUSD";
  const tf = 60;
  const baseTs = 1727010000;

  lc.step({
    pair,
    tf,
    nowSec: baseTs + 52,
    dataOk: true,
    decide: () => ({ action: "CALL", probability: 0.65 }),
  });

  // Segundo 6 (após ENTRY_WINDOW_SEC de 5s)
  const snap2 = lc.step({
    pair,
    tf,
    nowSec: baseTs + 66.0,
    dataOk: true,
    decide: () => null,
  });

  assert.ok(snap2.trade);
  assert.equal(snap2.trade.phase, Phase.IN_TRADE);
  assert.equal(snap2.trade.direction, "CALL");
});

test("SignalLifecycle: e) SETTLED no segundo 60 com vela fechada (resultado WIN ou LOSS)", () => {
  const lc = new SignalLifecycle();
  const pair = "EURUSD";
  const tf = 60;
  const baseTs = 1727010000;

  lc.step({
    pair,
    tf,
    nowSec: baseTs + 52,
    dataOk: true,
    decide: () => ({ action: "CALL", probability: 0.65 }),
  });

  // Abertura da vela operada
  lc.onCandleOpen(pair, tf, baseTs + 60, 1.0850);

  // Avança tempo para IN_TRADE
  lc.step({
    pair,
    tf,
    nowSec: baseTs + 80,
    dataOk: true,
    decide: () => null,
  });

  // Fechamento da vela operada em alta (WIN)
  lc.onCandleClose(pair, tf, {
    timestamp: baseTs + 60,
    open: 1.0850,
    close: 1.0855,
    high: 1.0858,
    low: 1.0848,
  });

  const snapPost = lc.snapshot(pair, tf, baseTs + 120);
  assert.ok(snapPost.lastResult);
  assert.equal(snapPost.lastResult.phase, Phase.SETTLED);
  assert.equal(snapPost.lastResult.result, "WIN");
});

test("SignalLifecycle: f) CANCELLED se qualidade degradar antes da entrada", () => {
  const lc = new SignalLifecycle();
  const pair = "EURUSD";
  const tf = 60;
  const baseTs = 1727010000;

  lc.step({
    pair,
    tf,
    nowSec: baseTs + 52,
    dataOk: true,
    decide: () => ({ action: "CALL", probability: 0.65 }),
  });

  // Segundo 56: feed congela ou degrada (dataOk: false)
  const snapDegraded = lc.step({
    pair,
    tf,
    nowSec: baseTs + 56,
    dataOk: false,
    decide: () => null,
  });

  assert.equal(snapDegraded.current.phase, Phase.CANCELLED);
  assert.equal(snapDegraded.current.reason, "DATA_UNSTABLE");
});

test("SignalLifecycle: g) ID único por sinal, nunca reutilizado", () => {
  const lc = new SignalLifecycle();
  const pair = "EURUSD";
  const tf = 60;

  const snap1 = lc.step({
    pair,
    tf,
    nowSec: 1727000052,
    dataOk: true,
    decide: () => ({ action: "CALL", probability: 0.65 }),
  });

  const snap2 = lc.step({
    pair,
    tf,
    nowSec: 1727000112,
    dataOk: true,
    decide: () => ({ action: "PUT", probability: 0.65 }),
  });

  assert.ok(snap1.current.id);
  assert.ok(snap2.current.id);
  assert.notEqual(snap1.current.id, snap2.current.id, "Cada ciclo deve ter ID único e estrito");
});
