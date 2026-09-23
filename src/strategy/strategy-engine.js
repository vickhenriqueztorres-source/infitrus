/**
 * strategy-engine.js - Motor de Estratégia Técnica Local (EMA9_EMA21_RSI14)
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Calcular indicadores técnicos (EMA 9, EMA 21, RSI 14) sobre candles confirmados.
 * - Gerar sinais determinísticos: BUY (COMPRA), SELL (VENDA) ou WAIT (AGUARDAR).
 * - Exigir período de aquecimento mínimo (mínimo 22 candles).
 * - Deduplicar sinais por timestamp para evitar disparos repetidos no mesmo candle.
 *
 * RESTRIÇÃO DE SEGURANÇA:
 * - Modo estritamente consultivo e analítico.
 * - NENHUMA ordem ou clique automatizado é executado.
 */

import { getLatestEMAValues } from "../indicators/ema.js";
import { getLatestRSI } from "../indicators/rsi.js";

export const SignalAction = Object.freeze({
  BUY: "BUY",
  SELL: "SELL",
  WAIT: "WAIT",
});

export class StrategyEngine {
  /**
   * @param {Object} [config={}]
   * @param {number} [config.emaFastPeriod=9]
   * @param {number} [config.emaSlowPeriod=21]
   * @param {number} [config.rsiPeriod=14]
   */
  constructor(config = {}) {
    this.emaFastPeriod = config.emaFastPeriod || 9;
    this.emaSlowPeriod = config.emaSlowPeriod || 21;
    this.rsiPeriod = config.rsiPeriod || 14;
    this.minWarmupCandles = Math.max(this.emaSlowPeriod + 1, this.rsiPeriod + 1);

    /** @type {Map<string, string>} Deduplicação de sinais por chave */
    this.emittedSignals = new Map();
  }

  /**
   * Avalia a série de candles e retorna o sinal técnico com justificativa.
   *
   * @param {Object} params
   * @param {string} params.symbol
   * @param {number} params.timeframeSeconds
   * @param {Array<{ timestamp: number, close: number, open: number, high: number, low: number }>} params.candles - Velas fechadas ordenadas cronologicamente
   * @param {boolean} [params.isReady=true]
   * @returns {{
   *   action: "BUY"|"SELL"|"WAIT",
   *   label: string,
   *   symbol: string,
   *   timeframeSeconds: number,
   *   candleTimestamp: number|null,
   *   price: number|null,
   *   indicators: { ema9: number|null, ema21: number|null, rsi14: number|null },
   *   reasons: string[],
   *   isNewSignal: boolean
   * }}
   */
  evaluate({ symbol, timeframeSeconds, candles = [], isReady = true }) {
    const sym = String(symbol || "").trim().toUpperCase();
    const len = candles.length;

    // 1. Verificação de aquecimento mínimo
    if (!isReady || len < this.minWarmupCandles) {
      const lastCandle = len > 0 ? candles[len - 1] : null;
      return {
        action: SignalAction.WAIT,
        label: "AGUARDAR",
        symbol: sym,
        timeframeSeconds,
        candleTimestamp: lastCandle ? lastCandle.timestamp : null,
        price: lastCandle ? lastCandle.close : null,
        indicators: { ema9: null, ema21: null, rsi14: null },
        reasons: [`Aquecendo indicadores: ${len}/${this.minWarmupCandles} velas necessárias`],
        isNewSignal: false,
      };
    }

    const lastCandle = candles[len - 1];
    const prices = candles.map((c) => c.close);

    // 2. Cálculo dos indicadores técnicos
    const ema9 = getLatestEMAValues(prices, this.emaFastPeriod);
    const ema21 = getLatestEMAValues(prices, this.emaSlowPeriod);
    const rsi14 = getLatestRSI(prices, this.rsiPeriod);

    const hasIndicators =
      ema9.current !== null &&
      ema9.previous !== null &&
      ema21.current !== null &&
      ema21.previous !== null &&
      rsi14 !== null;

    if (!hasIndicators) {
      return {
        action: SignalAction.WAIT,
        label: "AGUARDAR",
        symbol: sym,
        timeframeSeconds,
        candleTimestamp: lastCandle.timestamp,
        price: lastCandle.close,
        indicators: {
          ema9: ema9.current ? Number(ema9.current.toFixed(5)) : null,
          ema21: ema21.current ? Number(ema21.current.toFixed(5)) : null,
          rsi14: rsi14 ? Number(rsi14.toFixed(2)) : null,
        },
        reasons: ["Aguardando convergência de indicadores"],
        isNewSignal: false,
      };
    }

    // 3. Regras da Estratégia EMA9_EMA21_RSI14 (PRD F-007)
    let action = SignalAction.WAIT;
    let label = "AGUARDAR";
    const reasons = [];

    const crossedAbove = ema9.previous <= ema21.previous && ema9.current > ema21.current;
    const crossedBelow = ema9.previous >= ema21.previous && ema9.current < ema21.current;

    if (crossedAbove && rsi14 > 50) {
      action = SignalAction.BUY;
      label = "COMPRA";
      reasons.push(`EMA 9 (${ema9.current.toFixed(5)}) cruzou acima da EMA 21 (${ema21.current.toFixed(5)})`);
      reasons.push(`RSI 14 em ${rsi14.toFixed(1)} (acima de 50)`);
      reasons.push(`Vela confirmada em ${lastCandle.close.toFixed(5)}`);
    } else if (crossedBelow && rsi14 < 50) {
      action = SignalAction.SELL;
      label = "VENDA";
      reasons.push(`EMA 9 (${ema9.current.toFixed(5)}) cruzou abaixo da EMA 21 (${ema21.current.toFixed(5)})`);
      reasons.push(`RSI 14 em ${rsi14.toFixed(1)} (abaixo de 50)`);
      reasons.push(`Vela confirmada em ${lastCandle.close.toFixed(5)}`);
    } else {
      // Estado de espera
      const trend = ema9.current > ema21.current ? "Alta (EMA9 > EMA21)" : "Baixa (EMA9 < EMA21)";
      reasons.push(`Tendência: ${trend}`);
      reasons.push(`RSI 14: ${rsi14.toFixed(1)}`);
      reasons.push("Sem cruzamento confirmado no último candle");
    }

    // 4. Deduplicação de Sinal (PRD F-008)
    const dedupKey = `${sym}:${timeframeSeconds}:${lastCandle.timestamp}`;
    const previousEmitted = this.emittedSignals.get(dedupKey);
    const isNewSignal = action !== SignalAction.WAIT && previousEmitted !== action;

    if (action !== SignalAction.WAIT) {
      this.emittedSignals.set(dedupKey, action);
      // Limpeza de memória periódica do mapa de deduplicação
      if (this.emittedSignals.size > 200) {
        const firstKey = this.emittedSignals.keys().next().value;
        this.emittedSignals.delete(firstKey);
      }
    }

    return {
      action,
      label,
      symbol: sym,
      timeframeSeconds,
      candleTimestamp: lastCandle.timestamp,
      price: lastCandle.close,
      indicators: {
        ema9: Number(ema9.current.toFixed(5)),
        ema21: Number(ema21.current.toFixed(5)),
        rsi14: Number(rsi14.toFixed(2)),
      },
      reasons,
      isNewSignal,
    };
  }
}
