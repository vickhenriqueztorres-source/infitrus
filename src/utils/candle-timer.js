/**
 * candle-timer.js - Cronômetro de Contagem Regressiva da Vela M1
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Calcular em tempo real os segundos restantes até o início da próxima vela M1 (60s) usando marketClock.
 * - Fornecer estados de alerta por fases:
 *     - WAIT: segundo 0 (abertura da vela, aguardando início do ciclo)
 *     - NORMAL: > 10s restantes (análise contínua)
 *     - WARNING: 10s a 4s restantes (atenção para fechamento)
 *     - PREPARE: 3s a 1s restantes (prepare a ordem CALL/PUT)
 *     - EXECUTE: <= 1s restantes (abertura iminente da operação)
 * - Notificar assinantes a cada segundo de forma não-bloqueante.
 */

import { marketClock } from "./market-clock.js";

export class CandleTimer {
  /**
   * @param {Object} [options]
   * @param {number} [options.timeframeSeconds=60]
   */
  constructor(options = {}) {
    this.timeframeSeconds = options.timeframeSeconds || 60;
    this.listeners = new Set();
    this.timerId = null;
    this.lastSecondEmitted = -1;

    this.currentState = {
      remainingSeconds: 60,
      formattedTime: "01:00",
      progressPct: 0,
      phase: "NORMAL",
      isEntryWindow: false,
      epoch: 0,
    };
  }

  /**
   * Retorna o timestamp epoch atual estimado em segundos (via marketClock).
   * @returns {number}
   */
  getEpochSeconds() {
    return marketClock.nowSec();
  }

  /**
   * Calcula o estado atual da contagem regressiva para um dado epoch.
   * @param {number} [targetEpoch] - Opcional para testes determinísticos
   * @returns {Object}
   */
  computeCurrentState(targetEpoch = null) {
    const tf = this.timeframeSeconds;
    let secInTf;
    let remaining;
    let epoch;

    if (targetEpoch !== null) {
      epoch = targetEpoch;
      secInTf = Math.floor(epoch) % tf;
      remaining = tf - secInTf;
    } else {
      epoch = marketClock.nowSec();
      secInTf = marketClock.secondInCandle(tf);
      remaining = marketClock.remainingInCandle(tf);
    }

    const isBoundary = secInTf === 0;
    let phase = "NORMAL";
    let isEntryWindow = false;

    // Segundo 0 passa a ser "WAIT" (a etapa 04 troca as fases visuais pelo ciclo de vida do sinal)
    if (isBoundary) {
      phase = "WAIT";
      isEntryWindow = false;
    } else if (remaining <= 1) {
      phase = "EXECUTE";
      isEntryWindow = true;
    } else if (remaining <= 3) {
      phase = "PREPARE";
      isEntryWindow = true;
    } else if (remaining <= 10) {
      phase = "WARNING";
      isEntryWindow = false;
    }

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const formattedTime = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    const progressPct = Number((((tf - remaining) / tf) * 100).toFixed(1));

    this.currentState = {
      remainingSeconds: remaining,
      formattedTime,
      progressPct,
      phase,
      isEntryWindow,
      epoch: Math.floor(epoch),
    };

    return this.currentState;
  }

  /**
   * Inicia o loop do cronômetro (atualização a cada 250ms).
   */
  start() {
    if (this.timerId) return;

    this.computeCurrentState();
    this.timerId = setInterval(() => {
      const state = this.computeCurrentState();
      if (state.remainingSeconds !== this.lastSecondEmitted) {
        this.lastSecondEmitted = state.remainingSeconds;
        this._notify(state);
      }
    }, 250);
  }

  /**
   * Para o loop do cronômetro.
   */
  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Adiciona um ouvinte para receber atualizações do relógio a cada virada de segundo.
   * @param {Function} callback
   * @returns {Function} Função de cancelamento
   */
  subscribe(callback) {
    if (typeof callback !== "function") return () => {};
    this.listeners.add(callback);
    callback(this.currentState);
    return () => this.listeners.delete(callback);
  }

  _notify(state) {
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (_) {}
    }
  }

  getState() {
    return this.currentState;
  }
}

export const candleTimer = new CandleTimer({ timeframeSeconds: 60 });
