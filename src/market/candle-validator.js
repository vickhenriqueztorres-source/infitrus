/**
 * candle-validator.js - Validador de Integridade e Coerência de Velas
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Validar que todos os campos de preço são finitos e estritamente positivos.
 * - Garantir coerência matemática geométrica:
 *     high >= max(open, close)
 *     low <= min(open, close)
 *     high >= low
 * - Garantir que o timestamp é inteiro e dentro de época válida.
 * - Rejeitar dados corrompidos antes da inserção no CandleStore.
 */

const EPSILON = 1e-9;
const MIN_VALID_TIMESTAMP = 946684800; // 01/01/2000 em segundos
const MAX_FUTURE_DRIFT_SECONDS = 300;  // máx 5 minutos à frente do relógio local

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Indica se o candle é matematicamente e financeiramente válido
 * @property {string[]} errors - Lista de motivos em caso de rejeição
 */

/**
 * Realiza validação detalhada de uma vela retornando lista de erros encontrados.
 *
 * @param {any} candle
 * @param {Object} [options={}]
 * @returns {ValidationResult}
 */
export function validateCandle(candle, options = {}) {
  const errors = [];

  if (!candle || typeof candle !== "object") {
    return { valid: false, errors: ["Candle deve ser um objeto válido"] };
  }

  // 1. Validação do Símbolo
  if (!candle.symbol || typeof candle.symbol !== "string" || candle.symbol.trim() === "") {
    errors.push("Símbolo do ativo é obrigatório e deve ser uma string não vazia");
  }

  // 2. Validação do Timeframe
  const tf = Number(candle.timeframeSeconds);
  if (!Number.isInteger(tf) || tf <= 0) {
    errors.push("timeframeSeconds deve ser um número inteiro positivo");
  }

  // 3. Validação do Timestamp
  const ts = Number(candle.timestamp);
  if (!Number.isInteger(ts) || ts < MIN_VALID_TIMESTAMP) {
    errors.push(`Timestamp inválido ou anterior ao ano 2000: ${candle.timestamp}`);
  } else if (!options.skipFutureCheck) {
    const maxFuture = Math.floor(Date.now() / 1000) + MAX_FUTURE_DRIFT_SECONDS;
    if (ts > maxFuture) {
      errors.push(`Timestamp muito adiantado no futuro: ${ts} (max: ${maxFuture})`);
    }
  }

  // 4. Validação de Preços (Open, High, Low, Close)
  const o = Number(candle.open);
  const h = Number(candle.high);
  const l = Number(candle.low);
  const c = Number(candle.close);

  if (!Number.isFinite(o) || o <= 0) {
    errors.push(`Preço 'open' inválido: ${candle.open}`);
  }
  if (!Number.isFinite(h) || h <= 0) {
    errors.push(`Preço 'high' inválido: ${candle.high}`);
  }
  if (!Number.isFinite(l) || l <= 0) {
    errors.push(`Preço 'low' inválido: ${candle.low}`);
  }
  if (!Number.isFinite(c) || c <= 0) {
    errors.push(`Preço 'close' inválido: ${candle.close}`);
  }

  // Se algum preço já foi rejeitado, não testa geometria
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // 5. Coerência Geométrica da Barra OHLC
  if (h < l) {
    errors.push(`Máxima menor que mínima: high (${h}) < low (${l})`);
  }

  const maxOC = Math.max(o, c);
  if (h < maxOC - EPSILON) {
    errors.push(`Máxima inconsistente: high (${h}) menor que max(open, close) (${maxOC})`);
  }

  const minOC = Math.min(o, c);
  if (l > minOC + EPSILON) {
    errors.push(`Mínima inconsistente: low (${l}) maior que min(open, close) (${minOC})`);
  }

  // 6. Validação de Volume (opcional, mas se presente deve ser finito e >= 0)
  if (candle.volume !== undefined) {
    const v = Number(candle.volume);
    if (!Number.isFinite(v) || v < 0) {
      errors.push(`Volume inválido: ${candle.volume}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Retorna true apenas se o candle for completamente válido e coerente.
 *
 * @param {any} candle
 * @param {Object} [options={}]
 * @returns {boolean}
 */
export function isValidCandle(candle, options = {}) {
  return validateCandle(candle, options).valid;
}
