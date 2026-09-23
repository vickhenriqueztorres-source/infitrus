/**
 * ema.js - Média Móvel Exponencial (EMA)
 * Oracle Quant Signals
 *
 * Fórmula:
 *   Multiplier = 2 / (period + 1)
 *   EMA_inicial = SMA dos primeiros 'period' elementos
 *   EMA_t = (Preço_t - EMA_t-1) * Multiplier + EMA_t-1
 */

/**
 * Calcula a série completa de EMA para uma série de preços de fechamento.
 *
 * @param {number[]} prices - Array de preços (ordenados cronologicamente do mais antigo para o mais recente)
 * @param {number} period - Período da média (ex: 9, 21)
 * @returns {Array<number|null>} Array de valores EMA com o mesmo tamanho de prices
 */
export function calculateEMA(prices, period) {
  if (!Array.isArray(prices) || prices.length < period || period <= 0) {
    return Array(prices ? prices.length : 0).fill(null);
  }

  const results = Array(prices.length).fill(null);
  const multiplier = 2 / (period + 1);

  // 1. O primeiro valor de EMA é a SMA dos primeiros 'period' preços
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  let currentEMA = sum / period;
  results[period - 1] = currentEMA;

  // 2. Itera calculando os valores subsequentes
  for (let i = period; i < prices.length; i++) {
    currentEMA = (prices[i] - currentEMA) * multiplier + currentEMA;
    results[i] = currentEMA;
  }

  return results;
}

/**
 * Retorna os dois últimos valores de EMA (atual e anterior) para detecção de cruzamento.
 *
 * @param {number[]} prices
 * @param {number} period
 * @returns {{ current: number|null, previous: number|null }}
 */
export function getLatestEMAValues(prices, period) {
  const series = calculateEMA(prices, period);
  const len = series.length;
  if (len < period) {
    return { current: null, previous: null };
  }
  return {
    current: series[len - 1],
    previous: len >= period + 1 ? series[len - 2] : null,
  };
}
