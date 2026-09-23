/**
 * http-observer.js - Observador Passivo de HTTP (Fetch & XHR) no MAIN World
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Observar respostas recebidas de endpoints REST de histórico do gráfico:
 *     /api/market/history
 *     /api/market/latest
 *     /bars
 * - Reconhecer respostas JSON contendo { bars: [...] } ou { bar: {...} }.
 * - Sanitizar URLs e payloads antes do encaminhamento.
 * - Limitar tamanho dos dados para evitar consumo excessivo de memória.
 *
 * GARANTIAS DE SEGURANÇA:
 * - NUNCA faz novas requisições (zero calls to fetch/XHR originadas pela extensão).
 * - NUNCA repete ou modifica requisições da plataforma.
 * - Somente leitura de responses.
 */

import { sanitizeText, sanitizeUrl } from "./sanitizer.js";

const HISTORY_KEYWORDS = ["/api/market/history", "/api/market/latest", "/bars", "/history"];
const MAX_PAYLOAD_SIZE = 500 * 1024; // 500 KB

/**
 * Instala observadores passivos em window.fetch e window.XMLHttpRequest.
 *
 * @param {Object} options
 * @param {Function} options.onHistoryResponse - Callback({ url, payload, receivedAt })
 * @param {Window} [options.targetWindow=window]
 */
export function installHttpObserver(options = {}) {
  const targetWindow = options.targetWindow || (typeof window !== "undefined" ? window : null);
  if (!targetWindow) return;

  if (targetWindow.__oracleHttpObserverInstalled) return;
  targetWindow.__oracleHttpObserverInstalled = true;

  // 1. Interceptação passiva de window.fetch
  if (typeof targetWindow.fetch === "function") {
    const originalFetch = targetWindow.fetch;
    targetWindow.fetch = async function (resource, init) {
      const response = await originalFetch.apply(this, arguments);

      try {
        const rawUrl = typeof resource === "string" ? resource : resource?.url || "";
        const urlLower = rawUrl.toLowerCase();

        const isHistoryCandidate = HISTORY_KEYWORDS.some((kw) => urlLower.includes(kw));
        if (isHistoryCandidate && response.ok) {
          // Clona a resposta para leitura sem interferir no consumidor original da página
          const clone = response.clone();
          clone
            .text()
            .then((text) => {
              if (text.length > MAX_PAYLOAD_SIZE) return;
              processHistoryText(rawUrl, text, options.onHistoryResponse);
            })
            .catch(() => {});
        }
      } catch (e) {}

      return response;
    };
  }

  // 2. Interceptação passiva de XMLHttpRequest
  if (typeof targetWindow.XMLHttpRequest === "function") {
    const OriginalXHR = targetWindow.XMLHttpRequest;
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url) {
      this.__oracleUrl = typeof url === "string" ? url : "";
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          const rawUrl = this.__oracleUrl || "";
          const urlLower = rawUrl.toLowerCase();
          const isHistoryCandidate = HISTORY_KEYWORDS.some((kw) => urlLower.includes(kw));

          if (isHistoryCandidate && this.status >= 200 && this.status < 300) {
            const text = this.responseText;
            if (text && text.length <= MAX_PAYLOAD_SIZE) {
              processHistoryText(rawUrl, text, options.onHistoryResponse);
            }
          }
        } catch (e) {}
      });

      return originalSend.apply(this, arguments);
    };
  }
}

/**
 * Helper para validar e processar texto de resposta de histórico.
 * @private
 */
function processHistoryText(rawUrl, text, callback) {
  if (typeof callback !== "function") return;

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return;

    // Confirma presença de barras no formato B2Trading
    const hasBars = Array.isArray(parsed.bars) || (parsed.bar && typeof parsed.bar === "object");
    if (!hasBars) return;

    const sanitizedUrl = sanitizeUrl(rawUrl);
    const { sanitized } = sanitizeText(JSON.stringify(parsed));
    const sanitizedPayload = JSON.parse(sanitized);

    callback({
      url: sanitizedUrl,
      payload: sanitizedPayload,
      receivedAt: Date.now(),
    });
  } catch (e) {}
}
