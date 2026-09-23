/**
 * candle-timer.test.js - Testes do Relógio e Contagem Regressiva da Vela M1
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CandleTimer } from "../src/utils/candle-timer.js";

test("CandleTimer: Cálculo correto dos segundos restantes em M1 (60s)", () => {
  const timer = new CandleTimer({ timeframeSeconds: 60 });

  // No segundo 15 do minuto: devem restar 45 segundos
  const s15 = timer.computeCurrentState(1727010015);
  assert.equal(s15.remainingSeconds, 45);
  assert.equal(s15.formattedTime, "00:45");
  assert.equal(s15.phase, "NORMAL");
  assert.equal(s15.isEntryWindow, false);

  // No segundo 52 do minuto: devem restar 8 segundos (Fase WARNING)
  const s52 = timer.computeCurrentState(1727010052);
  assert.equal(s52.remainingSeconds, 8);
  assert.equal(s52.formattedTime, "00:08");
  assert.equal(s52.phase, "WARNING");
  assert.equal(s52.isEntryWindow, false);

  // No segundo 58 do minuto: devem restar 2 segundos (Fase PREPARE)
  const s58 = timer.computeCurrentState(1727010058);
  assert.equal(s58.remainingSeconds, 2);
  assert.equal(s58.formattedTime, "00:02");
  assert.equal(s58.phase, "PREPARE");
  assert.equal(s58.isEntryWindow, true);

  // No segundo 59 do minuto: deve restar 1 segundo (Fase EXECUTE)
  const s59 = timer.computeCurrentState(1727010059);
  assert.equal(s59.remainingSeconds, 1);
  assert.equal(s59.formattedTime, "00:01");
  assert.equal(s59.phase, "EXECUTE");
  assert.equal(s59.isEntryWindow, true);

  // No segundo 00 do minuto: virada de vela / abertura imediata
  const s00 = timer.computeCurrentState(1727010060);
  assert.equal(s00.phase, "EXECUTE");
  assert.equal(s00.isEntryWindow, true);
});

test("CandleTimer: Sincronização de tempo com o servidor e cálculo de progresso", () => {
  const timer = new CandleTimer({ timeframeSeconds: 60 });
  
  // Sincroniza com timestamp do servidor
  const serverTimeSec = 1727010030; // Metade da vela
  timer.syncServerTime(serverTimeSec);

  const state = timer.computeCurrentState(serverTimeSec);
  assert.equal(state.remainingSeconds, 30);
  assert.equal(state.progressPct, 50.0);
});

test("CandleTimer: Ciclo de assinatura reativa (subscribe)", () => {
  const timer = new CandleTimer({ timeframeSeconds: 60 });
  let notifiedState = null;

  const unsubscribe = timer.subscribe((state) => {
    notifiedState = state;
  });

  assert.ok(notifiedState !== null);
  assert.ok(typeof notifiedState.formattedTime === "string");

  unsubscribe();
  timer.stop();
});
