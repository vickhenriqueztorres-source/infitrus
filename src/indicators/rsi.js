/**
 * rsi.js - Índice de Força Relativa (RSI / IFR - Wilder's Smoothing)
 * Oracle Quant Signals
 *
 * Fórmula:
 *   RS = Average Gain / Average Loss
 *   RSI = 100 - (100 / (1 + RS))
 *   Suavização pelo método clássico de J. Welles Wilder
 */

/**
 * Calcula a série completa de RSI para uma série de preços de fechamento.
 *
 * @param {number[]} prices - Array de preços (ordenados do mais antigo para o mais recente)
 * @param {number} [period=14] - Período do RSI
 * @returns {Array<number|null>} Array com valores de 0 a 100
 */
export function calculateRSI(prices, period = 14) {
  if (!Array.isArray(prices) || prices.length <= period || period <= 0) {
    return Array(prices ? prices.length : 0).fill(null);
  }

  const results = Array(prices.length).fill(null);

  // 1. Calcula as variações de preço (changes)
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  // 2. Primeiro ganho/perda médio via média simples dos primeiros 'period' deltas
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 0; i < period; i++) {
    const chg = changes[i];
    if (chg > 0) gainSum += chg;
    else if (chg < 0) lossSum += Math.abs(chg);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  // Primeiro valor de RSI no índice 'period'
  if (avgLoss === 0) {
    results[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    results[period] = 100 - 100 / (1 + rs);
  }

  // 3. Suavização de Wilder para os passos subsequentes
  for (let i = period; i < changes.length; i++) {
    const chg = changes[i];
    const gain = chg > 0 ? chg : 0;
    const loss = chg < 0 ? Math.abs(chg) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const targetIdx = i + 1;
    if (avgLoss === 0) {
      results[targetIdx] = 100;
    } else {
      const rs = avgGain / avgLoss;
      results[targetIdx] = 100 - 100 / (1 + rs);
    }
  }

  return results;
}

/**
 * Retorna o valor mais recente do RSI.
 *
 * @param {number[]} prices
 * @param {number} [period=14]
 * @returns {number|null}
 */
export function getLatestRSI(prices, period = 14) {
  const series = calculateRSI(prices, period);
  if (series.length === 0) return null;
  return series[series.length - 1];
}
