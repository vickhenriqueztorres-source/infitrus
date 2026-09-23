/**
 * mock-data-helper.js - Gerador de candles para testes unitários quantitativos
 */

export function generateCandles(count = 50, startPrice = 1.0850, trendPattern = "UP") {
  const candles = [];
  let price = startPrice;
  const baseTime = 1727000000;

  for (let i = 0; i < count; i++) {
    const timestamp = baseTime + i * 60;
    let change = 0.0001;

    if (trendPattern === "UP") {
      change = 0.0002;
    } else if (trendPattern === "DOWN") {
      change = -0.0002;
    } else if (trendPattern === "ALTERNATING") {
      change = i % 2 === 0 ? 0.0002 : -0.0002;
    } else if (trendPattern === "STREAK_3_REVERSE") {
      // Cria blocos de 3 altas seguidas por 1 baixa
      change = (i % 4 < 3) ? 0.0002 : -0.0003;
    }

    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + 0.0001;
    const low = Math.min(open, close) - 0.0001;
    price = close;

    candles.push({
      symbol: "EURUSD",
      timeframeSeconds: 60,
      timestamp,
      open: Number(open.toFixed(5)),
      high: Number(high.toFixed(5)),
      low: Number(low.toFixed(5)),
      close: Number(close.toFixed(5)),
      volume: 100,
      closed: true,
      source: "history",
    });
  }

  return candles;
}
