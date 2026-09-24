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
import { intraminuteTracker } from "../market/intraminute-tracker.js";
import { candleTimer } from "../utils/candle-timer.js";
import { marketClock } from "../utils/market-clock.js";
import { logger } from "../utils/logger.js";
import { initBridgeListener } from "./bridge.js";

/**
 * Extrai o símbolo de um payload heterogêneo de forma abrangente.
 * Suporta pair, symbol, asset, ticker e envelopes messages/data.
 *
 * @param {any} payload
 * @returns {string|null} Símbolo em caixa alta ou null
 */
export function extractSymbolFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const direct = payload.pair || payload.symbol || payload.asset || payload.ticker;
  if (direct && typeof direct === "string") return direct.trim().toUpperCase();
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    for (const m of payload.messages) {
      if (!m || typeof m !== "object") continue;
      const s = m.pair || m.symbol || m.asset || m.ticker || m.data?.pair || m.data?.symbol || m.data?.asset;
      if (s && typeof s === "string") return s.trim().toUpperCase();
    }
  }
  if (payload.data && typeof payload.data === "object") {
    const d = payload.data;
    const s = d.pair || d.symbol || d.asset || d.ticker;
    if (s && typeof s === "string") return s.trim().toUpperCase();
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
  } catch (_) {}
  return null;
}

