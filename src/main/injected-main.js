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

  function recMain(type, payload) {
    try {
      const tWall = Date.now();
      const tPerf = typeof performance !== "undefined" && performance.now ? performance.now() : 0;
      const record = {
        tWall,
        tPerf,
        ctx: "main",
        tabId: null,
        frameId: null,
        windowId: null,
        instanceId: sessionId,
        type,
        payload,
      };
      window.postMessage(
        {
          type: "ORACLE_FLIGHT_REC",
          record,
        },
        "*"
      );
    } catch (_) {}
  }

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

  // --- PALAVRAS RESERVADAS QUE NÃO SÃO ATIVOS ---
  const NON_SYMBOL_WORDS = new Set([
    "TICKER", "TRADE", "TRADES", "QUOTES", "QUOTE", "CANDLE", "CANDLES",
    "BARS", "KLINE", "KLINES", "SUB", "UNSUB", "SUBSCRIBE", "UNSUBSCRIBE",
    "PING", "PONG", "SYSTEM", "DEFAULT", "STREAM", "MARKET", "DATA", "DEPTH",
    "ORDERBOOK", "STATUS", "AUTH", "LOGIN", "TOPIC", "CHANNEL", "EVENT",
    "UPDATE", "UPDATES", "SNAPSHOT", "INITIAL", "CONFIG", "ERROR", "RESPONSE",
    "REQUEST", "INFO", "HEARTBEAT", "SERVER", "CLIENT", "MESSAGE", "MESSAGES",
    "B2TRADING", "TRADING", "BROKER"
  ]);

  function extractCleanSymbol(raw) {
    if (!raw || typeof raw !== "string") return null;
    const clean = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
    if (clean.length >= 3 && !NON_SYMBOL_WORDS.has(clean)) {
      return clean;
    }
    return null;
  }

  function extractSymbolFromWsObject(obj) {
    if (!obj || typeof obj !== "object") return null;
    const directCandidates = [obj.pair, obj.symbol, obj.asset, obj.ticker, obj.s, obj.instrument];
    for (const cand of directCandidates) {
      const sym = extractCleanSymbol(cand);
      if (sym) return sym;
    }
    const topicCandidates = [obj.channel, obj.topic, obj.stream, obj.event, obj.name];
    for (const topic of topicCandidates) {
      if (topic && typeof topic === "string") {
        const parts = topic.split(/[.:@/_-]/);
        for (const part of parts) {
          const sym = extractCleanSymbol(part);
          if (sym) return sym;
        }
      }
    }
    if (obj.data && typeof obj.data === "object") {
      return extractSymbolFromWsObject(obj.data);
    }
    return null;
  }

  // --- TELEMETRIA EM TEMPO REAL ---
  const activeSockets = new Set();
  let wsMessagesCount = 0;
  let lastWsMessageTime = 0;
  let lastParsedTick = null;
  const capturedChannels = new Map();

  // --- OBSERVADOR PASSIVO DE WEBSOCKET ---
  if (typeof window.WebSocket === "function") {
    const OriginalWebSocket = window.WebSocket;

    function parseChannelString(str) {
      if (!str || typeof str !== "string") return null;
      const trimmed = str.trim();
      const resMatch = /[-_](?:M|m)?(\d+)(?:m|s)?$/i.exec(trimmed);
      if (resMatch) {
        const pair = extractCleanSymbol(trimmed.substring(0, resMatch.index));
        const resolutionNum = Number(resMatch[1]);
        return pair ? { pair, tf: resolutionNum * 60 } : null;
      }
      const sym = extractCleanSymbol(trimmed);
      if (sym) {
        return { pair: sym, tf: 60 };
      }
      return null;
    }

    const originalSend = OriginalWebSocket.prototype.send;
    OriginalWebSocket.prototype.send = function (data) {
      try {
        let strData = typeof data === "string" ? data : (data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? "[binary]" : String(data || ""));
        recMain("WS_SEND", { text: strData.substring(0, 300) });

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
              const action = String(parsed.action || parsed.event || parsed.type || "").toLowerCase();
              const isSub = action.includes("sub") || action.includes("join") || action.includes("watch");
              const isUnsub = action.includes("unsub") || action.includes("leave");

              if (isSub || isUnsub) {
                const pair = extractSymbolFromWsObject(parsed);
                if (pair) {
                  const parsedCh = parseChannelString(parsed.channel || parsed.topic || "");
                  const tf = parsedCh?.tf || 60;
                  const act = isUnsub ? "unsubscribe" : "subscribe";
                  if (act === "subscribe") {
                    capturedChannels.set(pair, { tf, at: Date.now() });
                  } else {
                    capturedChannels.delete(pair);
                  }
                  window.postMessage(
                    {
                      type: "ORACLE_CHANNEL",
                      sessionId,
                      action: act,
                      pair,
                      tf,
                      at: Date.now(),
                    },
                    "*"
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
      const isMarketWs = sanitizedUrl.includes("b2trading.io") || sanitizedUrl.includes("ws");

      ws.__oracleCleanUrl = sanitizedUrl;
      ws.__oracleMsgCount = 0;
      activeSockets.add(ws);

      function processReceivedData(rawData, receivedAt = Date.now()) {
        if (!rawData) return;
        wsMessagesCount++;
        lastWsMessageTime = Date.now();
        ws.__oracleMsgCount = (ws.__oracleMsgCount || 0) + 1;

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
        const firstBracket = str.search(/[{\[]/);
        if (firstBracket > 0) {
          str = str.substring(firstBracket);
        }
        if (!str.startsWith("{") && !str.startsWith("[")) return;

        try {
          const parsed = JSON.parse(str);
          if (!parsed || typeof parsed !== "object") return;

          // Resumo de WS_FRAME para o Flight Recorder
          const fPair = extractSymbolFromWsObject(parsed) ||
            (parsed.bar && extractSymbolFromWsObject(parsed.bar)) ||
            (Array.isArray(parsed) && extractSymbolFromWsObject(parsed[0])) ||
            null;
          const fChannel = parsed.channel || parsed.name || parsed.event || parsed.type || null;
          const fBar = parsed.bar || parsed.candle || (Array.isArray(parsed.bars) ? parsed.bars[0] : (Array.isArray(parsed) ? parsed[0] : parsed));
          const fTs = fBar?.timestamp || fBar?.time || fBar?.t || parsed.time || parsed.timestamp || parsed.t || receivedAt;
          const fO = fBar?.open ?? fBar?.o ?? parsed.open ?? parsed.o ?? null;
          const fH = fBar?.high ?? fBar?.h ?? parsed.high ?? parsed.h ?? null;
          const fL = fBar?.low ?? fBar?.l ?? parsed.low ?? parsed.l ?? null;
          const fC = fBar?.close ?? fBar?.c ?? parsed.price ?? parsed.p ?? parsed.rate ?? null;
          const fTf = fBar?.tf || fBar?.resolution || parsed.tf || parsed.resolution || null;
          const fClosed = fBar?.closed !== undefined ? fBar.closed : (parsed.closed !== undefined ? parsed.closed : null);

          if (fC !== null) {
            lastParsedTick = { pair: fPair, price: fC, time: fTs };
          }

          recMain("WS_FRAME", {
            channel: fChannel,
            pair: fPair,
            tf: fTf,
            ts: fTs,
            o: fO,
            h: fH,
            l: fL,
            c: fC,
            closed: fClosed,
          });

          let isRelevant = false;
          if (fPair || parsed.pair || parsed.symbol || parsed.asset || parsed.ticker) {
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

      OriginalWebSocket.prototype.addEventListener.call(ws, "open", () => {
        if (!isMarketWs) return;
        recMain("WS_OPEN", { url: sanitizedUrl });
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
        activeSockets.delete(ws);
        if (!isMarketWs) return;
        recMain("WS_CLOSE", { url: sanitizedUrl });
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

    function scanAndHookIframes() {
      if (typeof document === "undefined") return;
      const iframes = document.querySelectorAll("iframe");
      iframes.forEach((iframe) => {
        try {
          const frameWin = iframe.contentWindow;
          if (!frameWin || frameWin.__oracleWsHooked) return;
          frameWin.__oracleWsHooked = true;
          if (typeof frameWin.WebSocket === "function" && frameWin.WebSocket !== PatchedWebSocket) {
            frameWin.WebSocket = PatchedWebSocket;
          }
        } catch (_) {}
      });
    }

    if (typeof setInterval !== "undefined") {
      setInterval(scanAndHookIframes, 2500);
    }
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

  // --- API DE DIAGNÓSTICO INTERATIVO NO CONSOLE DO NAVEGADOR ---
  const oracleDebug = {
    status: function () {
      console.log("%c================ [OracleQuant] STATUS DIAGNÓSTICO ================", "color: #00ff88; font-weight: bold; font-size: 13px;");
      const silenceSec = lastWsMessageTime ? ((Date.now() - lastWsMessageTime) / 1000).toFixed(1) : null;
      const mainReport = {
        "MAIN World Hook": window.__oracleMainInitialized ? "✅ Ativo" : "❌ Inativo",
        "Content Loader": window.__oracleLoaded ? "✅ Carregado" : (window.__oracleLoaderError ? "❌ Falha" : "⏳ Carregando..."),
        "Sockets WS Ativos": activeSockets.size,
        "Total Msgs WS": wsMessagesCount,
        "Tempo Sem Ticks": silenceSec !== null ? `${silenceSec}s` : "Aguardando primeiro tick...",
        "Último Tick Capturado": lastParsedTick ? `${lastParsedTick.pair || "---"} @ ${lastParsedTick.price}` : "Nenhum",
        "Canais Capturados": Array.from(capturedChannels.keys()).join(", ") || "Nenhum (aguardando fluxo)",
      };
      console.table(mainReport);

      if (window.__oracleLoaderError) {
        console.error("%c[OracleQuant ERRO DE CARREGAMENTO]", "color: #ff4444; font-weight: bold;", window.__oracleLoaderError);
      }

      console.log("%cConsultando Analyzer no contexto isolado via bridge...", "color: #00bbff;");
      const pongPromise = new Promise((resolve) => {
        const handler = (e) => {
          if (e.data?.type === "ORACLE_DEBUG_PONG") {
            window.removeEventListener("message", handler);
            resolve(e.data.snapshot);
          }
        };
        window.addEventListener("message", handler);
        setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(null);
        }, 1200);
      });

      window.postMessage({ type: "ORACLE_DEBUG_PING" }, "*");

      pongPromise.then((snap) => {
        if (!snap) {
          console.warn("%c[Analyzer] Não respondeu em 1.2s. Verifique se o Side Panel está aberto e se a página é um frame de cálculo autorizado.", "color: #ffaa00; font-weight: bold;");
          return;
        }
        console.log("%c================ ESTADO INTERNO DO ANALYZER ================", "color: #00ff88; font-weight: bold;");
        const analyzerReport = {
          "Estado de Dados": snap.status || "DESCONHECIDO",
          "Ativo Selecionado": snap.currentSymbol || "Nenhum",
          "Ativos Monitorados": snap.activeSymbols?.join(", ") || "Nenhum",
          "Velas no Store": JSON.stringify(snap.candleCounts || {}),
          "Últimos Preços": JSON.stringify(snap.lastPrices || {}),
          "Gravações Storage": snap.storageWrites ?? 0,
          "Sinais Auditados": snap.signalsCount ?? 0,
          "Fase do Sinal": snap.lifecycleSnapshot?.current?.phase || snap.lifecycleSnapshot?.trade?.phase || "SCANNING",
        };
        console.table(analyzerReport);
        console.log("%c👉 Dica: Execute oracleDebug.testTick('EURUSD', 1.0850) para enviar tick de teste.", "color: #00bbff;");
      });
      return "Diagnóstico iniciado...";
    },

    ws: function () {
      console.log("%c================ CONEXÕES WEBSOCKET B2TRADING ================", "color: #00bbff; font-weight: bold;");
      const list = [];
      let i = 1;
      activeSockets.forEach((ws) => {
        const stateStr = ws.readyState === 0 ? "CONNECTING" : ws.readyState === 1 ? "OPEN" : ws.readyState === 2 ? "CLOSING" : "CLOSED";
        list.push({
          "#": i++,
          "URL": ws.__oracleCleanUrl || ws.url || "---",
          "Estado": stateStr,
          "Msgs": ws.__oracleMsgCount || 0,
        });
      });
      if (list.length === 0) {
        console.warn("Nenhum WebSocket ativo interceptado.");
      } else {
        console.table(list);
      }
      return list;
    },

    testTick: function (pair = "EURUSD", price = 1.0850) {
      const p = Number(price);
      const sym = String(pair).toUpperCase();
      console.log(`%c[OracleQuant TEST] Injetando tick de teste: ${sym} = ${p}`, "color: #00ff88; font-weight: bold;");
      dispatchToBridge("websocket", {
        url: "wss://test.b2trading.io/ws",
        payload: {
          pair: sym,
          data: {
            time: Date.now(),
            open: p,
            high: p + 0.0001,
            low: p - 0.0001,
            close: p,
            volume: 10,
          },
        },
        receivedAt: Date.now(),
      });
      return `Tick enviado para ${sym} a ${p}`;
    },

    signals: function () {
      return this.status();
    },

    help: function () {
      console.log("%c================ ORACLE QUANT COMANDOS NO CONSOLE ================", "color: #00ff88; font-weight: bold;");
      console.log("%coracleDebug.status()      %c-> Exibe status completo do WebSocket, Analyzer e velas.", "color: #ffff00;", "color: #ffffff;");
      console.log("%coracleDebug.ws()          %c-> Lista todas as conexões WebSocket ativas e URLs.", "color: #ffff00;", "color: #ffffff;");
      console.log("%coracleDebug.testTick(par, preco) %c-> Injeta um tick de teste para validar o pipeline.", "color: #ffff00;", "color: #ffffff;");
      console.log("%coracleDebug.help()        %c-> Exibe esta lista de comandos.", "color: #ffff00;", "color: #ffffff;");
    },
  };

  window.oracleDebug = oracleDebug;
  window.b2debug = oracleDebug;

  console.log("%c[OracleQuant] ✅ Observador ativo no Traderoom!", "color: #00ff88; font-weight: bold; font-size: 13px;");
  console.log("%c👉 Digite %coracleDebug.status()%c no Console para inspecionar o fluxo em tempo real.", "color: #aaaaaa;", "color: #00ff88; font-weight: bold;", "color: #aaaaaa;");
})();
