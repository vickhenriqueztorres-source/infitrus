/**
 * detector-types.js - Contrato Padronizado para Detectores Contínuos
 * Oracle Quant Signals
 *
 * Cada detector da nova arquitetura produz quatro variáveis contínuas em vez de um booleano:
 * - direction: 'CALL' | 'PUT' | 'NEUTRAL'
 * - strength: [0.0, 1.0] intensidade da evidência
 * - confidence: [0.0, 1.0] certeza estatística baseada na amostra e dispersão
 * - novelty: [0.0, 1.0] quão incomum ou anômalo é o estado em relação ao histórico recente
 * - rawScore: valor escalar numérico contínuo
 */

export function clamp(val, min = 0, max = 1) {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

/**
 * Constrói um objeto de sinal contínuo padronizado.
 *
 * @param {"CALL" | "PUT" | "NEUTRAL"} direction
 * @param {number} strength
 * @param {number} confidence
 * @param {number} novelty
 * @param {number} rawScore
 * @param {Object} [meta={}]
 * @returns {ContinuousSignal}
 */
export function createContinuousSignal(direction, strength, confidence, novelty, rawScore, meta = {}) {
  return {
    direction: direction || "NEUTRAL",
    strength: clamp(strength, 0, 1),
    confidence: clamp(confidence, 0, 1),
    novelty: clamp(novelty, 0, 1),
    rawScore: Number.isFinite(rawScore) ? Number(rawScore.toFixed(5)) : 0,
    meta,
  };
}