export class MarketAnalyzer {
  constructor() {
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
    this._unsubBridge = null;
    this._unsubChannel = null;
    this._unsubLifecycle = null;
    this._heartbeatInterval = null;

    if (typeof window !== "undefined") {
      candleTimer.start();
    }
    this.quality = new DataQualityTracker({ staleTimeoutMs: 15000, minHistoryBars: 10 });
    this.intraminuteTracker = intraminuteTracker;

    // Portfólio da Nova Arquitetura Probabilística M1 e Auditor de Sinais
    this.payout = 0.80;
    this.registry = new PortfolioRegistry((pair) => new QuantPortfolio({ payout: this.payout, minEdge: 0.015 }));
    this.signalAuditor = signalAuditor;
    this.lifecycle = new SignalLifecycle();
    this.lastDecideAt = 0;
    this.lastCachedDecision = null;
    this.currentLifecycleSnapshot = null;
    this.panel = null;

    // UMA fonte de verdade para o par ativo: SOMENTE activeChannel (subscribe/unsubscribe capturado do WebSocket)
    this._unsubChannel = this.activeChannel.onChange((next, prev) => {
      if (prev && prev.pair && (!next || next.pair !== prev.pair)) {
        this.lifecycle.cancelPair(prev.pair, "ASSET_CHANGED");
        this.activeSymbols.delete(prev.pair);
      }
      if (next && next.pair) {
        this.currentSymbol = next.pair;
        this.timeframeSeconds = next.tf || 60;
        this.activeSymbols.clear();
        this.activeSymbols.add(next.pair);
        logger.setContext({ symbol: this.currentSymbol, tabId: this.tabId });
      } else {
        this.currentSymbol = null;
      }
      this.updatePanelDisplay();
    });

    // Conexão dos Eventos do SignalLifecycle (Único ponto com efeitos colaterais de sinal)
    this._unsubLifecycle = this.lifecycle.onEvent((event, lc) => {
      if (this._isDestroyed) return;
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
      } else if (event === Phase.ENTRY_NOW || event === Phase.IN_TRADE) {
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

    // Métricas de performance e escrita no storage (P-01, P-02)
    this._evalDurations = [];
    this._storageWritesCount = 0;
    this._lastPerfLogTime = Date.now();
    this._lastLightMetricsAt = 0;
    this._cachedLightMetrics = null;

    this.init();
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
    });

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
      });
    }

    const host = typeof window !== "undefined" ? window.location.hostname : "local";
    logger.info("SISTEMA", `Analyzer ativo em iframe gráfico de cálculo (${host})`);
  }

  _claimCompute() {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage || !this.tabId) return;

    chrome.runtime.sendMessage({ type: "CLAIM_COMPUTE", tabId: this.tabId }, (response) => {
      if (chrome.runtime?.lastError || !response || response.granted === false) {
        logger.warn("SISTEMA", `Instância de cálculo recusada para a aba ${this.tabId} (DENIED). Outro frame ativo.`);
        this.destroy();
        return;
      }

      if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = setInterval(() => {
        if (this._isDestroyed) return;
        chrome.runtime.sendMessage({ type: "COMPUTE_HEARTBEAT", tabId: this.tabId }, (hbRes) => {
          if (hbRes && hbRes.ok === false) {
            logger.warn("SISTEMA", "Heartbeat recusado. Perdida posse de cálculo.");
            this.destroy();
          }
        });
      }, 2000);
    });
  }

  destroy() {
    this._isDestroyed = true;
    if (this._unsubBridge) {
      try { this._unsubBridge(); } catch (_) {}
      this._unsubBridge = null;
    }
    if (this._unsubChannel) {
      try { this._unsubChannel(); } catch (_) {}
      this._unsubChannel = null;
    }
    if (this._unsubLifecycle) {
      try { this._unsubLifecycle(); } catch (_) {}
      this._unsubLifecycle = null;
    }
    if (this._staleInterval) clearInterval(this._staleInterval);
    if (this._lifecycleInterval) clearInterval(this._lifecycleInterval);
    if (this._perfInterval) clearInterval(this._perfInterval);
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    if (this._pendingStateSaveTimeout) clearTimeout(this._pendingStateSaveTimeout);
    if (this._disconnectTimer) clearTimeout(this._disconnectTimer);

    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage && this.tabId) {
      try {
        chrome.runtime.sendMessage({ type: "RELEASE_COMPUTE", tabId: this.tabId });
      } catch (_) {}
    }
  }

  _recordEvalDuration(ms) {
    if (Number.isFinite(ms)) {
      this._evalDurations.push(ms);
    }
  }

  _logPerfMetrics() {
    const count = this._evalDurations.length;
    const avgMs = count > 0
      ? (this._evalDurations.reduce((a, b) => a + b, 0) / count).toFixed(2)
      : "0.00";
    const writes = this._storageWritesCount;

    logger.info(
      "PERF",
      `[Métricas 60s] evaluate() médio: ${avgMs}ms (${count} execuções) | Storage writes: ${writes}/min (meta: <= 240/min)`
    );

    this._evalDurations = [];
    this._storageWritesCount = 0;
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

    const active = this.activeChannel.get();
    const pair = active?.pair || this.currentSymbol;
    const tf = active?.tf || this.timeframeSeconds;

    if (!pair) {
      this.currentLifecycleSnapshot = { status: "WAITING_CHANNEL", pair: null, tf };
      return this.currentLifecycleSnapshot;
    }

    if (tf !== LIFECYCLE.SUPPORTED_TF_SEC) {
      this.currentLifecycleSnapshot = { status: "TF_NOT_SUPPORTED", pair, tf };
      return this.currentLifecycleSnapshot;
    }

    const currentNowSec = nowSec ?? marketClock.nowSec();
    let currentDataOk = dataOk;
    if (currentDataOk === null) {
      const report = this.quality.getReport(pair, tf);
      const isReady = this.store.isReady(pair, tf);
      currentDataOk = isReady && report.state === MarketState.READY;
    }

    const decideFn = decide ?? (() => {
      const now = Date.now();
      if (now - this.lastDecideAt < 300 && this.lastCachedDecision) {
        return this.lastCachedDecision;
      }
      const closedCandles = this.store.getCandles(pair, tf, 150);
      const microMetrics = this.intraminuteTracker.getCurrentMetrics(pair, tf);
      const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      const decision = this.registry.get(pair).evaluate({
        symbol: pair,
        timeframeSeconds: tf,
        candles: closedCandles,
        microMetrics,
        isReady: currentDataOk,
        gapCount: 0,
        isStale: false,
      });
      const dur = ((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0;
      this._recordEvalDuration(dur);

      this.lastDecideAt = now;
      this.lastCachedDecision = decision;
      this.quantReport = decision;
      return decision;
    });

    const snapshot = this.lifecycle.step({
      pair,
      tf,
      nowSec: currentNowSec,
      dataOk: currentDataOk,
      decide: decideFn,
    });

    this.currentLifecycleSnapshot = snapshot;
    return snapshot;
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
      this.processRealtimePayload(event.payload);
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

  processRealtimePayload(payload) {
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
    const activeTf = active?.tf || this.timeframeSeconds || 60;

    // Se o canal não chegar em 20s após o primeiro tick, log WARN 'canal subscribe não capturado' — NÃO adote par.
    if (!activePair && !this._warnedNoChannel && (Date.now() - this._firstTickAt >= 20000)) {
      this._warnedNoChannel = true;
      logger.warn("CANAL", "canal subscribe não capturado");
    }

    const extractedSym = extractSymbolFromPayload(payload);
    const incomingSym = extractedSym || activePair || "";

    const candles = normalizeWebSocketPayload(payload, activeTf, { symbol: incomingSym });
    if (!candles || candles.length === 0) return;

    for (const candle of candles) {
      if (!isValidCandle(candle)) {
        logger.warn("FEED", `Candle inválido rejeitado: [${candle?.symbol || incomingSym}]`);
        continue;
      }

      const candleSym = candle.symbol || incomingSym;

      // Guarda os candles no store (por símbolo para aquecer)
      const result = this.store.ingest(candle);

      // Se activeChannel.get() for null, NÃO rode lifecycle nem mude currentSymbol
      if (!activePair) {
        continue;
      }

      // Ticks de par diferente do canal ativo: ingest no store do par deles (já feito) e mais nada!
      if (candleSym !== activePair) {
        continue;
      }

      // Se o timeframe ativo não for M1 (60s), não gera sinal
      if (activeTf !== LIFECYCLE.SUPPORTED_TF_SEC) {
        this.currentLifecycleSnapshot = { status: "TF_NOT_SUPPORTED", pair: activePair, tf: activeTf };
        continue;
      }

      this.activeSymbols.add(activePair);

      // 1. Registra tick no IntraminuteTracker
      this.intraminuteTracker.recordTick(
        activePair,
        activeTf,
        candle.close,
        candle.timestamp,
        candle.receivedAt
      );

      this.quality.onRealtimeUpdate(activePair, activeTf, result);

      this.tickLifecycle();

      const priceStr = candle.close.toFixed(5);
      this.lastPrices.set(activePair, priceStr);
      this.lastPrice = priceStr;

      if (result.status === "NEW_CANDLE") {
        if (activeTf === 60) {
          marketClock.observeCandleOpen(candle.timestamp, candle.receivedAt);
          this.lifecycle.onCandleOpen(activePair, activeTf, candle.timestamp, candle.open);
        }
        logger.success(
          "STORE",
          `Nova vela aberta em ${activePair}. Fechamento anterior: ${result.closedCandle?.close?.toFixed(5)}`
        );

        if (result.closedCandle) {
          this.lifecycle.onCandleClose(activePair, activeTf, result.closedCandle);
          const closedSeries = this.store.getCandles(activePair, activeTf, 150);
          this.registry.get(activePair).observeClosedCandle(closedSeries);
        }

        const closedSeries = this.store.getCandles(activePair, activeTf, 150);
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
      } else if (result.status === "DATA_GAP") {
        logger.warn("ESTADO", `Gap detectado em ${activePair}: de ${result.gapFrom} até ${result.gapTo}`);
      } else if (result.status === "UPDATED" || result.status === "INITIALIZED") {
        if (this._lastLoggedPrices.get(activePair) !== priceStr) {
          this._lastLoggedPrices.set(activePair, priceStr);
          logger.info("FEED", `${activePair} tick: ${priceStr} (máx: ${candle.high.toFixed(5)}, mín: ${candle.low.toFixed(5)})`);
        }
      }
    }

    this.updatePanelDisplay();
  }

  updatePanelDisplay({ immediate = false } = {}) {
    if (this._isDestroyed) return;

    const domSymbol = detectActiveSymbolFromDOM();

    // Se NÃO há canal ativo no activeChannel:
    if (!this.currentSymbol) {
      const stateObj = {
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

      if (this.panel) {
        this.panel.update(stateObj);
      }
      this.saveMarketStateToStorage(stateObj, { immediate });
      return;
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

      let light = this._cachedLightMetrics;
      if (isActiveSym) {
        if (!light || (now - this._lastLightMetricsAt >= 2000)) {
          this._lastLightMetricsAt = now;
          this._cachedLightMetrics = this.registry.get(sym).evaluateLight({
            symbol: sym,
            timeframeSeconds: this.timeframeSeconds,
            candles: closedCandles,
            microMetrics,
            isReady,
          });
          light = this._cachedLightMetrics;
        }
      }

      const cached = (isActiveSym && this.lastCachedDecision && this.lastCachedDecision.symbol === sym)
        ? this.lastCachedDecision
        : null;

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
        conservativeProbability: cached?.conservativeProbability ?? 0.50,
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

      // Sinal visual e fase gerenciados estritamente pelo SignalLifecycle
      const lifecycle = this.currentLifecycleSnapshot || this.lifecycle.snapshot(sym, this.timeframeSeconds, marketClock.nowSec());
      const activeItem = (lifecycle.trade && ["ENTRY_NOW", "IN_TRADE"].includes(lifecycle.trade.phase))
        ? lifecycle.trade
        : (lifecycle.current && lifecycle.current.phase === Phase.PRE_SIGNAL)
          ? lifecycle.current
          : null;

      const displayAction = activeItem?.direction || "WAIT";
      const displayLabel = activeItem
        ? (activeItem.phase === Phase.ENTRY_NOW ? "ENTRA AHORA" : activeItem.phase === Phase.IN_TRADE ? "EN OPERACIÓN" : "PRE-SEÑAL")
        : "ESCANEANDO";

      symbolsMap[sym] = {
        frameStatus: typeof window !== "undefined" && window !== window.top ? "iframe conectado" : "conectado",
        wsStatus: this.socketStatus,
        symbol: sym,
        pair: sym,
        action: displayAction,
        rawAction: qReport.action,
        strategyName: qReport.strategyName,
        subStrategy: qReport.subStrategy,
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
        quantProbability: qReport.probability,
        quantEV: qReport.ev,
        edge: qReport.edge,
        quality: qReport.quality,
        conservativeProbability: qReport.conservativeProbability,
        regime: qReport.regime,
        marketStability: qReport.marketStability,
        uncertainty: qReport.uncertainty,
        strategiesResults: qReport.strategiesResults || [],
        subStrategiesResults: qReport.subStrategiesResults || [],
        microstructure: microMetrics,
        quantReasons: qReport.reasons || [],
        payout: this.registry.get(sym).payout,
        signalsHistory: this.signalAuditor.getSignals().slice(0, 20),
        stats: this.signalAuditor.getStats(),
        signal: displayAction !== "WAIT" ? displayAction : "WAIT",
        signalLabel: displayLabel,
        signalReasons: qReport.reasons || [],
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
      symbol: this.currentSymbol,
      pair: this.currentSymbol,
      domSymbol,
      tf: this.timeframeSeconds,
      status: activeObj.state || "BOOTING",
      clockOffsetMs: marketClock.offsetMs,
      symbols: symbolsMap,
      allSymbols: Object.keys(symbolsMap),
      updatedAt: Date.now(),
    };

    if (this.panel) {
      this.panel.update(stateObj);
    }

    this.saveMarketStateToStorage(stateObj, { immediate });
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
    } else if (chrome.storage?.local?.set) {
      try {
        chrome.storage.local.set({
          [`ifx:tab:${this.tabId}:state`]: payload,
        });
        this._storageWritesCount++;
      } catch (_) {}
    }
  }

  get quantPortfolio() {
    return this.registry.get(this.currentSymbol);
  }
}

export const COMPUTE_HOSTS = ["chart.b2trading.io"];

export function isComputeFrame(hostname = "") {
  const host = hostname || (typeof location !== "undefined" ? location.hostname : "");
  return host === "chart.b2trading.io";
}

// Inicialização automática do Analyzer no content script (exclusivo para iframe do gráfico)
if (typeof window !== "undefined") {
  const host = window.location.hostname;
  if (isComputeFrame(host)) {
    window.__oracleAnalyzer = new MarketAnalyzer();
  } else {
    let warned = false;
    initBridgeListener({
      onMarketEvent: (event) => {
        if (!warned && event?.sourceType === "websocket") {
          warned = true;
          logger.warn("SISTEMA", `WS de mercado em frame não-cálculo: ${host}`);
        }
      },
    });
  }
}
