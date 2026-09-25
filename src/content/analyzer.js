/**
 * analyzer.js - Núcleo de Análise na Aba Ativa
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Orquestrar o fluxo de dados recebidos da Bridge:
 *     Bridge -> candle-normalizer -> candle-validator -> CandleStore -> DataQualityTracker
 * - Manter estado do ativo e timeframe ativos.
 * - Tratar conciliação de histórico REST e tempo real WebSocket.
 * - Atualizar o painel técnico de diagnóstico em Shadow DOM.
 * - Bloquear qualquer processamento fora do estado READY.
 *
 * RESTRIÇÃO DE SEGURANÇA:
 * - Modo estritamente observador.
 * - NENHUM cálculo de sinal ou execução de ordens.
 */

import { normalizeWebSocketPayload, normalizeHistoryBars } from "../market/candle-normalizer.js";
import { isValidCandle } from "../market/candle-validator.js";
import { CandleStore } from "../market/candle-store.js";
import { DataQualityTracker, MarketState } from "../market/data-quality.js";
import { QuantPortfolio } from "../strategy/quant-portfolio.js";
import { PortfolioRegistry } from "../strategy/portfolio-registry.js";
import { SignalLifecycle, Phase } from "../strategy/signal-lifecycle.js";
import { ActiveChannel } from "../market/active-channel.js";
import { LIFECYCLE } from "../strategy/lifecycle-config.js";
import { signalAuditor } from "../strategy/signal-auditor.js";
import { signalDeduplicator, DEFAULT_STRATEGY_VERSION } from "../strategy/signal-deduplicator.js";
import { signalStore, getNextGlobalSeq } from "../storage/signal-store.js";
import { intraminuteTracker } from "../market/intraminute-tracker.js";
import { candleTimer } from "../utils/candle-timer.js";
import { marketClock } from "../utils/market-clock.js";
import { logger } from "../utils/logger.js";
import { initBridgeListener } from "./bridge.js";
import { rec, configureFlightRecorder, generateUUID, hashCandles } from "../diagnostics/flight-recorder.js";

/**
 * Extrai o símbolo de um payload heterogêneo de forma abrangente.
 * Suporta pair, symbol, asset, ticker e envelopes messages/data.
 *
 * @param {any} payload
 * @returns {string|null} Símbolo em caixa alta ou null
 */
export const NON_SYMBOL_WORDS = new Set([
  "TICKER", "TRADE", "TRADES", "QUOTES", "QUOTE", "CANDLE", "CANDLES",
  "BARS", "KLINE", "KLINES", "SUB", "UNSUB", "SUBSCRIBE", "UNSUBSCRIBE",
  "PING", "PONG", "SYSTEM", "DEFAULT", "STREAM", "MARKET", "DATA", "DEPTH",
  "ORDERBOOK", "STATUS", "AUTH", "LOGIN", "TOPIC", "CHANNEL", "EVENT",
  "UPDATE", "UPDATES", "SNAPSHOT", "INITIAL", "CONFIG", "ERROR", "RESPONSE",
  "REQUEST", "INFO", "HEARTBEAT", "SERVER", "CLIENT", "MESSAGE", "MESSAGES",
  "B2TRADING", "TRADING", "BROKER"
]);

function cleanSymbolCandidate(str) {
  if (!str || typeof str !== "string") return null;
  const clean = str.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (clean.length >= 3 && !NON_SYMBOL_WORDS.has(clean)) {
    return clean;
  }
  return null;
}

export function extractSymbolFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const directCandidates = [payload.pair, payload.symbol, payload.asset, payload.ticker, payload.s, payload.instrument];
  for (const cand of directCandidates) {
    const sym = cleanSymbolCandidate(cand);
    if (sym) return sym;
  }
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    for (const m of payload.messages) {
      if (!m || typeof m !== "object") continue;
      const cand = m.pair || m.symbol || m.asset || m.ticker || m.data?.pair || m.data?.symbol || m.data?.asset;
      const sym = cleanSymbolCandidate(cand);
      if (sym) return sym;
    }
  }
  if (payload.data && typeof payload.data === "object") {
    const d = payload.data;
    const cand = d.pair || d.symbol || d.asset || d.ticker || d.s;
    const sym = cleanSymbolCandidate(cand);
    if (sym) return sym;
  }
  return null;
}

/**
 * Inspeciona o DOM da corretora para identificar o ativo atualmente aberto no gráfico.
 * Suporta headers do TradingView (.pane-legend-title__container, data-name="legend-source-title"),
 * abas de ativos do Traderoom e título do documento.
 *
 * @returns {string|null} Símbolo em caixa alta ou null
 */
