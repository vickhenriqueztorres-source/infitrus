/**
 * offscreen.js - Relógio de Alta Precisão e Isenção de Throttling em Background
 * Oracle Quant Signals
 *
 * Responsabilidades:
 * - Iniciar áudio silencioso via Web Audio API (OscillatorNode 0Hz + GainNode 0)
 *   para isentar a extensão do intensive throttling do Chrome (R4).
 * - Instanciar Web Worker com timer de 1s para fornecer batimento contínuo (R3).
 * - Transmitir batimentos (OFFSCREEN_HEARTBEAT) para Service Worker e abas.
 * - Permitir registro de eventos de flight recorder a partir do offscreen context.
 */

import { rec, configureFlightRecorder } from "../diagnostics/flight-recorder.js";

configureFlightRecorder({ ctx: "offscreen" });
rec("OFFSCREEN_BOOT", { time: Date.now() });

let audioCtx = null;
let osc = null;
let gain = null;
let timerWorker = null;

/**
 * Inicializa áudio silencioso (Oscillator 0Hz, Gain 0) para isentar do congelamento de abas (R4).
 */
export function initSilentAudio() {
  try {
    const AudioContextClass = typeof window !== "undefined"
      ? (window.AudioContext || window.webkitAudioContext)
      : null;
    if (!AudioContextClass) return false;

    audioCtx = new AudioContextClass();
    osc = audioCtx.createOscillator();
    gain = audioCtx.createGain();

    osc.frequency.value = 0;
    gain.gain.value = 0;

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();

    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }

    rec("AUDIO_START", { state: audioCtx.state });
    return true;
  } catch (err) {
    rec("AUDIO_ERROR", { error: err?.message || String(err) });
    return false;
  }
}

/**
 * Inicializa Web Worker para heartbeat de 1s sem throttling (R3).
 */
export function initTimerWorker() {
  try {
    timerWorker = new Worker(new URL("./timer-worker.js", import.meta.url), { type: "module" });
  } catch (_) {
    // Fallback inline blob worker caso URL module falhe
    try {
      const blobCode = `
        let intervalId = null;
        self.onmessage = (e) => {
          if (e.data === "START") {
            if (!intervalId) {
              intervalId = setInterval(() => {
                self.postMessage({ type: "WORKER_TICK", time: Date.now() });
              }, 1000);
            }
          } else if (e.data === "STOP") {
            if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
            }
          }
        };
        intervalId = setInterval(() => {
          self.postMessage({ type: "WORKER_TICK", time: Date.now() });
        }, 1000);
      `;
      const blob = new Blob([blobCode], { type: "application/javascript" });
      timerWorker = new Worker(URL.createObjectURL(blob));
    } catch (blobErr) {
      rec("WORKER_ERROR", { error: blobErr?.message || String(blobErr) });
    }
  }

  if (timerWorker) {
    timerWorker.onmessage = (e) => {
      if (e.data?.type === "WORKER_TICK") {
        handleHeartbeat(e.data.time);
      }
    };
    try {
      timerWorker.postMessage("START");
    } catch (_) {}
  }
}

/**
 * Processa batimento de 1s e transmite para a extensão via sendMessage.
 * @param {number} [tickTime=Date.now()]
 */
export function handleHeartbeat(tickTime = Date.now()) {
  const nowSec = Math.floor(tickTime / 1000);
  rec("OFFSCREEN_HEARTBEAT", { tickTime, nowSec });

  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_HEARTBEAT",
        tickTime,
        nowSec,
      }).catch(() => {});
    } catch (_) {}
  }
}

// Inicialização automática em contexto de janela do navegador
if (typeof window !== "undefined") {
  initSilentAudio();
  initTimerWorker();
}
