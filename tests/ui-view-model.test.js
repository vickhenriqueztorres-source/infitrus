import test from "node:test";
import assert from "node:assert/strict";
import { createViewModel } from "../src/ui/view-model.js";

const timer = { remainingSeconds: 37, progressPct: 38 };

test("mapea los estados técnicos a cinco estados visibles", () => {
  assert.equal(createViewModel({ state: "BOOTING" }, timer).visualState, "CONECTANDO");
  assert.equal(createViewModel({ state: "SYNCING_HISTORY", historyCount: 97 }, timer).visualState, "CALIBRANDO");
  assert.equal(createViewModel({ state: "READY", updatedAt: 1000, wsStatus: "conectado" }, timer, { now: 1000 }).visualState, "ESCANEANDO");
  assert.equal(createViewModel({ state: "STALE" }, timer).visualState, "BLOQUEADO");
  assert.equal(createViewModel({ state: "ERROR" }, timer).statusDot, "coral");
});

test("presenta una señal reciente sin alterar la dirección interna", () => {
  const now = 1_000_000;
  const input = {
    state: "READY",
    symbol: "audcad_otc",
    timeframe: "1 minuto",
    quantAction: "CALL",
    signalsHistory: [{ id: "sig-1", direction: "CALL", recordedAt: now - 1200, timeframeSeconds: 60 }],
  };
  const vm = createViewModel(input, timer, { now });
  assert.equal(vm.visualState, "SENAL");
  assert.equal(vm.signal.direction, "CALL");
  assert.equal(vm.signal.arrow, "▲");
  assert.equal(vm.asset, "AUDCAD_OTC");
  assert.equal(vm.timeframe, "M1");
  assert.equal(input.quantAction, "CALL");
});

test("expira visualmente una señal y vuelve a escanear después de una vela", () => {
  const now = 1_000_000;
  const base = {
    state: "READY",
    quantAction: "PUT",
    signalsHistory: [{ id: "sig-2", direction: "PUT", recordedAt: now - 10_000, timeframeSeconds: 60 }],
  };
  assert.equal(createViewModel(base, timer, { now }).signal.phase, "expired");
  const staleSignal = { ...base, signalsHistory: [{ ...base.signalsHistory[0], recordedAt: now - 61_000 }] };
  assert.equal(createViewModel(staleSignal, timer, { now }).visualState, "ESCANEANDO");
});

test("un estado desconocido falla de forma segura", () => {
  const vm = createViewModel({ state: "NEW_UNSUPPORTED_STATE", quantAction: "CALL" }, timer);
  assert.equal(vm.visualState, "CONECTANDO");
  assert.equal(vm.signal, null);
});
