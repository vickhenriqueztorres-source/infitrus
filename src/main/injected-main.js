/**
 * injected-main.js - Ponto de Entrada do MAIN World (Auto-contido)
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Executa no contexto nativo da página (MAIN world) no document_start antes de qualquer script da B2Trading.
 * - Envolve window.WebSocket, window.fetch e window.XMLHttpRequest de forma passiva.
 * - Sanitiza credenciais e despacha envelopes para a bridge no contexto isolado via window.postMessage.
 *
 * GARANTIAS DE SEGURANÇA:
 * - Modo estritamente observador.
 * - NUNCA invoca ws.send() ou faz novas requisições.
 * - NUNCA armazena ou expõe senhas, cookies, JWTs ou tokens.
 */

(function initOracleMainWorld() {
  if (typeof window === "undefined") return;
  if (window.__oracleMainInitialized) return;
  window.__oracleMainInitialized = true;

  // --- MOTOR DE SANITIZAÇÃO INTERNO ---
  const RE_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
  const RE_BEARER = /\b(bearer\s+)([A-Za-z0-9_\-.~]{10,})\b/gi;
  const RE_URL_TOKEN_PARAM = /([?&](?:token|access_token|refresh_token|jwt|auth|api_key|apikey|session|sessionId)=)([^&\s#]+)/gi;
  const RE_JSON_TOKEN = /(["']?(?:token|access_token|refresh_token|auth_token|authToken)["']?\s*[:=]\s*["'])(?!\[)([^"']*)(["'])/gi;
  const RE_PASSWORD = /(["']?(?:password|passwd|pwd|secret|client_secret)["']?\s*[:=]\s*["'])(?!\[)([^"']*)(["'])/gi;
  const RE_COOKIE = /(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["'])(?!\[)([^"']*)(["'])/gi;
  const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

  function sanitizeText(text) {
    if (!text || typeof text !== "string") return { sanitized: "", redactions: [] };
    const redactions = [];
    let result = text;
    const applyRedaction = (regex, replacement, tag) => {
      regex.lastIndex = 0;
      if (regex.test(result)) {
        regex.lastIndex = 0;
        result = result.replace(regex, replacement);
        redactions.push(tag);
      }
    };
    applyRedaction(RE_JWT, "[JWT_REDACTED]", "jwt");
    applyRedaction(RE_BEARER, "$1[TOKEN_REDACTED]", "bearer_token");
    applyRedaction(RE_URL_TOKEN_PARAM, "$1[TOKEN_REDACTED]", "query_token");
    applyRedaction(RE_JSON_TOKEN, "$1[TOKEN_REDACTED]$3", "json_token");
    applyRedaction(RE_PASSWORD, "$1[PASSWORD_REDACTED]$3", "password");
    applyRedaction(RE_COOKIE, "$1[COOKIE_REDACTED]$3", "cookie");
    applyRedaction(RE_EMAIL, "[EMAIL_REDACTED]", "email");
    return { sanitized: result, redactions };
  }

  function sanitizeUrl(url) {
    if (!url || typeof url !== "string") return "";
    return sanitizeText(url).sanitized;
  }

  // --- SESSÃO DO FRAME ---
  const sessionId = "sess_" + Math.random().toString(36).substring(2, 12) + "_" + Date.now();
  window.__oracleSessionId = sessionId;

  function dispatchToBridge(sourceType, eventData, receivedAt = Date.now()) {
    if (!eventData || !eventData.payload) return;
    try {
      window.postMessage(
        {
          type: "ORACLE_MAIN_MARKET_EVENT",
          sessionId,
          origin: window.location.origin,
          receivedAt: eventData.receivedAt || receivedAt,
          sourceType,
          url: eventData.url,
          meta: eventData.meta || null,
          payload: eventData.payload,
        },
        window.location.origin
      );
    } catch (err) {}
  }

  // --- OBSERVADOR PASSIVO DE WEBSOCKET ---
  if (typeof window.WebSocket === "function") {
    const OriginalWebSocket = window.WebSocket;

    function parseChannelString(str) {
      if (!str || typeof str !== "string") return null;
      const trimmed = str.trim();
      // Detecta resolução sufixada: -M1, -1, _1, -1m, _1m, -M5, etc.
      const resMatch = /[-_](?:M|m)?(\d+)(?:m|s)?$/i.exec(trimmed);
      if (resMatch) {
        const pair = trimmed.substring(0, resMatch.index).toUpperCase();
        const resolutionNum = Number(resMatch[1]);
        return { pair, tf: resolutionNum * 60 };
      }
      // Sem sufixo de resolução explícito: extrai par limpo
      const cleanMatch = /^([A-Z0-9_]+)/i.exec(trimmed);
      if (cleanMatch && cleanMatch[1]) {
        return { pair: cleanMatch[1].toUpperCase(), tf: 60 };
      }
      return null;
    }

    const originalSend = OriginalWebSocket.prototype.send;
    OriginalWebSocket.prototype.send = function (data) {
      try {
        let strData = typeof data === "string" ? data : "";
        if (strData) {
          const firstBracket = strData.search(/[{\[]/);
          if (firstBracket > 0) {
            strData = strData.substring(firstBracket);
          }
          if (strData.startsWith("{") || strData.startsWith("[")) {
            let parsed = JSON.parse(strData);
            if (Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[1] === "object") {
              parsed = parsed[1];
            }
            if (parsed && typeof parsed === "object") {
              const action = parsed.action || parsed.event || parsed.type;
              if (action === "subscribe" || action === "unsubscribe") {
                const rawChannel = parsed.channel || parsed.pair || parsed.symbol || parsed.asset || parsed.ticker || "";
                const parsedCh = parseChannelString(rawChannel);
                if (parsedCh && parsedCh.pair) {
                  window.postMessage(
                    {
                      type: "ORACLE_CHANNEL",
                      sessionId,
                      action,
                      pair: parsedCh.pair,
                      tf: parsedCh.tf || 60,
                      at: Date.now(),
                    },
                    window.location.origin
                  );
                }
              }
            }
          }
        }
      } catch (_) {}
      return originalSend.apply(this, arguments);
    };

    function PatchedWebSocket(url, protocols) {
      const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
      const sanitizedUrl = sanitizeUrl(String(url));
      const isMarketWs = sanitizedUrl.includes("ws.b2trading.io") || sanitizedUrl.includes("/ws");

      function processReceivedData(rawData, receivedAt = Date.now()) {
        if (!rawData) return;

        // Suporte assíncrono para Blob
        if (rawData instanceof Blob) {
          rawData.text().then((text) => processReceivedData(text, receivedAt)).catch(() => {});
          return;
        }

        // Suporte para ArrayBuffer e TypedArrays
        if (rawData instanceof ArrayBuffer) {
          try {
            processReceivedData(new TextDecoder("utf-8").decode(rawData), receivedAt);
          } catch (_) {}
          return;
        }
        if (ArrayBuffer.isView(rawData)) {
          try {
            processReceivedData(new TextDecoder("utf-8").decode(rawData.buffer), receivedAt);
          } catch (_) {}
          return;
        }

        if (typeof rawData !== "string") return;

        let str = rawData.trim();
        // Remove prefixos de protocolo (ex: Engine.IO / Socket.IO 42["tick", ...])
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

          if (isRelevant) {
            const { sanitized } = sanitizeText(JSON.stringify(parsed));
            const sanitizedPayload = JSON.parse(sanitized);

            dispatchToBridge("websocket", {
              url: sanitizedUrl,
              payload: sanitizedPayload,
              receivedAt,
            }, receivedAt);
          }
        } catch (err) {}
      }

      // Anexa ouvintes passivos DIRETAMENTE via Prototype Nativo do WebSocket
      // Filtra apenas WebSockets de mercado para evitar oscilações por sockets secundários de terceiros
      OriginalWebSocket.prototype.addEventListener.call(ws, "open", () => {
        if (!isMarketWs) return;
        try {
          window.postMessage(
            {
              type: "ORACLE_SOCKET_STATUS",
              sessionId,
              origin: window.location.origin,
              status: "connected",
              url: sanitizedUrl,
            },
            "*"
          );
        } catch (e) {}
      });

      OriginalWebSocket.prototype.addEventListener.call(ws, "close", () => {
        if (!isMarketWs) return;
        try {
          window.postMessage(
            {
              type: "ORACLE_SOCKET_STATUS",
              sessionId,
              origin: window.location.origin,
              status: "closed",
              url: sanitizedUrl,
            },
            "*"
          );
        } catch (e) {}
      });

      OriginalWebSocket.prototype.addEventListener.call(ws, "message", (event) => {
        const receivedAt = Date.now();
        try {
          processReceivedData(event.data, receivedAt);
        } catch (e) {}
      });

      return ws;
    }

    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;

    window.WebSocket = PatchedWebSocket;
  }

  // --- OBSERVADOR PASSIVO DE HTTP (HISTÓRICO: FETCH & XHR) ---
  const HISTORY_KEYWORDS = ["/api/market/history", "/api/market/latest", "/bars", "/history"];
  const MAX_PAYLOAD_SIZE = 500 * 1024;

  function parseHistoryUrlMeta(rawUrl) {
    try {
      const urlObj = new URL(rawUrl, window.location.href);
      const pair = urlObj.searchParams.get("pair") || urlObj.searchParams.get("symbol") || urlObj.searchParams.get("asset") || urlObj.searchParams.get("ticker") || null;
      const resolution = urlObj.searchParams.get("resolution") || urlObj.searchParams.get("tf") || null;
      const tf = resolution ? Number(resolution) * 60 : null;
      return {
        pair: pair ? pair.toUpperCase() : null,
        tf: Number.isFinite(tf) ? tf : null,
      };
    } catch (_) {
      return { pair: null, tf: null };
    }
  }

  function handleHistoryText(rawUrl, text) {
    if (!text || text.length > MAX_PAYLOAD_SIZE) return;
    try {
      const parsed = JSON.parse(text);
      const hasBars =
        Array.isArray(parsed.bars) ||
        (parsed.bar && typeof parsed.bar === "object") ||
        (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object");
      if (!hasBars) return;

      const meta = parseHistoryUrlMeta(rawUrl);
      if (!meta.pair) {
        const bodySym = parsed.pair || parsed.symbol || parsed.asset || parsed.ticker || (parsed.bar && (parsed.bar.pair || parsed.bar.symbol));
        if (bodySym && typeof bodySym === "string") {
          meta.pair = bodySym.toUpperCase();
        }
      }
      const { sanitized } = sanitizeText(JSON.stringify(parsed));
      dispatchToBridge("history", {
        url: sanitizeUrl(rawUrl),
        payload: JSON.parse(sanitized),
        meta,
        receivedAt: Date.now(),
      });
    } catch (e) {}
  }

  // 1. Interceptação passiva de fetch
  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = async function (resource, init) {
      const response = await originalFetch.apply(this, arguments);
      try {
        const rawUrl = typeof resource === "string" ? resource : resource?.url || "";
        const urlLower = rawUrl.toLowerCase();
        const isHistoryCandidate = HISTORY_KEYWORDS.some((kw) => urlLower.includes(kw));

        if (isHistoryCandidate && response.ok) {
          const clone = response.clone();
          clone.text().then((text) => handleHistoryText(rawUrl, text)).catch(() => {});
        }
      } catch (e) {}
      return response;
    };
  }

  // 2. Interceptação passiva de XMLHttpRequest
  if (typeof window.XMLHttpRequest === "function") {
    const OriginalXHR = window.XMLHttpRequest;
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
            handleHistoryText(rawUrl, this.responseText);
          }
        } catch (e) {}
      });

      return originalSend.apply(this, arguments);
    };
  }

  console.log("[OracleQuant] Observadores de mercado (MAIN world) ativos no frame:", window.location.href);
})();
