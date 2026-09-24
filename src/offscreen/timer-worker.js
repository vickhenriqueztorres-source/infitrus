/**
 * timer-worker.js - Web Worker com Heartbeat de 1s
 * Oracle Quant Signals
 *
 * Imune a throttling de timers em segundo plano do Chrome (Chrome 88+ intensive throttling).
 */

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

// Inicia imediatamente ao ser instanciado
intervalId = setInterval(() => {
  self.postMessage({ type: "WORKER_TICK", time: Date.now() });
}, 1000);
