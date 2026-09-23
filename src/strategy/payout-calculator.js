/**
 * payout-calculator.js - Calculadora de Expectativa Matemática e Payout
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Calcular ponto de equilíbrio (breakeven win rate): 1 / (1 + payout).
 * - Calcular Expectativa Matemática (EV): EV = P * payout - (1 - P) * 1.0.
 * - Determinar se uma probabilidade estimada oferece vantagem estatística diante do payout disponível.
 */

export const DEFAULT_PAYOUT = 0.80; // Payout líquido padrão de 80% (paga +0.80 por unidade)
export const DEFAULT_MIN_EV = 0.02; // Margem mínima de EV (+2% de lucro esperado por unidade)

/**
 * Calcula a probabilidade mínima de acerto necessária para empatar com a corretora.
 *
 * @param {number} [payout=0.80] Payout líquido (ex: 0.80 para 80%)
 * @returns {number} Taxa de acerto de equilíbrio entre 0 e 1 (ex: 0.5556 para 80%)
 */
export function calculateBreakevenWinRate(payout = DEFAULT_PAYOUT) {
  const p = Number(payout);
  if (!Number.isFinite(p) || p <= 0) return 0.5556;
  return 1 / (1 + p);
}

/**
 * Calcula a expectativa matemática de lucro por unidade investida.
 *
 * @param {number} winProbability Probabilidade estimada de acerto (0 a 1)
 * @param {number} [payout=0.80] Payout líquido oferecido
 * @returns {number} Expectativa em unidades (ex: +0.08 para 60% com payout 80%)
 */
export function calculateExpectedValue(winProbability, payout = DEFAULT_PAYOUT) {
  const prob = Math.max(0, Math.min(1, Number(winProbability) || 0));
  const p = Number(payout) || DEFAULT_PAYOUT;
  const lossProb = 1 - prob;
  return prob * p - lossProb * 1.0;
}

/**
 * Verifica se a probabilidade atinge o limiar mínimo de vantagem estatística.
 *
 * @param {number} winProbability
 * @param {number} [payout=0.80]
 * @param {number} [minEV=DEFAULT_MIN_EV]
 * @returns {{ isFavorable: boolean, ev: number, breakeven: number }}
 */
export function evaluateExpectation(winProbability, payout = DEFAULT_PAYOUT, minEV = DEFAULT_MIN_EV) {
  const ev = calculateExpectedValue(winProbability, payout);
  const breakeven = calculateBreakevenWinRate(payout);
  return {
    isFavorable: ev >= minEV,
    ev: Number(ev.toFixed(4)),
    breakeven: Number(breakeven.toFixed(4)),
  };
}
