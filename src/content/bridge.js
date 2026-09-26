/**
 * bridge.js - Bridge Segura entre MAIN World e Contexto Isolado
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Escutar mensagens emitidas pelo MAIN world via window.postMessage.
 * - Validar rigorosamente:
 *     1. event.source === window (somente mesma janela).
 *     2. event.origin (somente domínios autorizados da B2Trading).
 *     3. sessionId válido e não vazio.
 *     4. Limite de tamanho de payload (máx 500 KB).
 *     5. Schema estrutural de eventos de mercado.
 * - Encaminhar apenas dados validados para o Analyzer na aba ativa.
 * - Rejeitar e descartar mensagens forjadas ou inválidas.
 */

const ALLOWED_ORIGINS = new Set([
  "https://traderoom.b2trading.io",
  "https://chart.b2trading.io",
  typeof window !== "undefined" ? window.location.origin : "",
]);

const MAX_MESSAGE_SIZE = 500 * 1024; // 500 KB

/**
 * Validador estrutural e de segurança da bridge.
 *
 * @param {MessageEvent} event
 * @param {string} [expectedSessionId]
 * @returns {{ valid: boolean, reason?: string, data?: any }}
 */
export function validateBridgeMessage(event, expectedSessionId = null) {
  if (!event || typeof event !== "object") {
    return { valid: false, reason: "Mensagem vazia ou inválida" };
  }

  // 1. Validação de domínio de origem: domínios autorizados da B2Trading ou localOrigin
  const localOrigin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : null;
  const isAllowedOrigin = ALLOWED_ORIGINS.has(event.origin) || (localOrigin && event.origin === localOrigin);
  if (!isAllowedOrigin) {
    return { valid: false, reason: `Domínio de origem não autorizado: ${event.origin}` };
  }

  // 2. Validação de fonte: deve ser a própria janela ou uma iframe filha (ou origem autorizada)
  const isLocalOrChild = (typeof window !== "undefined" && (event.source === window || event.source === null || (window.frames && Array.from(window.frames).includes(event.source))));
  if (!isLocalOrChild && !ALLOWED_ORIGINS.has(event.origin)) {
    return { valid: false, reason: "Origem da fonte não pertence à janela local ou iframe autorizada" };
  }

  const data = event.data;
  if (!data || typeof data !== "object") {
    return { valid: false, reason: "Corpo da mensagem não é um objeto" };
  }

  // 3. Validação de tipo de evento esperado
  if (
    data.type !== "ORACLE_MAIN_MARKET_EVENT" &&
    data.type !== "ORACLE_SOCKET_STATUS" &&
    data.type !== "ORACLE_CHANNEL" &&
    data.type !== "ORACLE_ACCESSORY_STATUS"
  ) {
    return { valid: false, reason: `Tipo de evento desconhecido: ${data.type}` };
  }

  // 4. Validação do sessionId
  if (!data.sessionId || typeof data.sessionId !== "string" || !data.sessionId.startsWith("sess_")) {
    return { valid: false, reason: "sessionId inválido ou ausente" };
  }
  if (expectedSessionId && data.sessionId !== expectedSessionId) {
    return { valid: false, reason: "sessionId não corresponde à sessão esperada" };
  }

  // 5. Validação de tamanho
  try {
    const size = JSON.stringify(data.payload || data).length;
    if (size > MAX_MESSAGE_SIZE) {
      return { valid: false, reason: `Tamanho excede o limite máximo: ${size} bytes` };
    }
  } catch (e) {
    return { valid: false, reason: "Erro ao serializar payload para verificação de tamanho" };
  }

  return { valid: true, data };
}

let activeSessionId = null;

/**
 * Inicializa o listener seguro da Bridge no content script isolado.
 *
 * @param {Object} options
 * @param {Function} options.onMarketEvent - Callback({ type: "MARKET_EVENT", sessionId, origin, receivedAt, payload, meta, sourceType })
 * @param {Function} [options.onSocketStatus] - Callback({ type: "SOCKET_STATUS", status, url })
 * @param {Function} [options.onChannel] - Callback({ type: "ORACLE_CHANNEL", sessionId, action, pair, tf, at })
 */
export function initBridgeListener(options = {}) {
  if (typeof window === "undefined") return () => {};
  if (window.__oracleBridgeListenerActive) return () => {};
  window.__oracleBridgeListenerActive = true;

  const messageHandler = (event) => {
    // Repassa eventos de gravação de voo vindos do MAIN world diretamente para o Service Worker
    if (event.data?.type === "ORACLE_FLIGHT_REC" && event.data.record) {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
          chrome.runtime.sendMessage(
            {
              type: "REC",
              record: event.data.record,
            },
            () => {
              if (chrome.runtime?.lastError) {}
            }
          );
        } catch (_) {}
      }
      return;
    }

    // Filtro rápido de tipo
    if (
      !event.data ||
      (event.data.type !== "ORACLE_MAIN_MARKET_EVENT" &&
        event.data.type !== "ORACLE_SOCKET_STATUS" &&
        event.data.type !== "ORACLE_CHANNEL")
    ) {
      return;
    }

    const check = validateBridgeMessage(event);
    if (!check.valid) {
      // Rejeita silenciosamente mensagens não conformes
      return;
    }

    const { data } = check;

    if (data.type === "ORACLE_MAIN_MARKET_EVENT" && typeof options.onMarketEvent === "function") {
      options.onMarketEvent({
        type: "MARKET_EVENT",
        sessionId: data.sessionId,
        origin: event.origin || window.location.origin,
        receivedAt: data.receivedAt || Date.now(),
        sourceType: data.sourceType || "websocket",
        url: data.url || "",
        meta: data.meta || null,
        payload: data.payload,
      });
    } else if (data.type === "ORACLE_SOCKET_STATUS" && typeof options.onSocketStatus === "function") {
      options.onSocketStatus({
        type: "SOCKET_STATUS",
        status: data.status,
        url: data.url,
      });
    } else if (data.type === "ORACLE_CHANNEL" && typeof options.onChannel === "function") {
      options.onChannel({
        type: "ORACLE_CHANNEL",
        sessionId: data.sessionId,
        action: data.action,
        pair: data.pair,
        tf: data.tf,
        source: data.source || null,
        at: data.at,
      });
    } else if (data.type === "ORACLE_ACCESSORY_STATUS" && typeof options.onAccessoryStatus === "function") {
      options.onAccessoryStatus({
        type: "ACCESSORY_STATUS",
        url: data.url,
        status: data.status,
      });
    }
  };

  window.addEventListener("message", messageHandler);
  console.log("[OracleQuant] Bridge isolada aguardando telemetria no frame:", window.location.href);

  return () => {
    window.removeEventListener("message", messageHandler);
    window.__oracleBridgeListenerActive = false;
  };
}

// Inicialização automática em contexto de extensão
if (typeof window !== "undefined" && typeof chrome !== "undefined" && chrome.runtime?.id) {
  // A inicialização conectada é orquestrada em analyzer.js
}
