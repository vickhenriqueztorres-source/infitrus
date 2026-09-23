/**
 * audio-alerts.test.js - Testes do Gerenciador de Alertas Sonoros
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";
import { AudioAlertManager } from "../src/utils/audio-alerts.js";

test("AudioAlertManager: Inicialização, controle de mudo e alternância", () => {
  const manager = new AudioAlertManager();

  assert.equal(manager.isSoundEnabled(), true, "Som deve iniciar ativado por padrão");

  const toggledOff = manager.toggleSound();
  assert.equal(toggledOff, false);
  assert.equal(manager.isSoundEnabled(), false);

  const toggledOn = manager.toggleSound();
  assert.equal(toggledOn, true);
  assert.equal(manager.isSoundEnabled(), true);

  manager.setSoundEnabled(false);
  assert.equal(manager.isSoundEnabled(), false);
});

test("AudioAlertManager: Execução segura em ambiente sem Web Audio (Node.js/SSR)", () => {
  const manager = new AudioAlertManager();

  // Nenhuma das chamadas abaixo pode lançar exceção mesmo sem Web Audio nativo no Node.js
  assert.doesNotThrow(() => {
    manager.playCallAlert();
    manager.playPutAlert();
    manager.playCountdownPip(3);
    manager.playCountdownPip(0);
  });
});
