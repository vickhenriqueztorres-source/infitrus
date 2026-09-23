/**
 * websocket-observer.js - Observador Passivo de WebSockets no MAIN World
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Instalar-se no MAIN world no document_start antes da criação de qualquer socket pela página.
 * - Envolver window.WebSocket para monitorar conexões criadas legitimamente pela aplicação.
 * - Capturar exclusivamente mensagens RECEBIDAS (addEventListener e onmessage).
 * - Identificar URL sanitizada.
 * - Interpretar mensagens de texto JSON e reconhecer envelopes de cotação/tick da B2Trading:
 *     { pair, messages: [{ name: "tick", data: { time, open, high, low, close, volume } }] }
 * - Disparar callback seguro com dados sanitizados.
 *
 * GARANTIAS DE SEGURANÇA:
 * - NUNCA invoca ws.send().
 * - NUNCA altera ou bloqueia os frames entregues à página.
 * - NUNCA cria conexões artificiais ou reconexões.
 */

import { sanitizeText, sanitizeUrl } from "./sanitizer.js";

/**
 * Instala o observador passivo no objeto global de WebSocket da janela.
 *
 * @param {Object} options
 * @param {Function} options.onMarketMessage - Callback chamado com { url, payload, receivedAt }
 * @param {Function} [options.onSocketCreated] - Callback chamado quando um socket é criado
 * @param {Function} [options.onSocketClosed] - Callback chamado quando o socket é fechado
 * @param {Window} [options.targetWindow=window]
 */
export function installWebSocketObserver(options = {}) {
  const targetWindow = options.targetWindow || (typeof window !== "undefined" ? window : null);
  if (!targetWindow || typeof targetWindow.WebSocket !== "function") {
    return;
  }

  // Evita instalação duplicada no mesmo contexto
  if (targetWindow.__oracleWsObserverInstalled) {
    return;
  }
  targetWindow.__oracleWsObserverInstalled = true;

  const OriginalWebSocket = targetWindow.WebSocket;

  /**
   * Wrapper passivo de WebSocket
   */
  function PatchedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
    const sanitizedUrl = sanitizeUrl(String(url));

    function processReceivedData(rawData) {
      if (!rawData) return;

      // Suporte assíncrono para Blob
      if (typeof Blob !== "undefined" && rawData instanceof Blob) {
        rawData.text().then((text) => processReceivedData(text)).catch(() => {});
        return;
      }

      // Suporte para ArrayBuffer e TypedArrays
      if (typeof ArrayBuffer !== "undefined" && rawData instanceof ArrayBuffer) {
        try {
          processReceivedData(new TextDecoder("utf-8").decode(rawData));
        } catch (_) {}
        return;
      }
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(rawData)) {
        try {
          processReceivedData(new TextDecoder("utf-8").decode(rawData.buffer));
        } catch (_) {}
        return;
      }

      if (typeof rawData !== "string") return;

      let str = rawData.trim();
      // Remove prefixos de protocolo (ex: Socket.IO 42["tick", ...])
      const firstBracket = str.search(/[{\[]/);
      if (firstBracket > 0) {
        str = str.substring(firstBracket);
      }
      if (!str.startsWith("{") && !str.startsWith("[")) return;

      try {
        const parsed = JSON.parse(str);
        if (!parsed || typeof parsed !== "object") return;

        let isRelevant = false;
        if (parsed.pair || parsed.symbol || parsed.asset || parsed.ticker) {
          isRelevant = true;
        } else if (parsed.event || parsed.name === "tick" || parsed.type === "tick") {
          isRelevant = true;
        } else if (
          parsed.price !== undefined ||
          parsed.p !== undefined ||
          parsed.close !== undefined ||
          parsed.c !== undefined ||
          parsed.rate !== undefined ||
          parsed.bars ||
          parsed.candles
        ) {
          isRelevant = true;
        } else if (Array.isArray(parsed) && parsed.length > 0) {
          isRelevant = true;
        }

        if (isRelevant && typeof options.onMarketMessage === "function") {
          const { sanitized } = sanitizeText(JSON.stringify(parsed));
          const sanitizedPayload = JSON.parse(sanitized);

          options.onMarketMessage({
            url: sanitizedUrl,
            payload: sanitizedPayload,
            receivedAt: Date.now(),
          });
        }
      } catch (err) {}
    }

    // Anexa ouvintes passivos DIRETAMENTE via Prototype Nativo do WebSocket
    // Mantém ws.onmessage e ws.addEventListener da corretora 100% nativos e intocados
    OriginalWebSocket.prototype.addEventListener.call(ws, "open", () => {
      if (typeof options.onSocketCreated === "function") {
        try {
          options.onSocketCreated({ url: sanitizedUrl, createdAt: Date.now() });
        } catch (e) {}
      }
    });

    OriginalWebSocket.prototype.addEventListener.call(ws, "close", () => {
      if (typeof options.onSocketClosed === "function") {
        try {
          options.onSocketClosed({ url: sanitizedUrl, closedAt: Date.now() });
        } catch (e) {}
      }
    });

    OriginalWebSocket.prototype.addEventListener.call(ws, "message", (event) => {
      try {
        processReceivedData(event.data);
      } catch (e) {}
    });

    return ws;
  }

  // Preserva protótipo e constantes de WebSocket (CONNECTING, OPEN, CLOSING, CLOSED)
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;

  targetWindow.WebSocket = PatchedWebSocket;
}