export function detectActiveSymbolFromDOM() {
  if (typeof document === "undefined") return null;
  try {
    // 1. Legend do TradingView (seja no frame local ou no top)
    const legendSelectors = [
      '[data-name="legend-source-title"]',
      '.pane-legend-title__container',
      '.chart-data-window-body',
      'div[class*="pane-legend-title"]',
      'div[class*="legendTitle"]',
    ];
    for (const sel of legendSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent) {
        const text = el.textContent.trim();
        const match = /^([A-Z0-9_]+)/i.exec(text);
        if (match && match[1] && match[1].length >= 3) {
          return match[1].toUpperCase();
        }
      }
    }

    // 2. Abas ativas da corretora (Traderoom)
    const tabSelectors = [
      '[class*="asset-tab"][class*="active"]',
      '[class*="tab"][class*="active"]',
      '[class*="tab"][class*="selected"]',
      '[class*="itemActive"]',
      '[class*="current-asset"]',
    ];
    for (const sel of tabSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent) {
        const text = el.textContent.trim();
        const clean = text.replace(/[\/\s-]+/g, "_").toUpperCase();
        const match = /^([A-Z0-9_]+)/.exec(clean);
        if (match && match[1] && match[1].length >= 3) {
          return match[1];
        }
      }
    }

    // 3. Document title (se o traderoom colocar o par no title)
    if (document.title) {
      const titleMatch = /([A-Z0-9_]{3,}(?:_OTC)?)/i.exec(document.title);
      if (titleMatch && titleMatch[1]) {
        const candidate = titleMatch[1].toUpperCase();
        if (candidate !== "B2TRADING" && candidate !== "TRADING" && candidate !== "BROKER") {
          return candidate;
        }
      }
    }

    // 4. Seletor de iframes com par na URL (?pair=...)
    const iframes = document.querySelectorAll('iframe[src*="pair="]');
    for (const iframe of iframes) {
      const src = iframe.getAttribute("src") || iframe.src || "";
      const match = /[?&]pair=([^&#]+)/i.exec(src);
      if (match && match[1]) {
        const clean = decodeURIComponent(match[1]).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
        if (clean.length >= 3 && clean !== "B2TRADING") {
          return clean;
        }
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Retorna todos os ativos ativos visíveis no DOM (incluindo múltiplos gráficos em iframes).
 * @returns {string[]}
 */
export function detectActiveSymbolsFromDOM() {
  if (typeof document === "undefined") return [];
  const symbols = new Set();
  const primary = detectActiveSymbolFromDOM();
  if (primary) symbols.add(primary);

  try {
    const iframes = document.querySelectorAll('iframe[src*="pair="]');
    for (const iframe of iframes) {
      const src = iframe.getAttribute("src") || iframe.src || "";
      const match = /[?&]pair=([^&#]+)/i.exec(src);
      if (match && match[1]) {
        const clean = decodeURIComponent(match[1]).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
        if (clean.length >= 3 && clean !== "B2TRADING") {
          symbols.add(clean);
        }
      }
    }
  } catch (_) {}
  return Array.from(symbols);
}

export class MarketAnalyzer {
  constructor() {
    this.instanceId = generateUUID();
    this.timeframeSeconds = 60; // Padrão M1
    this.currentSymbol = null;
    this.activeSymbols = new Set();
    this.lastPrices = new Map();
    this._lastLoggedPrices = new Map();
    this.store = new CandleStore({ maxCandlesPerSeries: 500 });
    this.activeChannel = new ActiveChannel();
    this._lastTickReceivedAt = 0;
    this._firstTickAt = 0;
    this._warnedNoChannel = false;
    this._disconnectTimer = null;
    this._scanInterval = null;
    this._unsubBridge = null;
    this._unsubChannel = null;
    this._unsubLifecycle = null;
    this._heartbeatInterval = null;
    this._lastTimerTick = Date.now();
    this._consecutiveSkipMs = 0;
    this._hiddenAt = 0;
    this._syncingBacklog = false;
    this._backlogCount = 0;
    this._backlogStartTs = 0;
    this._onVisibilityChange = null;

    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: "ENSURE_OFFSCREEN" }).catch(() => {});
      } catch (_) {}
    }

    if (typeof document !== "undefined" && document.addEventListener) {
      this._onVisibilityChange = () => {
        const isHidden = Boolean(document.hidden);
        rec("VISIBILITY_CHANGE", {
          hidden: isHidden,
          state: isHidden ? "hidden" : "visible",
          pair: this.currentSymbol,
        });

        if (isHidden) {
          this._hiddenAt = Date.now();
        } else {
          const hiddenDuration = this._hiddenAt ? (Date.now() - this._hiddenAt) : 0;
          this._hiddenAt = 0;
          this.handleFocusRestored(hiddenDuration, "VISIBILITY_CHANGE");
        }
      };
      document.addEventListener("visibilitychange", this._onVisibilityChange);
    }

    if (typeof window !== "undefined") {
      candleTimer.start();
    }
    this.quality = new DataQualityTracker({ staleTimeoutMs: 15000, minHistoryBars: 10 });
    this.intraminuteTracker = intraminuteTracker;

    // Portfólio da Nova Arquitetura Probabilística M1 e Auditor de Sinais
    this.payout = 0.80;
    this.registry = new PortfolioRegistry((pair) => new QuantPortfolio({ payout: this.payout, minEdge: 0.015 }));
    this.signalAuditor = signalAuditor;
    this.deduplicator = signalDeduplicator;
    this.strategyVersion = DEFAULT_STRATEGY_VERSION;
    this.lifecycle = new SignalLifecycle();
    this.lastDecideAt = 0;
    this.lastCachedDecision = null;
    this.decisionsBySymbol = new Map();
    this.lightMetricsBySymbol = new Map();
    this.currentLifecycleSnapshot = null;
    this.panel = null;

    // Rastreamento Multi-Ativo: activeChannel registra canais abertos pelo WebSocket
    this._unsubChannel = this.activeChannel.onChange((next, prev) => {
      rec("CHANNEL_CHANGE", {
        prev: prev ? { pair: prev.pair, tf: prev.tf } : null,
        next: next ? { pair: next.pair, tf: next.tf } : null,
        origem: "WS_CHANNEL_EVENT",
      });
      if (next && next.pair) {
        if (!this.currentSymbol) {
          this.currentSymbol = next.pair;
        }
        this.timeframeSeconds = next.tf || 60;
        this.activeSymbols.add(next.pair);
        logger.setContext({ symbol: this.currentSymbol, tabId: this.tabId });
      }
      this.updatePanelDisplay();
    });

    if (this.activeChannel.onUnsubscribe) {
      this._unsubChannelClose = this.activeChannel.onUnsubscribe((pair) => {
        this.lifecycle.cancelPair(pair, "UNSUBSCRIBED");
        this.activeSymbols.delete(pair);
        if (this.currentSymbol === pair) {
          this.currentSymbol = Array.from(this.activeSymbols)[0] || null;
        }
        this.updatePanelDisplay();
      });
    }

    // Conexão dos Eventos do SignalLifecycle (Único ponto com efeitos colaterais de sinal)
    this._unsubLifecycle = this.lifecycle.onEvent((event, lc) => {
      if (this._isDestroyed) return;
      rec("LIFECYCLE_EVENT", {
        event,
        payload: {
          id: lc.id,
          direction: lc.direction,
          pair: lc.pair,
          phase: lc.phase,
          formingTs: lc.formingTs,
          targetTs: lc.targetTs,
          probability: lc.snapshot?.probability ?? null,
          result: lc.result ?? null,
          reason: lc.reason ?? null,
        },
      });
      if (event === Phase.PRE_SIGNAL) {
        this.signalAuditor.recordSignal({
          id: lc.id,
          action: lc.direction,
          symbol: lc.pair,
          timeframeSeconds: lc.tf,
          candleTimestamp: lc.formingTs,
          targetTimestamp: lc.targetTs,
          probability: lc.snapshot?.probability ?? 0.5,
          conservativeProbability: lc.snapshot?.conservativeProbability ?? lc.snapshot?.probability,
          ev: lc.snapshot?.ev ?? 0,
          edge: lc.snapshot?.edge ?? 0,
          quality: lc.snapshot?.quality ?? 0,
          payout: this.registry.get(lc.pair).payout,
          subStrategy: lc.snapshot?.subStrategy,
          primaryStrategyName: lc.snapshot?.strategyName || lc.snapshot?.subStrategy,
          correlationGroup: lc.snapshot?.correlationGroup,
          reasons: lc.snapshot?.reasons || [],
        });

        logger.success(
          "SINAL",
          `🚀 PRE-SEÑAL M1 [${lc.direction} ${lc.pair} - ${lc.snapshot?.subStrategy || "Quant"}]: Prob: ${((lc.snapshot?.probability || 0.5) * 100).toFixed(1)}% | Entrada no início da próxima vela`
        );
        this.updatePanelDisplay({ immediate: true });
      } else if (event === Phase.ENTRY_NOW) {
        this.signalAuditor.recordSignal({
          id: lc.id,
          action: lc.direction,
          symbol: lc.pair,
          timeframeSeconds: lc.tf,
          candleTimestamp: lc.formingTs,
          targetTimestamp: lc.targetTs,
          probability: lc.snapshot?.probability ?? 0.5,
          conservativeProbability: lc.snapshot?.conservativeProbability ?? lc.snapshot?.probability,
          ev: lc.snapshot?.ev ?? 0,
          edge: lc.snapshot?.edge ?? 0,
          quality: lc.snapshot?.quality ?? 0,
          payout: this.registry.get(lc.pair).payout,
          subStrategy: lc.snapshot?.subStrategy,
          primaryStrategyName: lc.snapshot?.strategyName || lc.snapshot?.subStrategy,
          correlationGroup: lc.snapshot?.correlationGroup,
          reasons: lc.snapshot?.reasons || [],
        });
        logger.success(
          "SINAL",
          `⚡ ENTRA AHORA [${lc.direction} ${lc.pair}]: Apertura confirmada | Ejecute en el broker inmediatamente`
        );
        this.updatePanelDisplay({ immediate: true });
      } else if (event === Phase.IN_TRADE) {
        const entryStr = Number.isFinite(lc.entryPrice) ? Number(lc.entryPrice).toFixed(5) : "---";
        logger.info(
          "SINAL",
          `⏳ EN OPERACIÓN [${lc.direction} ${lc.pair}]: Entrada ${entryStr} | Aguardando expiración de la vela`
        );
        this.updatePanelDisplay({ immediate: true });
      } else if (event === Phase.SETTLED) {
        this.signalAuditor.settle(lc.id, {
          result: lc.result,
          entryPrice: lc.entryPrice,
          closePrice: lc.closePrice,
        });
        if (lc.result === "WIN" || lc.result === "LOSS") {
          this.registry.get(lc.pair).recordOutcome(lc.snapshot, lc.result === "WIN");
        }
        const stats = this.signalAuditor.getStats();
        const payout = this.registry.get(lc.pair).payout || 0.80;
        const pnlStr = lc.result === "WIN" ? `+${payout.toFixed(2)}` : lc.result === "LOSS" ? "-1.00" : "0.00";
        const entryStr = Number.isFinite(lc.entryPrice) ? Number(lc.entryPrice).toFixed(5) : "---";
        const closeStr = Number.isFinite(lc.closePrice) ? Number(lc.closePrice).toFixed(5) : "---";

        if (lc.result === "WIN") {
          logger.success(
            "SINAL",
            `✓ RESULTADO [${lc.direction} ${lc.pair}]: WIN (${pnlStr} un) | ${entryStr} → ${closeStr} | WR: ${stats.winRate}% (${stats.wins}V/${stats.losses}D)`
          );
        } else if (lc.result === "LOSS") {
          logger.error(
            "SINAL",
            `✗ RESULTADO [${lc.direction} ${lc.pair}]: LOSS (${pnlStr} un) | ${entryStr} → ${closeStr} | WR: ${stats.winRate}% (${stats.wins}V/${stats.losses}D)`
          );
        } else {
          logger.info("SINAL", `― RESULTADO [${lc.direction} ${lc.pair}]: DOJI (Empate) | ${entryStr} → ${closeStr}`);
        }
        this.updatePanelDisplay({ immediate: true });
      } else if (event === Phase.CANCELLED) {
        this.signalAuditor.cancel(lc.id, lc.reason);
        this.updatePanelDisplay({ immediate: true });
      }
    });

    this.quantReport = {
      action: "WAIT",
      label: "Esperando canal del gráfico…",
      probability: 0.50,
      ev: 0,
      edge: 0,
      quality: 0,
      strategiesResults: [],
      individualSignals: [],
      confluence: null,
      isConfluence: false,
      isDivergent: false,
      reasons: ["Esperando canal del gráfico…"],
    };

    this.currentSignal = {
      action: "WAIT",
      label: "Esperando canal del gráfico…",
      indicators: {},
      reasons: ["Esperando canal del gráfico…"],
    };

    this.socketStatus = "desconectado";
    this.lastPrice = "---";
    this._lastLoggedPrice = null;
    this._lastState = null;
    this._lastSigKey = null;

    this.tabId = null;
    this.windowId = null;

    // Métricas de performance e escrita no storage (P-01, P-02, Etapa 8)
    this._evalDurations = [];
    this._windowEvalsCount = 0;
    this._closedCandleEvalsCount = 0;
    this._statePublicationsCount = 0;
    this._storageWritesCount = 0;
    this._costBySymbol = new Map();
    this._lastPersistedDigest = null;
    this._lastHeartbeatWriteTime = 0;
    this._lastPerfLogTime = Date.now();
    this._lastLightMetricsAt = 0;
    this._cachedLightMetrics = null;

    configureFlightRecorder({
      ctx: "content",
      instanceId: this.instanceId,
      windowId: this.windowId,
      tabId: this.tabId,
    });

    this.init();

    const host = typeof window !== "undefined" ? window.location.hostname : "local";
    rec("ANALYZER_NEW", {
      instanceId: this.instanceId,
      host,
      isComputeFrame: isComputeFrame(host),
      symbol: this.currentSymbol,
      activeTabId: this.tabId,
      windowId: this.windowId,
    });
  }

  init() {
    // 0. Identifica a aba e janela atuais via Background Service Worker (com retry defensivo)
    const fetchTabInfo = (retry = true) => {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
          chrome.runtime.sendMessage({ type: "ORACLE_GET_TAB_INFO" }, (info) => {
            if (chrome.runtime?.lastError) {
              if (retry) {
                setTimeout(() => fetchTabInfo(false), 350);
              }
              return;
            }
            if (info) {
              this.tabId = info.tabId || null;
              this.windowId = info.windowId || null;
              configureFlightRecorder({
                ctx: "content",
                instanceId: this.instanceId,
                windowId: this.windowId,
                tabId: this.tabId,
              });
              if (this.tabId) {
                this.signalAuditor.setTabId(this.tabId);
                this._claimCompute();
              }
              logger.setContext({ tabId: this.tabId, symbol: this.currentSymbol });
              this.updatePanelDisplay({ immediate: true });
            }
          });
        } catch (_) {}
      }
    };
    fetchTabInfo();

    // 1. Escuta eventos da Bridge (com canal)
    this._unsubBridge = initBridgeListener({
      onMarketEvent: (event) => this.handleMarketEvent(event),
      onSocketStatus: (info) => this.handleSocketStatus(info),
      onChannel: (ch) => this.activeChannel.onChannel(ch),
      onAccessoryStatus: ({ url, status }) => {
        logger.info("ACCESSORY_ENDPOINT", `Status de endpoint acessório (${status}) em ${url}`, {
          isAccessory: true,
          url,
          status,
          tabId: this.tabId,
        });
      },
    });

    // 1.1 Responde a pings de diagnóstico do MAIN world (oracleDebug.status())
    if (typeof window !== "undefined") {
      this._onDebugPing = (e) => {
        if (e.data?.type === "ORACLE_DEBUG_PING") {
          const rep = this.currentSymbol ? this.quality.getReport(this.currentSymbol, this.timeframeSeconds) : null;
          const snapshot = {
            instanceId: this.instanceId,
            status: rep?.state || "BOOTING",
            currentSymbol: this.currentSymbol,
            activeSymbols: Array.from(this.activeSymbols),
            candleCounts: Object.fromEntries(
              Array.from(this.activeSymbols).map((s) => [s, this.store.getCandles(s, this.timeframeSeconds).length])
            ),
            lastPrices: Object.fromEntries(this.lastPrices),
            storageWrites: this._storageWritesCount,
            signalsCount: this.signalAuditor.getSignals().length,
            lifecycleSnapshot: this.currentLifecycleSnapshot,
          };
          window.postMessage({ type: "ORACLE_DEBUG_PONG", snapshot }, "*");
        }
      };
      window.addEventListener("message", this._onDebugPing);
    }

    // 2. Verificação periódica de Heartbeat / Stale feed a cada 2.5s e loop contínuo do SignalLifecycle
    if (typeof window !== "undefined") {
      this._staleInterval = setInterval(() => {
        if (this._isDestroyed) return;
        if (this.currentSymbol) {
          this.quality.checkStale(this.currentSymbol, this.timeframeSeconds);
        }
      }, 2500);

      this._lifecycleInterval = setInterval(() => {
        if (this._isDestroyed) return;
        const now = Date.now();
        const elapsed = this._lastTimerTick ? (now - this._lastTimerTick) : 0;
        this._lastTimerTick = now;

        if (elapsed > 2000) {
          this._consecutiveSkipMs += elapsed;
          rec("TIMER_SKIP", {
            elapsedMs: elapsed,
            delayMs: elapsed - 250,
            consecutiveDelayMs: this._consecutiveSkipMs,
            par: this.currentSymbol,
          });

          if (this._consecutiveSkipMs >= 10000) {
            rec("THROTTLED_PERIOD", {
              durationMs: this._consecutiveSkipMs,
              from: now - this._consecutiveSkipMs,
              to: now,
              par: this.currentSymbol,
            });
            this._consecutiveSkipMs = 0;
          }
        } else {
          this._consecutiveSkipMs = 0;
        }

        this.tickLifecycle();
      }, 250);

      this._perfInterval = setInterval(() => {
        if (this._isDestroyed) return;
        this._logPerfMetrics();
      }, 60000);
    }

    // 3. Listener seguro para alteração de payout e vinculação de janela via Background/Side Panel (I-01, I-05)
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender) => {
        if (this._isDestroyed) return;
        if (sender && sender.id !== chrome.runtime.id) return;
        if (msg && msg.type === "ORACLE_TAB_ATTACHED" && msg.windowId) {
          this.windowId = msg.windowId;
          this.updatePanelDisplay({ immediate: true });
        }
        if (msg && msg.type === "ORACLE_SET_PAYOUT" && msg.payout) {
          this.payout = msg.payout;
          this.registry.setGlobalPayout(msg.payout);
          this.updatePanelDisplay({ immediate: true });
        }
        if (msg && msg.type === "OFFSCREEN_HEARTBEAT") {
          this.handleOffscreenHeartbeat(msg);
        }
        if (msg && msg.type === "ORACLE_IDLE_STATE_CHANGE") {
          this.handleIdleStateChange(msg.state);
        }
        if (msg && msg.type === "ORACLE_SELECT_SYMBOL" && msg.symbol) {
          this.selectSymbol(msg.symbol);
        }
      });
    }

    // 4. Detecção passiva de clique em gráficos no Traderoom (foco multi-gráfico automático)
    if (typeof document !== "undefined" && document.addEventListener) {
      this._onDomClick = (e) => {
        if (this._isDestroyed) return;
        try {
          const target = e.target;
          if (!target) return;
          const chartOrTab = target.closest('[data-symbol], [class*="pane-legend"], [class*="asset-tab"], [class*="chart-container"], [class*="tv-chart"]');
          if (chartOrTab) {
            const symFromAttr = chartOrTab.getAttribute("data-symbol");
            const symFromText = chartOrTab.textContent ? /^([A-Z0-9_]{3,})/i.exec(chartOrTab.textContent.trim())?.[1] : null;
            const foundSym = (symFromAttr || symFromText || "").toUpperCase();
            if (foundSym && this.activeSymbols.has(foundSym) && foundSym !== this.currentSymbol) {
              this.selectSymbol(foundSym);
            }
          }
        } catch (_) {}
      };
      document.addEventListener("click", this._onDomClick, { passive: true });
    }

    // 5. Escaneamento contínuo de iframes para descoberta multi-gráfico
    this._scanIframesForPairs();
    if (typeof window !== "undefined") {
      this._scanInterval = setInterval(() => {
        if (this._isDestroyed) return;
        this._scanIframesForPairs();
      }, 3000);
    }

    const host = typeof window !== "undefined" ? window.location.hostname : "local";
    logger.info("SISTEMA", `Analyzer ativo em frame de cálculo (${host})`);
  }

  _scanIframesForPairs() {
    if (typeof document === "undefined") return [];
    const discovered = [];
    try {
      const iframes = document.querySelectorAll("iframe");
      iframes.forEach((iframe) => {
        try {
          const src = iframe.getAttribute("src") || iframe.src || "";
          if (src && src.includes("pair=")) {
            const match = /[?&]pair=([^&#]+)/i.exec(src);
            if (match && match[1]) {
              const pair = decodeURIComponent(match[1]).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
              if (pair && pair.length >= 3 && pair !== "B2TRADING") {
                discovered.push(pair);
                this.activeSymbols.add(pair);
                if (!this.activeChannel.hasPair(pair)) {
                  this.activeChannel.onChannel({
                    type: "ORACLE_CHANNEL",
                    action: "subscribe",
                    pair,
                    tf: 60,
                    at: Date.now(),
                  });
                }
              }
            }
          }
        } catch (_) {}
      });
    } catch (_) {}
    if (discovered.length > 0 && !this.currentSymbol) {
      this.selectSymbol(discovered[0]);
    }
    return discovered;
  }

  selectSymbol(symbol) {
    if (!symbol) return;
    const clean = String(symbol).trim().toUpperCase();
    this.currentSymbol = clean;
    this.activeSymbols.add(clean);
    logger.setContext({ symbol: this.currentSymbol, tabId: this.tabId });
    this.updatePanelDisplay({ immediate: true });
  }

  _claimCompute() {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage || !this.tabId) return;

    chrome.runtime.sendMessage({ type: "CLAIM_COMPUTE", tabId: this.tabId }, (response) => {
      rec("CLAIM_RESULT", {
        granted: Boolean(response?.granted),
        holder: response?.frameId ?? null,
      });
      if (chrome.runtime?.lastError || !response || response.granted === false) {
        logger.warn("SISTEMA", `Instância de cálculo recusada para a aba ${this.tabId} (DENIED). Outro frame ativo.`);
        this.destroy("CLAIM_DENIED");
        return;
      }

      if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = setInterval(() => {
        if (this._isDestroyed) return;
        chrome.runtime.sendMessage({ type: "COMPUTE_HEARTBEAT", tabId: this.tabId }, (hbRes) => {
          if (hbRes && hbRes.ok === false) {
            logger.warn("SISTEMA", "Heartbeat recusado. Perdida posse de cálculo.");
            this.destroy("HEARTBEAT_LOST");
          }
        });
      }, 2000);
    });
  }

  destroy(reason = "NORMAL") {
    rec("ANALYZER_DESTROY", { reason });
    this._isDestroyed = true;
    if (this._unsubBridge) {
      try { this._unsubBridge(); } catch (_) {}
      this._unsubBridge = null;
    }
    if (this._unsubChannel) {
      try { this._unsubChannel(); } catch (_) {}
      this._unsubChannel = null;
    }
    if (this._unsubChannelClose) {
      try { this._unsubChannelClose(); } catch (_) {}
      this._unsubChannelClose = null;
    }
    if (this._unsubLifecycle) {
      try { this._unsubLifecycle(); } catch (_) {}
      this._unsubLifecycle = null;
    }
    if (this._onDomClick && typeof document !== "undefined" && document.removeEventListener) {
      try { document.removeEventListener("click", this._onDomClick); } catch (_) {}
      this._onDomClick = null;
    }
    if (this._staleInterval) clearInterval(this._staleInterval);
    if (this._lifecycleInterval) clearInterval(this._lifecycleInterval);
    if (this._perfInterval) clearInterval(this._perfInterval);
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    if (this._scanInterval) clearInterval(this._scanInterval);
    if (this._pendingStateSaveTimeout) clearTimeout(this._pendingStateSaveTimeout);
    if (this._disconnectTimer) clearTimeout(this._disconnectTimer);

    if (this._onVisibilityChange && typeof document !== "undefined" && document.removeEventListener) {
      try {
        document.removeEventListener("visibilitychange", this._onVisibilityChange);
      } catch (_) {}
      this._onVisibilityChange = null;
    }

    if (this._onDebugPing && typeof window !== "undefined" && window.removeEventListener) {
      try {
        window.removeEventListener("message", this._onDebugPing);
      } catch (_) {}
      this._onDebugPing = null;
    }

    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage && this.tabId) {
      try {
        chrome.runtime.sendMessage({ type: "RELEASE_COMPUTE", tabId: this.tabId });
      } catch (_) {}
    }
  }

  handleOffscreenHeartbeat(msg) {
    if (this._isDestroyed) return;
    const nowSec = msg?.nowSec || Math.floor(Date.now() / 1000);
    this.tickLifecycle({ nowSec });
  }

  handleIdleStateChange(state) {
    if (this._isDestroyed) return;
    rec("IDLE_CHANGE", { state, pair: this.currentSymbol });
    if (state === "active") {
      this.handleFocusRestored(0, "IDLE_ACTIVE");
    }
  }

  handleFocusRestored(hiddenDurationMs = 0, trigger = "VISIBILITY_VISIBLE") {
    if (this._isDestroyed) return;
    const pair = this.currentSymbol;
    const tf = this.timeframeSeconds;
    rec("FOCUS_RESTORED", {
      trigger,
      pair,
      tf,
      hiddenDurationMs,
    });

    if (pair) {
      this._syncingBacklog = true;
      this._backlogCount = 0;
      this._backlogStartTs = Date.now();
      this.quality.setSyncingRealtime(pair, tf, trigger);
      this.updatePanelDisplay();
    }
  }

  _recordEvalDuration(ms, symbol = null, isWindow = false) {
    if (Number.isFinite(ms)) {
      this._evalDurations.push(ms);
      if (isWindow) {
        this._windowEvalsCount = (this._windowEvalsCount || 0) + 1;
      } else {
        this._closedCandleEvalsCount = (this._closedCandleEvalsCount || 0) + 1;
      }
      if (symbol) {
        const entry = this._costBySymbol.get(symbol) || { totalMs: 0, count: 0, lastMs: 0 };
        entry.totalMs += ms;
        entry.count += 1;
        entry.lastMs = ms;
        this._costBySymbol.set(symbol, entry);
      }
    }
  }

  _logPerfMetrics() {
    const count = this._evalDurations.length;
    const avgMs = count > 0
      ? (this._evalDurations.reduce((a, b) => a + b, 0) / count).toFixed(2)
      : "0.00";
    const writes = this._storageWritesCount;
    const publications = this._statePublicationsCount || 0;
    const windowEvals = this._windowEvalsCount || 0;
    const closedEvals = this._closedCandleEvalsCount || 0;

    let costSummary = "[]";
    if (this._costBySymbol && this._costBySymbol.size > 0) {
      const parts = [];
      for (const [sym, c] of this._costBySymbol.entries()) {
        const avg = (c.totalMs / Math.max(1, c.count)).toFixed(1);
        parts.push(`${sym}: ${avg}ms (${c.count}x)`);
      }
      costSummary = `[${parts.join(", ")}]`;
    }

    logger.info(
      "PERF",
      `[Métricas 60s] evaluate() médio: ${avgMs}ms (${count} execuções: ${windowEvals} janela 45-57s, ${closedEvals} vela fechada) | Publicações: ${publications} | Escritas storage: ${writes}/min (meta: <= 240/min) | Custo/ativo: ${costSummary}`
    );

    this._evalDurations = [];
    this._windowEvalsCount = 0;
    this._closedCandleEvalsCount = 0;
    this._statePublicationsCount = 0;
    this._storageWritesCount = 0;
    this._costBySymbol.clear();
    this._lastPerfLogTime = Date.now();
  }

  /**
   * Executa um ciclo de vida de sinal controlado por tempo e qualidade de dados.
   *
   * @param {Object} [options={}]
   * @param {number} [options.nowSec=null]
   * @param {Function} [options.decide=null]
   * @param {boolean} [options.dataOk=null]
   * @returns {Object} Snapshot do lifecycle
   */
  tickLifecycle({ nowSec = null, decide = null, dataOk = null } = {}) {
    if (this._isDestroyed) return null;

    const currentNowSec = nowSec ?? marketClock.nowSec();
    const active = this.activeChannel.get();
    const mainPair = active?.pair || this.currentSymbol;
    const tf = active?.tf || this.timeframeSeconds;

    const symbolsToStep = new Set(this.activeSymbols);
    if (mainPair) symbolsToStep.add(mainPair);

    if (symbolsToStep.size === 0) {
      this.currentLifecycleSnapshot = { status: "WAITING_CHANNEL", pair: null, tf };
      return this.currentLifecycleSnapshot;
    }

    let mainSnapshot = null;

    for (const pair of symbolsToStep) {
      if (tf !== LIFECYCLE.SUPPORTED_TF_SEC) {
        continue;
      }

      let currentDataOk = dataOk;
      if (currentDataOk === null) {
        const report = this.quality.getReport(pair, tf);
        const isReady = this.store.isReady(pair, tf);
        currentDataOk = isReady && report.state === MarketState.READY;
      }

      const prevPhase = (pair === this.currentSymbol && this.currentLifecycleSnapshot)
        ? (this.currentLifecycleSnapshot?.trade?.phase || this.currentLifecycleSnapshot?.current?.phase || "SCANNING")
        : "SCANNING";

      const decideFn = decide ?? (() => {
        const secInCandle = Math.floor(currentNowSec % 60);
        // Avalia apenas dentro da janela de decisão (45s a 57s)
        if (secInCandle < (this.lifecycle?.cfg?.DECISION_START_SEC ?? 45) ||
            secInCandle > (this.lifecycle?.cfg?.DECISION_END_SEC ?? 57)) {
          return null;
        }

        const candles = this.store.getCandles(pair, tf, 150);
        if (!candles || candles.length < 15) return null;

        const microMetrics = this.intraminuteTracker ? this.intraminuteTracker.getCurrentMetrics(pair, tf) : null;
        const report = this.quality ? this.quality.getReport(pair, tf) : { state: MarketState.READY };
        const isReady = this.store.isReady(pair, tf);
        const dataState = (isReady && report.state === MarketState.READY) ? "READY" : (report.state || "NOT_READY");
        if (!["READY", "CANDLE_CLOSED"].includes(dataState)) return null;

        const strat = this.registry.get(pair);
        if (!strat || typeof strat.evaluate !== "function") return null;

        const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        const decision = strat.evaluate({
          symbol: pair,
          timeframeSeconds: tf,
          candles,
          microMetrics,
          isReady: true,
          dataState,
          gapCount: 0,
          isStale: false,
        });
        const dur = ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0;
        this._recordEvalDuration(dur, pair, true);

        if (decision && (decision.action === "CALL" || decision.action === "PUT" || decision.action === "BUY" || decision.action === "SELL")) {
          const action = decision.action === "BUY" ? "CALL" : decision.action === "SELL" ? "PUT" : decision.action;
          const normalizedDecision = { ...decision, action, symbol: pair };
          this.decisionsBySymbol.set(pair, normalizedDecision);
          if (pair === this.currentSymbol) {
            this.lastCachedDecision = normalizedDecision;
          }

          // Se a decisão não for acionável (SHADOW, falta de confluência ou conflito), NÃO emite PRE_SIGNAL!
          if (decision.isActionable === false || decision.action === "WAIT") {
            rec("DECISION_NOT_ACTIONABLE", {
              pair,
              action,
              subStrategy: decision.subStrategy || decision.strategyName,
              reasons: decision.reasons,
              isActionable: decision.isActionable,
            });
            return null;
          }

          // Filtro Anti-Flip na virada consecutiva de vela:
          // Se na vela anterior foi emitido sinal na direção oposta (delta <= 120s),
          // exige CONFLUÊNCIA comprovada (2+ famílias) para permitir a virada rápida.
          if (!this._lastEmittedDirectionBySymbol) this._lastEmittedDirectionBySymbol = new Map();
          if (!this._lastEmittedTsBySymbol) this._lastEmittedTsBySymbol = new Map();
          const lastOpposite = this._lastEmittedDirectionBySymbol.get(pair);
          const lastOppositeTs = this._lastEmittedTsBySymbol.get(pair) || 0;
          if (lastOpposite && lastOpposite !== action && (currentNowSec - lastOppositeTs <= 120)) {
            if (!decision.isConfluence && (decision.confluentCount || 0) < 2) {
              rec("REVERSAL_VETO_UNCONFIRMED", { pair, action, prevAction: lastOpposite, deltaTs: currentNowSec - lastOppositeTs });
              logger.info("SINAL", `⚠️ Inversão imediata de [${lastOpposite} ➔ ${action}] em ${pair} vetada: exige confluência de 2+ famílias independentes.`);
              return null;
            }
          }

          this._lastEmittedDirectionBySymbol.set(pair, action);
          this._lastEmittedTsBySymbol.set(pair, currentNowSec);

          return normalizedDecision;
        }
        return null;
      });

      const snapshot = this.lifecycle.step({
        pair,
        tf,
        nowSec: currentNowSec,
        dataOk: currentDataOk,
        decide: decideFn,
      });

      if (pair === this.currentSymbol || !mainSnapshot) {
        mainSnapshot = snapshot;
        const nextPhase = snapshot?.trade?.phase || snapshot?.current?.phase || "SCANNING";
        const secInCandle = Math.floor(currentNowSec % 60);
        rec("LIFECYCLE_STEP", {
          par: pair,
          targetTs: snapshot?.targetTs || snapshot?.current?.targetTs || snapshot?.trade?.targetTs || null,
          secondInCandle: secInCandle,
          phaseBefore: prevPhase,
          phaseAfter: nextPhase,
          direction: snapshot?.current?.direction || snapshot?.trade?.direction || null,
          dataOk: currentDataOk,
          remaining: 60 - secInCandle,
        });
      }
    }

    this.currentLifecycleSnapshot = mainSnapshot;
    return mainSnapshot;
  }

  handleSocketStatus(info) {
    if (this._isDestroyed) return;
    if (info.status === "connected") {
      if (this._disconnectTimer) {
        clearTimeout(this._disconnectTimer);
        this._disconnectTimer = null;
      }
      this.socketStatus = "conectado";
      logger.success("WS", "WebSocket conectado ao stream de mercado (wss://ws.b2trading.io/ws)");
      this.updatePanelDisplay();
    } else if (info.status === "closed") {
      // Se recebemos ticks nos últimos 5 segundos, concede janela de carência de 4s
      // antes de rebaixar a qualidade para STALE / RECONNECTING (evita oscilação de reconexão transitória)
      const recentTicks = Date.now() - (this._lastTickReceivedAt || 0) < 5000;
      if (recentTicks) {
        if (!this._disconnectTimer) {
          this._disconnectTimer = setTimeout(() => {
            this._disconnectTimer = null;
            this.socketStatus = "desconectado";
            logger.warn("WS", "Conexão WebSocket encerrada. Aguardando reconexão...");
            if (this.currentSymbol) {
              this.quality.onDisconnect(this.currentSymbol, this.timeframeSeconds);
            }
            this.updatePanelDisplay();
          }, 4000);
        }
      } else {
        this.socketStatus = "desconectado";
        logger.warn("WS", "Conexão WebSocket encerrada. Aguardando reconexão...");
        if (this.currentSymbol) {
          this.quality.onDisconnect(this.currentSymbol, this.timeframeSeconds);
        }
        this.updatePanelDisplay();
      }
    }
  }

  handleMarketEvent(event) {
    if (this._isDestroyed) return;
    if (!event || !event.payload) return;

    if (event.sourceType === "history") {
      if (event.meta?.pair) {
        this.activeChannel.onHistory(event.meta.pair, event.meta.tf || 60);
      }
      this.processHistoryPayload(event.payload, event.meta);
    } else {
      if (event.meta?.pair && !this.activeChannel.hasPair(event.meta.pair)) {
        this.activeChannel.onChannel({
          type: "ORACLE_CHANNEL",
          action: "subscribe",
          pair: event.meta.pair,
          tf: event.meta.tf || 60,
          at: Date.now(),
        });
      }
      this.processRealtimePayload(event.payload, event.meta);
    }
  }

  processHistoryPayload(payload, meta = null) {
    if (this._isDestroyed) return;
    const active = this.activeChannel.get();
    const activePair = active?.pair || null;
    const targetTf = meta?.tf || active?.tf || this.timeframeSeconds || 60;

    const fallbackPair = meta?.pair || activePair || "UNKNOWN";
    const bars = normalizeHistoryBars(payload, fallbackPair, targetTf);
    if (!bars || bars.length === 0) return;

    // Guarda os candles no store por símbolo (aquecimento de watchlist)
    this.store.ingestBatch(bars);

    // Se NÃO há canal ativo ou se o histórico for de outro par: encerra sem mexer no lifecycle ou currentSymbol
    if (!activePair) {
      this.updatePanelDisplay();
      return;
    }

    const detectedSym = bars[0].symbol;
    if (detectedSym !== activePair) {
      return;
    }

    this.quality.onHistoryLoaded(activePair, targetTf, bars.length);
    const last = this.store.getLast(activePair, targetTf);
    if (last) {
      this.lastPrice = last.close.toFixed(5);
    }

    logger.info("HISTÓRICO", `${bars.length} candles carregados para ${activePair} (${targetTf}s)`);
    this.updatePanelDisplay();
  }

  async processRealtimePayload(payload, meta = null) {
    if (this._isDestroyed) return;
    this._lastTickReceivedAt = Date.now();
    if (!this._firstTickAt) {
      this._firstTickAt = Date.now();
    }

    if (this._disconnectTimer) {
      clearTimeout(this._disconnectTimer);
      this._disconnectTimer = null;
    }
    if (this.socketStatus !== "conectado") {
      this.socketStatus = "conectado";
    }

    const active = this.activeChannel.get();
    const activePair = active?.pair || null;
    const activeTf = meta?.tf || active?.tf || this.timeframeSeconds || 60;

    // Se o canal não chegar em 20s após o primeiro tick e nenhum símbolo foi adotado, log WARN
    if (!activePair && !this.currentSymbol && !this._warnedNoChannel && (Date.now() - this._firstTickAt >= 20000)) {
      this._warnedNoChannel = true;
      logger.warn("CANAL", "canal subscribe não capturado");
    }

    const extractedSym = extractSymbolFromPayload(payload);
    const incomingSym = extractedSym || meta?.pair || activePair || this.currentSymbol || "";

    const candles = normalizeWebSocketPayload(payload, activeTf, { symbol: incomingSym });
    if (!candles || candles.length === 0) return;

    for (const candle of candles) {
      if (!isValidCandle(candle)) {
        logger.warn("FEED", `Candle inválido rejeitado: [${candle?.symbol || incomingSym}]`);
        continue;
      }

      const candleSym = candle.symbol || incomingSym;
      if (!candleSym) continue;

      // Idempotência contra backlog de ticks (R2):
      // Ticks com timestamp <= último candle fechado+frozen são IGNORADOS
      const lastFrozen = this.store.getLastFrozen(candleSym, activeTf);
      if (lastFrozen && candle.timestamp <= lastFrozen.timestamp) {
        rec("TICK_REJECTED_BACKLOG", {
          par: candleSym,
          ts: candle.timestamp,
          lastFrozenTs: lastFrozen.timestamp,
          reason: "BELOW_OR_EQUAL_LAST_FROZEN",
        });
        continue;
      }

      // Guarda os candles no store (por símbolo para aquecer)
      const result = this.store.ingest(candle);

      rec("CANDLE_INGEST", {
        par: candleSym,
        tf: activeTf,
        ts: candle.timestamp,
        closed: candle.closed,
        storeStatus: result.status,
        o: candle.open,
        h: candle.high,
        l: candle.low,
        c: candle.close,
      });

      if (result.status === "OUT_OF_ORDER") {
        rec("TICK_REJECTED_BACKLOG", {
          par: candleSym,
          ts: candle.timestamp,
          lastFrozenTs: lastFrozen?.timestamp ?? null,
          reason: "OUT_OF_ORDER_STORE",
        });
        continue;
      }

      let isSubscribed = Boolean(this.activeChannel.hasPair(candleSym) || (activePair === candleSym));
      if (!isSubscribed && meta?.pair && meta.pair === candleSym) {
        this.activeChannel.onChannel({
          type: "ORACLE_CHANNEL",
          action: "subscribe",
          pair: candleSym,
          tf: activeTf,
          at: Date.now(),
        });
        isSubscribed = true;
      }
      if (!isSubscribed) {
        const domSymbols = detectActiveSymbolsFromDOM();
        if (domSymbols.includes(candleSym)) {
          this.activeChannel.onChannel({
            type: "ORACLE_CHANNEL",
            action: "subscribe",
            pair: candleSym,
            tf: activeTf,
            at: Date.now(),
          });
          isSubscribed = true;
        }
      }
      if (!isSubscribed) {
        // Ticks de watchlist/background sem canal aberto: apenas armazenados no store para warm-up
        continue;
      }

      this.activeSymbols.add(candleSym);
      if (!this.currentSymbol) {
        this.currentSymbol = candleSym;
        logger.setContext({ symbol: this.currentSymbol, tabId: this.tabId });
      }

      if (this._syncingBacklog && candleSym === this.currentSymbol) {
        this._backlogCount++;
        const currentSec = marketClock.nowSec();
        const candleAge = currentSec - candle.timestamp;
        if (candleAge <= 65) {
          const delayMs = Date.now() - this._backlogStartTs;
          rec("BACKLOG_PROCESS", {
            count: this._backlogCount,
            delayMs,
            symbol: this.currentSymbol,
          });
          this._syncingBacklog = false;
          this._backlogCount = 0;
        }
      }

      // Se o timeframe ativo não for M1 (60s), não gera sinal
      if (activeTf !== LIFECYCLE.SUPPORTED_TF_SEC) {
        this.currentLifecycleSnapshot = { status: "TF_NOT_SUPPORTED", pair: candleSym, tf: activeTf };
        continue;
      }

      // 1. Registra tick no IntraminuteTracker
      this.intraminuteTracker.recordTick(
        candleSym,
        activeTf,
        candle.close,
        candle.timestamp,
        candle.receivedAt
      );

      this.quality.onRealtimeUpdate(candleSym, activeTf, result);

      this.tickLifecycle();

      const priceStr = candle.close.toFixed(5);
      this.lastPrices.set(candleSym, priceStr);
      if (candleSym === this.currentSymbol) {
        this.lastPrice = priceStr;
      }

      if (result.status === "NEW_CANDLE") {
        rec("CANDLE_OPEN", { symbol: candleSym, ts: candle.timestamp });

        if (activeTf === 60) {
          marketClock.observeCandleOpen(candle.timestamp, candle.receivedAt);
          this.lifecycle.onCandleOpen(candleSym, activeTf, candle.timestamp, candle.open);
        }
        logger.success(
          "STORE",
          `Nova vela aberta em ${candleSym}. Fechamento anterior: ${result.closedCandle?.close?.toFixed(5)}`
        );

        if (result.closedCandle) {
          rec("CANDLE_CLOSE", { symbol: candleSym, ts: result.closedCandle.timestamp });
          this.lifecycle.onCandleClose(candleSym, activeTf, result.closedCandle);
          const closedSeries = this.store.getCandles(candleSym, activeTf, 150);
          this.registry.get(candleSym).observeClosedCandle(closedSeries);
        }

        const closedSeries = this.store.getCandles(candleSym, activeTf, 150);
        const settled = this.signalAuditor.auditPendingSignals(closedSeries);
        for (const s of settled) {
          const stats = this.signalAuditor.getStats();
          if (s.result === "WIN") {
            logger.success(
              "SINAL",
              `✓ RESULTADO [${s.direction} ${s.symbol}]: WIN (+${s.pnlUnits} un) | WR: ${stats.winRate}% (${stats.wins}V/${stats.losses}D)`
            );
          } else if (s.result === "LOSS") {
            logger.error(
              "SINAL",
              `✗ RESULTADO [${s.direction} ${s.symbol}]: LOSS (${s.pnlUnits} un) | WR: ${stats.winRate}% (${stats.wins}V/${stats.losses}D)`
            );
          } else {
            logger.info("SINAL", `― RESULTADO [${s.direction} ${s.symbol}]: DOJI (Empate)`);
          }
        }
        // GATILHO ÚNICO DE DECISÃO: somente com candle fechado e dataState READY/CANDLE_CLOSED
        await this._evaluateOnClosedCandle(candleSym, activeTf, result.closedCandle, candle);
      } else if (result.status === "DATA_GAP") {
        logger.warn("ESTADO", `Gap detectado em ${candleSym}: de ${result.gapFrom} até ${result.gapTo}`);
      } else if (result.status === "UPDATED" || result.status === "INITIALIZED") {
        rec("DECIDE_BLOCKED", {
          par: candleSym,
          ts: candle.timestamp,
          closed: false,
          reason: "INTRABAR_TICK",
        });
        if (this._lastLoggedPrices.get(candleSym) !== priceStr) {
          this._lastLoggedPrices.set(candleSym, priceStr);
          logger.info("FEED", `${candleSym} tick: ${priceStr} (máx: ${candle.high.toFixed(5)}, mín: ${candle.low.toFixed(5)})`);
        }
      }
    }

    this.updatePanelDisplay();
  }

  async _evaluateOnClosedCandle(pair, tf, closedCandle, newCandle) {
    if (this._isDestroyed) return;

    const qReport = this.quality.getReport(pair, tf);
    const isReady = this.store.isReady(pair, tf);
    const dataState = (isReady && qReport.state === MarketState.READY) ? "READY" : (qReport.state || "NOT_READY");

    // 1. Guarda: candle deve existir e estar fechado
    if (!closedCandle?.closed) {
      rec("DECIDE_BLOCKED", {
        par: pair,
        ts: closedCandle?.timestamp ?? null,
        closed: false,
        dataState,
        reason: "CANDLE_NOT_CLOSED",
      });
      return;
    }

    // 1b. Guarda R3: candle já congelado bloqueia avaliação (evita repinte tardio)
    if (closedCandle?.frozen === true) {
      this._logFlight("EVALUATE_BLOCKED_FROZEN", {
        pair,
        tf,
        candleTimestamp: closedCandle.timestamp,
        reason: "CANDLE_JA_CONGELADO",
      });
      return;
    }

    // 1c. Guarda: dataState READY ou CANDLE_CLOSED
    if (!["READY", "CANDLE_CLOSED"].includes(dataState)) {
      rec("DECIDE_BLOCKED", {
        par: pair,
        ts: closedCandle.timestamp,
        closed: true,
        dataState,
        reason: `INVALID_DATA_STATE_${dataState}`,
      });
      return;
    }

    // 2. Chave canônica de deduplicação (PRD)
    const chave = this.deduplicator.buildKey(pair, tf, closedCandle.timestamp, this.strategyVersion);

    // 3. Deduplicação infalível: se já emitido para este candle (memória ou IndexedDB), ignora
    if (this.deduplicator.has(chave)) {
      rec("SIGNAL_SKIP", {
        chave,
        par: pair,
        ts: closedCandle.timestamp,
        reason: "ALREADY_DEDUPLICATED",
      });
      return;
    }

    const alreadyInStore = await signalStore.hasSignal(chave);
    if (alreadyInStore) {
      rec("SIGNAL_SKIP", {
        chave,
        par: pair,
        ts: closedCandle.timestamp,
        reason: "ALREADY_IN_STORE",
      });
      return;
    }

    const candleCloseTime = closedCandle.timestamp + tf;
    const targetCandle = newCandle || {
      timestamp: candleCloseTime,
      open: closedCandle.close,
      receivedAt: Date.now(),
    };

    // 4. Executa avaliação ou reutiliza pré-sinal travado
    // Se o SignalLifecycle já gerou PRE_SIGNAL ou ENTRY_NOW para esta vela-alvo,
    // reutiliza a decisão travada garantindo 100% de coerência e ZERO repinte entre 52s e 00s.
    const closedCandles = this.store.getCandles(pair, tf, 150);
    const lcKey = this.lifecycle._key ? this.lifecycle._key(pair, tf, targetCandle.timestamp) : `${pair}:${tf}:${targetCandle.timestamp}`;
    const existingLc = this.lifecycle.byKey?.get(lcKey);
    let decision;

    if (existingLc && existingLc.direction && (existingLc.phase === Phase.PRE_SIGNAL || existingLc.phase === Phase.ENTRY_NOW)) {
      decision = existingLc.snapshot || {
        action: existingLc.direction,
        probability: 0.65,
        subStrategy: "QUANT_CONSENSUS",
        reasons: ["Direção pré-sinal confirmada na virada da vela"],
      };
      if (!decision.action) decision.action = existingLc.direction;
      const normalized = { ...decision, symbol: pair };
      this.decisionsBySymbol.set(pair, normalized);
      if (pair === this.currentSymbol) {
        this.lastCachedDecision = normalized;
      }
    } else {
      const microMetrics = this.intraminuteTracker.getCurrentMetrics(pair, tf);
      const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

      decision = this.registry.get(pair).evaluate({
        symbol: pair,
        timeframeSeconds: tf,
        candles: closedCandles,
        microMetrics,
        isReady: true,
        dataState,
        gapCount: 0,
        isStale: false,
      });

      const dur = ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0;
      this._recordEvalDuration(dur, pair, false);
      if (decision) {
        const normalized = { ...decision, symbol: pair };
        this.decisionsBySymbol.set(pair, normalized);
        if (pair === this.currentSymbol) {
          this.lastCachedDecision = normalized;
        }
      }
    }
    const nowWallSec = marketClock.nowSec();
    // Se o timestamp for contemporâneo ao relógio de parede (< 24h), usa marketClock.
    // Em replays/testes com timestamps históricos simulados, usa targetCandle.timestamp.
    const isContemporary = Math.abs(nowWallSec - targetCandle.timestamp) < 86400;
    const referenceNowSec = isContemporary ? nowWallSec : targetCandle.timestamp;
    const ageSec = referenceNowSec - candleCloseTime;
    const isLate = ageSec > 65;

    rec("DECIDE_CALL", {
      par: pair,
      targetTs: targetCandle.timestamp,
      hashCandles: hashCandles(closedCandles),
      action: decision?.action,
      prob: decision?.probability,
      subStrategy: decision?.subStrategy || decision?.strategyName,
      candlesCount: closedCandles.length,
      ageSec,
      isLate,
    });

    const rawAction = decision?.action;
    const isSignal = rawAction === "CALL" || rawAction === "PUT" || rawAction === "BUY" || rawAction === "SELL";
    const direction = isSignal ? (rawAction === "BUY" ? "CALL" : rawAction === "SELL" ? "PUT" : rawAction) : "WAIT";

    // Se o sinal for tardio (> 65s após fechamento da vela), salva no IndexedDB mas NÃO emite alerta (R2)
    if (isLate) {
      rec("SIGNAL_LATE", {
        chave,
        par: pair,
        ts: closedCandle.timestamp,
        ageSec,
        action: direction,
      });

      this.deduplicator.record(chave, {
        action: direction,
        probability: decision?.probability ?? null,
        price: closedCandle.close,
        late: true,
      });

      const lateSeq = await getNextGlobalSeq();
      const lateSignal = {
        id: chave,
        symbol: pair,
        timeframe: tf,
        candleTimestamp: closedCandle.timestamp,
        strategyVersion: this.strategyVersion,
        action: direction,
        reasons: decision?.reasons || [],
        dataState,
        latencyMs: Math.round(ageSec * 1000),
        seq: lateSeq,
        committed: true,
        late: true,
        payout: this.registry.get(pair).payout || this.payout || 0.80,
        createdAt: Date.now(),
        tabId: this.tabId || null,
        entryPrice: closedCandle.close,
      };
      await signalStore.putSignal(lateSignal).catch(() => {});

      logger.warn("SINAL", `Sinal tardio ignorado para alerta (+${ageSec.toFixed(1)}s): [${direction} ${pair}]`);
      return;
    }

    if (isSignal) {
      if (decision.isActionable === false) {
        rec("DECISION_SHADOW_OBSERVE", {
          pair,
          direction,
          subStrategy: decision.subStrategy || decision.strategyName,
          prob: decision.probability,
          edge: decision.edge,
        });
        logger.info("SINAL", `🔬 Oportunidade em SHADOW: [${direction} ${pair} - ${decision.subStrategy || decision.strategyName}] (apenas observação analítica)`);
        return;
      }

      decision.action = direction;

      // 1. Prepara sinal com committed = false (R1, R2)
      const seq = await getNextGlobalSeq();
      const signalRecord = {
        id: chave,
        symbol: pair,
        timeframe: tf,
        candleTimestamp: targetCandle.timestamp,
        strategyVersion: this.strategyVersion,
        action: direction,
        reasons: decision.reasons || [],
        dataState,
        latencyMs: Math.max(0, Date.now() - (targetCandle.receivedAt || Date.now())),
        seq,
        committed: false,
        createdAt: Date.now(),
        tabId: this.tabId || null,
        probability: decision.probability ?? null,
        conservativeProbability: decision.conservativeProbability ?? decision.probability ?? null,
        edge: decision.edge ?? null,
        quality: decision.quality ?? null,
        payout: this.registry.get(pair).payout || this.payout || 0.80,
        subStrategy: decision.subStrategy || decision.strategyName || null,
        entryPrice: targetCandle.open ?? closedCandle.close,
      };

      // 2. Grava no IndexedDB e AGUARDA confirmação antes de emitir (R2)
      try {
        rec("STORAGE_TX_START", { id: chave, seq });
        await signalStore.putSignal(signalRecord);
        rec("STORAGE_TX_SUCCESS", { id: chave, seq });

        // Registra imediatamente no deduplicador em memória
        this.deduplicator.record(chave, {
          action: direction,
          probability: decision?.probability ?? null,
          price: closedCandle.close,
          late: false,
          seq,
        });

        rec("SIGNAL_EMIT", {
          chave,
          par: pair,
          targetTs: targetCandle.timestamp,
          hashCandles: hashCandles(closedCandles),
          action: direction,
          prob: decision.probability,
          subStrategy: decision.subStrategy || decision.strategyName,
          seq,
        });

        // 3. SÓ AGORA EMITE O SINAL (após tx.oncomplete do IndexedDB)
        this.lifecycle.emitSignal(pair, tf, targetCandle.timestamp, decision, targetCandle.timestamp);
        if (Number.isFinite(targetCandle.open)) {
          this.lifecycle.onCandleOpen(pair, tf, targetCandle.timestamp, targetCandle.open);
        }

        rec("SIGNAL_EMIT_AFTER_COMMIT", {
          chave,
          par: pair,
          targetTs: targetCandle.timestamp,
          action: direction,
          seq,
        });

        // 4. Marca como committed = true no IndexedDB
        await signalStore.markCommitted(chave);

      } catch (err) {
        rec("STORAGE_TX_FAIL", { id: chave, error: err?.message || String(err) });
        console.error("[Analyzer] Falha ao persistir sinal em transação IndexedDB:", err);

        // Fallback: salva em chrome.storage.session como pending se disponível (R6)
        if (typeof chrome !== "undefined" && chrome.storage?.session) {
          try {
            const res = await chrome.storage.session.get("ifx:pending_signals");
            const pending = Array.isArray(res?.["ifx:pending_signals"]) ? res["ifx:pending_signals"] : [];
            pending.push(signalRecord);
            await chrome.storage.session.set({ "ifx:pending_signals": pending });
          } catch (_) {}
        }
        // Fail-safe: NÃO emite sinal se falhar a persistência
        return;
      }
    } else {
      // WAIT
      this.deduplicator.record(chave, {
        action: "WAIT",
        probability: decision?.probability ?? null,
        price: closedCandle.close,
        late: false,
      });
    }

    this.quantReport = decision;
    this.updatePanelDisplay({ immediate: true });
  }

  buildPanelData() {
    const domSymbol = detectActiveSymbolFromDOM();

    // Se NÃO há canal ativo no activeChannel:
    if (!this.currentSymbol) {
      return {
        tabId: this.tabId,
        windowId: this.windowId,
        symbol: null,
        pair: null,
        tf: this.timeframeSeconds || 60,
        domSymbol,
        action: "WAIT",
        signal: "WAIT",
        label: "Esperando canal del gráfico…",
        signalLabel: "Esperando canal del gráfico…",
        quantLabel: "Esperando canal del gráfico…",
        status: "WAITING_CHANNEL",
        state: "WAITING_CHANNEL",
        frameStatus: typeof window !== "undefined" && window !== window.top ? "iframe conectado" : "conectado",
        wsStatus: this.socketStatus,
        lastPrice: "---",
        lifecycle: { current: null, trade: null, stats: this.signalAuditor.getStats() },
        signalsHistory: this.signalAuditor.getSignals().slice(0, 20),
        stats: this.signalAuditor.getStats(),
        symbols: {},
        allSymbols: [],
        candleTimer: candleTimer.getState(),
        clockOffsetMs: marketClock.offsetMs,
        updatedAt: Date.now(),
      };
    }

    const symbolsMap = {};
    const symbolsList = Array.from(this.activeSymbols.size > 0 ? this.activeSymbols : [this.currentSymbol]);

    for (const sym of symbolsList) {
      let report = this.quality.getReport(sym, this.timeframeSeconds);
      const lastCandle = this.store.getLast(sym, this.timeframeSeconds);
      const closedCandles = this.store.getCandles(sym, this.timeframeSeconds, 150);

      // Auto-conciliação: se já temos histórico no Store (>= 10 velas), garante transição imediata para READY
      if (
        closedCandles.length >= 10 &&
        (report.state === MarketState.SYNCING_HISTORY ||
          report.state === MarketState.SYNCING_REALTIME ||
          report.state === MarketState.BOOTING ||
          report.state === MarketState.RECONNECTING)
      ) {
        this.quality.onHistoryLoaded(sym, this.timeframeSeconds, closedCandles.length);
        this.quality.onRealtimeUpdate(sym, this.timeframeSeconds, { status: "UPDATED" });
        report = this.quality.getReport(sym, this.timeframeSeconds);
      }

      const isReady =
        report.state === MarketState.READY ||
        (closedCandles.length >= 10 &&
          report.state !== MarketState.STALE &&
          report.state !== MarketState.DATA_GAP &&
          report.state !== MarketState.ERROR);

      const microMetrics = this.intraminuteTracker.getCurrentMetrics(
        sym,
        this.timeframeSeconds,
        lastCandle ? lastCandle.open : null,
        lastCandle ? lastCandle.high : null,
        lastCandle ? lastCandle.low : null,
        lastCandle ? lastCandle.close : null
      );

      // 1) evaluate() completo roda SÓ para o par ativo e SÓ quando o lifecycle chama decide (45–57 s).
      // Fora disso, calcule apenas as métricas leves exibidas na aba "Mercado", no máximo a cada 2 s (P-01, P-02).
      const isActiveSym = sym === this.currentSymbol;
      const now = Date.now();

      let light = this.lightMetricsBySymbol.get(sym);
      const lastLightAt = this._lastLightMetricsAtBySymbol?.get(sym) || 0;
      if (!light || (now - lastLightAt >= 2000)) {
        if (!this._lastLightMetricsAtBySymbol) this._lastLightMetricsAtBySymbol = new Map();
        this._lastLightMetricsAtBySymbol.set(sym, now);
        try {
          light = this.registry.get(sym).evaluateLight({
            symbol: sym,
            timeframeSeconds: this.timeframeSeconds,
            candles: closedCandles,
            microMetrics,
            isReady,
          });
          this.lightMetricsBySymbol.set(sym, light);
        } catch (_) {}
      }

      const cached = this.decisionsBySymbol.get(sym) ||
        ((isActiveSym && this.lastCachedDecision && this.lastCachedDecision.symbol === sym)
          ? this.lastCachedDecision
          : null);

      const qReport = {
        action: cached?.action || "WAIT",
        label: cached?.label || "ESCANEANDO",
        strategyName: cached?.strategyName || null,
        subStrategy: cached?.subStrategy || null,
        correlationGroup: cached?.correlationGroup || null,
        probability: cached?.probability ?? 0.50,
        ev: cached?.ev ?? 0,
        edge: cached?.edge ?? 0,
        quality: cached?.quality ?? 0,
        conservativeProbability: cached?.conservativeProbability ?? cached?.probability ?? 0.50,
        regime: light?.regime || cached?.regime || "RANGE_STABLE",
        marketStability: light?.marketStability ?? cached?.marketStability ?? 1.0,
        uncertainty: light?.uncertainty ?? cached?.uncertainty ?? 0.20,
        strategiesResults: cached?.strategiesResults || this.registry.get(sym)._getEmptyFamilySummary(light?.breakeven || 0.55),
        subStrategiesResults: cached?.subStrategiesResults || [],
        reasons: cached?.reasons || ["Escuchando flujo de mercado"],
      };

      const cSignal = { indicators: {} };

      let lastTimeStr = "--:--:--";
      if (lastCandle && lastCandle.timestamp) {
        const d = new Date(lastCandle.timestamp * 1000);
        lastTimeStr = d.toTimeString().split(" ")[0];
      }

      const symPrice = this.lastPrices.get(sym) || (sym === this.currentSymbol ? this.lastPrice : "---");

      // Sinal visual e fase gerenciados estritamente pelo SignalLifecycle com isolamento total por par
      const lifecycle = (sym === this.currentSymbol && this.currentLifecycleSnapshot)
        ? this.currentLifecycleSnapshot
        : this.lifecycle.snapshot(sym, this.timeframeSeconds, marketClock.nowSec());
      const isTradeActive = lifecycle.trade && ["ENTRY_NOW", "IN_TRADE"].includes(lifecycle.trade.phase);
      const isExpiring = lifecycle.trade?.phase === "IN_TRADE" && (lifecycle.trade?.secondsRemaining ?? 60) <= 2;

      // PRE_SIGNAL tem prioridade visual máxima para alertar a direção da próxima vela com antecedência
      const activeItem = (lifecycle.current && lifecycle.current.phase === Phase.PRE_SIGNAL)
        ? lifecycle.current
        : (isTradeActive ? lifecycle.trade : null);

      const displayAction = activeItem?.direction || "WAIT";
      const displayLabel = activeItem
        ? (activeItem.phase === Phase.ENTRY_NOW
            ? "ENTRA AHORA"
            : activeItem.phase === Phase.IN_TRADE
              ? (isExpiring ? "EXPIRANDO" : "EN OPERACIÓN")
              : "PRE-SEÑAL")
        : "ESCANEANDO";

      // Métricas determinísticas imutáveis de acordo com a fase:
      // Se há um item ativo (trade em curso ou pré-sinal), suas métricas congeladas têm prioridade absoluta
      const itemEdge = activeItem?.edge ?? (activeItem?.snapshot?.edge ?? qReport.edge);
      const itemQuality = activeItem?.quality ?? (activeItem?.snapshot?.quality ?? qReport.quality);
      const itemProb = activeItem?.conservativeProbability ?? activeItem?.probability ?? (activeItem?.snapshot?.conservativeProbability ?? activeItem?.snapshot?.probability ?? (qReport.conservativeProbability ?? qReport.probability));
      const itemSubStrategy = activeItem?.subStrategy ?? activeItem?.strategyName ?? (activeItem?.snapshot?.subStrategy ?? activeItem?.snapshot?.strategyName ?? qReport.subStrategy);
      const itemStrategyName = activeItem?.strategyName ?? activeItem?.subStrategy ?? (activeItem?.snapshot?.strategyName ?? activeItem?.snapshot?.subStrategy ?? qReport.strategyName);
      const itemReasons = (activeItem?.reasons && activeItem.reasons.length > 0) ? activeItem.reasons : ((activeItem?.snapshot?.reasons && activeItem.snapshot.reasons.length > 0) ? activeItem.snapshot.reasons : qReport.reasons);

      symbolsMap[sym] = {
        frameStatus: typeof window !== "undefined" && window !== window.top ? "iframe conectado" : "conectado",
        wsStatus: this.socketStatus,
        symbol: sym,
        pair: sym,
        action: displayAction,
        rawAction: qReport.action,
        strategyName: itemStrategyName,
        subStrategy: itemSubStrategy,
        correlationGroup: qReport.correlationGroup,
        timeframe: `${this.timeframeSeconds / 60} minuto(s)`,
        timeframeSeconds: this.timeframeSeconds,
        tf: this.timeframeSeconds,
        historyCount: closedCandles.length,
        lastCandleTime: lastTimeStr,
        lastPrice: symPrice,
        gaps: report.gapCount,
        state: isReady ? MarketState.READY : report.state,
        status: isReady ? MarketState.READY : report.state,
        lifecycle,
        quantAction: displayAction,
        quantLabel: displayLabel,
        quantProbability: itemProb,
        quantEV: qReport.ev,
        edge: itemEdge,
        quality: itemQuality,
        conservativeProbability: itemProb,
        regime: qReport.regime,
        marketStability: qReport.marketStability,
        uncertainty: qReport.uncertainty,
        strategiesResults: qReport.strategiesResults || [],
        subStrategiesResults: qReport.subStrategiesResults || [],
        microstructure: microMetrics,
        quantReasons: itemReasons,
        payout: this.registry.get(sym).payout,
        signalsHistory: this.signalAuditor.getSignals().slice(0, 20),
        stats: this.signalAuditor.getStats(),
        signal: displayAction !== "WAIT" ? displayAction : "WAIT",
        signalLabel: displayLabel,
        signalReasons: itemReasons,
        executionMoment: "AT_CANDLE_OPEN",
        indicators: cSignal?.indicators || {},
        candleTimestamp: lastCandle?.timestamp || Math.floor(marketClock.nowSec()),
        candleTimer: candleTimer.getState(),
        clockOffsetMs: marketClock.offsetMs,
        isSoundEnabled: true,
        updatedAt: Date.now(),
      };
    }

    const activeObj = symbolsMap[this.currentSymbol] || Object.values(symbolsMap)[0] || {};
    this.quantReport = activeObj;

    const stateObj = {
      ...activeObj,
      tabId: this.tabId,
      windowId: this.windowId,
      symbol: this.currentSymbol || activeObj.symbol || null,
      pair: this.currentSymbol || activeObj.pair || null,
      selectedSymbol: this.currentSymbol || activeObj.symbol || null,
      activeSymbols: Array.from(this.activeSymbols.size > 0 ? this.activeSymbols : (activeObj.symbol ? [activeObj.symbol] : [])),
      domSymbol,
      tf: this.timeframeSeconds,
      status: activeObj.state || "BOOTING",
      clockOffsetMs: marketClock.offsetMs,
      symbols: symbolsMap,
      allSymbols: Object.keys(symbolsMap),
      updatedAt: Date.now(),
    };

    return stateObj;
  }

  updatePanelDisplay({ immediate = false } = {}) {
    if (this._isDestroyed) return;
    this._statePublicationsCount = (this._statePublicationsCount || 0) + 1;
    const stateObj = this.buildPanelData();
    if (this.panel) {
      this.panel.update(stateObj);
    }
    this.saveMarketStateToStorage(stateObj, { immediate });
  }

  _saveTabState(immediate = false) {
    this.updatePanelDisplay(immediate);
  }

  saveMarketStateToStorage(stateObj, { immediate = false } = {}) {
    if (this._isDestroyed) return;
    if (typeof chrome === "undefined" || !this.tabId) return;

    const payload = {
      ...stateObj,
      tabId: this.tabId,
      windowId: this.windowId,
      pair: this.currentSymbol,
      symbol: this.currentSymbol,
      tf: this.timeframeSeconds,
      status: stateObj.state || stateObj.status || "BOOTING",
      clockOffsetMs: marketClock.offsetMs,
      updatedAt: Date.now(),
    };

    const now = Date.now();

    // Desacoplamento de Cronômetro vs Persistência (Etapa 8):
    // Cria digest com símbolo, status, fase e direção do trade e da oportunidade, e último resultado
    const currentPhase = payload?.lifecycle?.current?.phase || "NONE";
    const currentDir = payload?.lifecycle?.current?.direction || "NONE";
    const currentTarget = payload?.lifecycle?.current?.targetTs || 0;
    const tradePhase = payload?.lifecycle?.trade?.phase || "NONE";
    const tradeDir = payload?.lifecycle?.trade?.direction || "NONE";
    const tradeTarget = payload?.lifecycle?.trade?.targetTs || 0;
    const lastResultId = payload?.signalsHistory?.[0]?.id || "NONE";
    const lastResultRes = payload?.signalsHistory?.[0]?.result || "NONE";
    const currentSymbol = payload.symbol || "NONE";
    const currentStatus = payload.status || "NONE";

    const digest = `${currentSymbol}:${currentStatus}:${currentPhase}:${currentDir}:${currentTarget}:${tradePhase}:${tradeDir}:${tradeTarget}:${lastResultId}:${lastResultRes}`;

    const stateChanged = this._lastPersistedDigest !== digest;
    const heartbeatExpired = !this._lastHeartbeatWriteTime || (now - this._lastHeartbeatWriteTime >= 5000);

    // Se o estado não mudou e não é imediato nem expirou o heartbeat de 5s, não regravar
    if (!immediate && !stateChanged && !heartbeatExpired) {
      return;
    }

    if (!immediate && this._lastStateSaveTime && (now - this._lastStateSaveTime < 250)) {
      this._latestStateToSave = payload;
      if (!this._pendingStateSaveTimeout) {
        this._pendingStateSaveTimeout = setTimeout(() => {
          this._pendingStateSaveTimeout = null;
          this.saveMarketStateToStorage(this._latestStateToSave, { immediate: false });
        }, 250 - (now - this._lastStateSaveTime));
      }
      return;
    }

    if (this._pendingStateSaveTimeout) {
      clearTimeout(this._pendingStateSaveTimeout);
      this._pendingStateSaveTimeout = null;
    }
    this._lastStateSaveTime = now;
    this._latestStateToSave = null;
    this._lastPersistedDigest = digest;
    this._lastHeartbeatWriteTime = now;

    this._writeSeq = (this._writeSeq || 0) + 1;
    payload.writeSeq = this._writeSeq;
    const payloadSize = typeof JSON !== "undefined" ? JSON.stringify(payload).length : 0;
    const sessionStateKey = `ifx:session:tab:${this.tabId}:state`;
    this._logFlight("STATE_WRITE", {
      chave: sessionStateKey,
      writeSeq: this._writeSeq,
      tabId: this.tabId,
      symbol: payload.symbol,
      revision: this._writeSeq,
      phase: currentPhase,
      tradePhase: tradePhase,
      resumo: {
        current: payload?.lifecycle?.current ? {
          phase: payload.lifecycle.current.phase,
          direction: payload.lifecycle.current.direction,
          targetTs: payload.lifecycle.current.targetTs,
        } : null,
        trade: payload?.lifecycle?.trade ? {
          phase: payload.lifecycle.trade.phase,
          direction: payload.lifecycle.trade.direction,
          targetTs: payload.lifecycle.trade.targetTs,
        } : null,
        lastResult: payload?.signalsHistory?.[0] ? {
          id: payload.signalsHistory[0].id,
          direction: payload.signalsHistory[0].action || payload.signalsHistory[0].direction,
          result: payload.signalsHistory[0].result,
          targetTs: payload.signalsHistory[0].targetTimestamp,
        } : null,
      },
      tamanhoPayload: payloadSize,
    });

    if (chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage(
          {
            type: "ORACLE_SAVE_TAB_STATE",
            tabId: this.tabId,
            state: payload,
          },
          (res) => {
            if (res && res.saved) {
              this._storageWritesCount++;
            }
          }
        );
      } catch (_) {}
    } else {
      const sessionStore = chrome.storage?.session || chrome.storage?.local;
      if (sessionStore?.set) {
        try {
          sessionStore.set({
            [sessionStateKey]: payload,
          });
          this._storageWritesCount++;
        } catch (_) {}
      }
    }
  }

  /**
   * Registra log no flight recorder unificado.
   * @param {string} eventType
   * @param {Object} payload
   */
  _logFlight(eventType, payload) {
    if (typeof rec === "function") {
      rec(eventType, payload, { tabId: this.tabId });
    }
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: "FLIGHT_RECORDER_LOG",
          eventType,
          payload,
          tabId: this.tabId,
        }).catch(() => {});
      } catch (_) {}
    }
  }

  get quantPortfolio() {
    return this.registry.get(this.currentSymbol);
  }
}

export const COMPUTE_HOSTS = ["chart.b2trading.io", "traderoom.b2trading.io"];

export function isComputeFrame(hostname = "") {
  if (typeof window !== "undefined") {
    // Apenas a janela principal (frame TOP) pode ser instância de cálculo ativa
    if (window.self !== window.top) {
      return false;
    }
  }
  const host = hostname || (typeof location !== "undefined" ? location.hostname : "");
  if (!host) return false;
  if (host === "chart.b2trading.io") return true;
  if (host === "traderoom.b2trading.io") return true;
  return COMPUTE_HOSTS.includes(host);
}

// Inicialização automática do Analyzer no content script
if (typeof window !== "undefined") {
  const host = window.location.hostname;
  if (isComputeFrame(host)) {
    window.__oracleAnalyzer = new MarketAnalyzer();
  }
}
