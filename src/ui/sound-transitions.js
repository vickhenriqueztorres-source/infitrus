/**
 * sound-transitions.js - Lógica Pura de Transição Sonora de Sinais (I-06, T-05)
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Extrair de forma pura e determinística quais efeitos sonoros devem ser reproduzidos
 *   com base nas transições de ciclo de vida do sinal e do segundo atual da vela.
 * - Garantir deduplicação estrita via playedSet.
 */

/**
 * Avalia as transições de ciclo de vida e retorna lista de sons a tocar.
 *
 * @param {Object|null} prevLifecycle
 * @param {Object|null} nextLifecycle
 * @param {number} secondInCandle - Segundo decorrido na vela (0 a 59)
 * @param {Set<string>} playedSet - Conjunto de eventos sonoros já reproduzidos
 * @returns {string[]} Lista de identificadores de sons: "call" | "put" | "pip" | "entry" | "win" | "loss" | "doji"
 */
export function soundsForTransition(prevLifecycle, nextLifecycle, secondInCandle, playedSet = new Set()) {
  const sounds = [];
  if (!nextLifecycle || typeof nextLifecycle !== "object") return sounds;

  // 1. PRE_SIGNAL: alerta de direção fixada (CALL / PUT)
  const currentSignal = nextLifecycle.current;
  if (currentSignal && currentSignal.phase === "PRE_SIGNAL" && currentSignal.id) {
    const key = `${currentSignal.id}:PRE_SIGNAL`;
    if (!playedSet.has(key)) {
      playedSet.add(key);
      sounds.push(currentSignal.direction === "CALL" ? "call" : "put");
    }

    // Pips nos segundos 57, 58 e 59 da vela formadora
    if (secondInCandle >= 57 && secondInCandle <= 59) {
      const pipKey = `${currentSignal.id}:pip:${secondInCandle}`;
      if (!playedSet.has(pipKey)) {
        playedSet.add(pipKey);
        sounds.push("pip");
      }
    }
  }

  // 2. ENTRY_NOW: sinal de entrada no segundo 0 da vela seguinte
  const tradeSignal = nextLifecycle.trade;
  if (tradeSignal && tradeSignal.phase === "ENTRY_NOW" && tradeSignal.id) {
    const entryKey = `${tradeSignal.id}:ENTRY_NOW`;
    if (!playedSet.has(entryKey)) {
      playedSet.add(entryKey);
      sounds.push("entry");
    }
  }

  // 3. SETTLED: resultado da operação (WIN / LOSS / DOJI)
  const resultSignal = nextLifecycle.lastResult;
  if (resultSignal && resultSignal.phase === "SETTLED" && resultSignal.id) {
    const settledKey = `${resultSignal.id}:SETTLED`;
    if (!playedSet.has(settledKey)) {
      playedSet.add(settledKey);
      if (resultSignal.result === "WIN") {
        sounds.push("win");
      } else if (resultSignal.result === "LOSS") {
        sounds.push("loss");
      } else {
        sounds.push("doji");
      }
    }
  }

  return sounds;
}
