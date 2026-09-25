import test from "node:test";
import assert from "node:assert/strict";
import { soundsForTransition } from "../src/ui/sound-transitions.js";

test("soundsForTransition: PRE_SIGNAL toca alerta de direção apenas uma vez por sinal (dedup)", () => {
  const played = new Set();
  const nextLcCall = {
    current: { id: "sig-101", phase: "PRE_SIGNAL", direction: "CALL" },
  };

  const sounds1 = soundsForTransition(null, nextLcCall, 52, played);
  assert.deepEqual(sounds1, ["call"]);

  // Segunda chamada aos 53s com o mesmo sinal não repete o som de alerta
  const sounds2 = soundsForTransition(nextLcCall, nextLcCall, 53, played);
  assert.deepEqual(sounds2, []);
});

test("soundsForTransition: PRE_SIGNAL toca put para sinal de baixa", () => {
  const played = new Set();
  const nextLcPut = {
    current: { id: "sig-102", phase: "PRE_SIGNAL", direction: "PUT" },
  };

  const sounds = soundsForTransition(null, nextLcPut, 54, played);
  assert.deepEqual(sounds, ["put"]);
});

test("soundsForTransition: pips apenas nos segundos 57, 58 e 59 da vela formadora com PRE_SIGNAL", () => {
  const played = new Set();
  const lc = {
    current: { id: "sig-200", phase: "PRE_SIGNAL", direction: "CALL" },
  };

  // Aos 56s não gera pip
  soundsForTransition(null, lc, 56, played);

  // Aos 57s gera pip
  const s57 = soundsForTransition(lc, lc, 57, played);
  assert.deepEqual(s57, ["pip"]);

  // Repetição no mesmo segundo 57s é deduplicada
  const s57dup = soundsForTransition(lc, lc, 57, played);
  assert.deepEqual(s57dup, []);

  // Aos 58s gera pip
  const s58 = soundsForTransition(lc, lc, 58, played);
  assert.deepEqual(s58, ["pip"]);

  // Aos 59s gera pip
  const s59 = soundsForTransition(lc, lc, 59, played);
  assert.deepEqual(s59, ["pip"]);

  // Sem PRE_SIGNAL ativo aos 58s não toca pip
  const noPreLc = { current: { id: "sig-201", phase: "SCANNING" } };
  const sNoPre = soundsForTransition(null, noPreLc, 58, new Set());
  assert.deepEqual(sNoPre, []);
});

test("soundsForTransition: ENTRY_NOW gera som de entrada e deduplica", () => {
  const played = new Set();
  const lcTrade = {
    trade: { id: "sig-300", phase: "ENTRY_NOW", direction: "CALL" },
  };

  const sounds1 = soundsForTransition(null, lcTrade, 0, played);
  assert.deepEqual(sounds1, ["entry"]);

  const sounds2 = soundsForTransition(lcTrade, lcTrade, 0, played);
  assert.deepEqual(sounds2, []);
});

test("soundsForTransition: SETTLED gera som de resultado WIN/LOSS/DOJI e deduplica", () => {
  const played = new Set();
  const lcWin = {
    lastResult: { id: "sig-400", phase: "SETTLED", result: "WIN" },
  };

  const soundsWin = soundsForTransition(null, lcWin, 60, played);
  assert.deepEqual(soundsWin, ["win"]);

  const soundsWinDup = soundsForTransition(lcWin, lcWin, 60, played);
  assert.deepEqual(soundsWinDup, []);

  const lcLoss = {
    lastResult: { id: "sig-401", phase: "SETTLED", result: "LOSS" },
  };
  const soundsLoss = soundsForTransition(null, lcLoss, 60, new Set());
  assert.deepEqual(soundsLoss, ["loss"]);

  const lcDoji = {
    lastResult: { id: "sig-402", phase: "SETTLED", result: "DOJI" },
  };
  const soundsDoji = soundsForTransition(null, lcDoji, 60, new Set());
  assert.deepEqual(soundsDoji, ["doji"]);
});

test("AudioAlertManager: métodos de alertas sonoros sintetizados são instanciáveis e chamáveis", async () => {
  const { AudioAlertManager, audioAlertManager } = await import("../src/utils/audio-alerts.js");
  assert.ok(audioAlertManager instanceof AudioAlertManager);
  assert.equal(typeof audioAlertManager.playCallAlert, "function");
  assert.equal(typeof audioAlertManager.playPutAlert, "function");
  assert.equal(typeof audioAlertManager.playEntryAlert, "function");
  assert.equal(typeof audioAlertManager.playCountdownPip, "function");
  assert.equal(typeof audioAlertManager.playWinAlert, "function");
  assert.equal(typeof audioAlertManager.playLossAlert, "function");
  assert.equal(typeof audioAlertManager.playDojiAlert, "function");

  // Chamadas seguras em ambiente sem Web Audio Context (Node.js) não devem lançar exceções
  assert.doesNotThrow(() => {
    audioAlertManager.playCallAlert();
    audioAlertManager.playPutAlert();
    audioAlertManager.playEntryAlert();
    audioAlertManager.playCountdownPip(3);
    audioAlertManager.playCountdownPip(0);
    audioAlertManager.playWinAlert();
    audioAlertManager.playLossAlert();
    audioAlertManager.playDojiAlert();
  });
});

