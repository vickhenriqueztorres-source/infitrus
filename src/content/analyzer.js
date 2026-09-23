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

export class MarketAnalyzer {
  constructor() {
    this.timeframeSeconds = 60; // Padrão M1
    this.currentSymbol = "EURUSD";
    this.activeSymbols = new Set(["EURUSD"]);
    this.lastPrices = new Map();
    this._lastLoggedPrices = new Map();
    this.store = new CandleStore({ maxCandlesPerSeries: 500 });
    this.activeChannel = new ActiveChannel();

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
    this.panel = null; // Painel oculto removido do fluxo de execução padrão (I-08)

    // Ao trocar de ativo: cancela par antigo, limpa do activeSymbols e atualiza contexto (I-03, I-10)
    this.activeChannel.onChange((next, prev) => {
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
      }
      this.updatePanelDisplay();
    });

    // Conexão dos Eventos do SignalLifecycle (Único ponto com efeitos colaterais de sinal)
    this.lifecycle.onEvent((event, lc) => {
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
      label: "AGUARDAR",
      probability: 0.50,
      ev: 0,
      edge: 0,
      quality: 0,
      strategiesResults: [],
      individualSignals: [],
      confluence: null,
      isConfluence: false,
      isDivergent: false,
      reasons: ["Inicializando portfólio quantitativo..."],
      isNewSignal: false,
    };

    this.currentSignal = {
      action: "WAIT",
      label: "AGUARDAR",
      indicators: { ema9: null, ema21: null, rsi14: null },
      reasons: ["Inicializando observador quant"],
      isNewSignal: false,
    };

    this.socketStatus = "desconectado";
    this.lastPrice = "---";
    this._lastLoggedPrice = null;
    this._lastState = null;
    this._lastSigKey = null;

    this.tabId = null;
    this.windowId = null;

    this.init();
  }

  init() {
    // 0. Identifica a aba e janela atuais via Background Service Worker
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: "ORACLE_GET_TAB_INFO" }, (info) => {
          if (info) {
            this.tabId = info.tabId || null;
            this.windowId = info.windowId || null;
            if (this.tabId) {
              this.signalAuditor.setTabId(this.tabId);
            }
            logger.setContext({ tabId: this.tabId, symbol: this.currentSymbol });
            this.updatePanelDisplay({ immediate: true });
          }
        });
      } catch (_) {}
    }

    // 1. Escuta eventos da Bridge (com canal)
    initBridgeListener({
      onMarketEvent: (event) => this.handleMarketEvent(event),
      onSocketStatus: (info) => this.handleSocketStatus(info),
      onChannel: (ch) => this.activeChannel.onChannel(ch),
    });

    // 2. Verificação periódica de Heartbeat / Stale feed a cada 2.5s e loop contínuo do SignalLifecycle
    if (typeof window !== "undefined") {
      setInterval(() => {
        this.quality.checkStale(this.currentSymbol, this.timeframeSeconds);
        this.updatePanelDisplay();
      }, 2500);

      setInterval(() => {
        this.tickLifecycle();
      }, 250);
    }

    // 3. Listener seguro para alteração de payout e vinculação de janela via Background/Side Panel (I-01, I-05)
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender) => {
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

    logger.info("SISTEMA", `Analyzer ativo em iframe gráfico de cálculo`);
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
    const active = this.activeChannel.get();
    const pair = active?.pair || this.currentSymbol;
    const tf = active?.tf || this.timeframeSeconds;

    if (tf !== LIFECYCLE.SUPPORTED_TF_SEC) {
      this.currentLifecycleSnapshot = { status: "TF_NOT_SUPPORTED", pair, tf };
      return this.currentLifecycleSnapshot;
    }

    const currentNowSec = nowSec ?? marketClock.nowSec();
    let currentDataOk = dataOk;
    if (currentDataOk === null) {
      const report = this.quality.evaluate();
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
      const decision = this.registry.get(pair).evaluate({
        symbol: pair,
        timeframeSeconds: tf,
        candles: closedCandles,
        microMetrics,
        isReady: currentDataOk,
        gapCount: 0,
        isStale: false,
      });
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
    this.socketStatus = info.status === "connected" ? "conectado" : "desconectado";
    if (info.status === "connected") {
      logger.success("WS", "WebSocket conectado ao stream de mercado (wss://ws.b2trading.io/ws)");
    } else if (info.status === "closed") {
      logger.warn("WS", "Conexão WebSocket encerrada. Aguardando reconexão...");
      this.quality.onDisconnect(this.currentSymbol, this.timeframeSeconds);
    }
    this.updatePanelDisplay();
  }

  handleMarketEvent(event) {
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
    const active = this.activeChannel.get();
    const targetPair = meta?.pair || active?.pair || this.currentSymbol;
    const targetTf = meta?.tf || active?.tf || this.timeframeSeconds;

    const bars = normalizeHistoryBars(payload, targetPair, targetTf);
    if (!bars || bars.length === 0) return;

    const detectedSym = bars[0].symbol;
    if (detectedSym && detectedSym !== this.currentSymbol) {
      this.currentSymbol = detectedSym;
      this.activeSymbols.clear();
      this.activeSymbols.add(detectedSym);
      logger.setContext({ symbol: this.currentSymbol, tabId: this.tabId });
    }

    this.store.ingestBatch(bars);
    this.quality.onHistoryLoaded(this.currentSymbol, this.timeframeSeconds, bars.length);

    const last = this.store.getLast(this.currentSymbol, this.timeframeSeconds);
    if (last) {
      this.lastPrice = last.close.toFixed(5);
    }

    logger.info("HISTÓRICO", `${bars.length} candles carregados para ${this.currentSymbol} (${this.timeframeSeconds}s)`);
    this.updatePanelDisplay();
  }

  processRealtimePayload(payload) {
    const active = this.activeChannel.get();
    const activePair = active?.pair || this.currentSymbol;
    const activeTf = active?.tf || this.timeframeSeconds;

    // Se o timeframe ativo não for M1 (60s), não gera sinal
    if (activeTf !== LIFECYCLE.SUPPORTED_TF_SEC) {
      this.currentLifecycleSnapshot = { status: "TF_NOT_SUPPORTED", pair: activePair, tf: activeTf };
      return;
    }

    const rawSym = payload.pair || payload.symbol;
    const incomingSym = (rawSym && typeof rawSym === "string") ? rawSym.trim().toUpperCase() : activePair;

    // Descarta ticks de outros ativos quando já há um ativo ativo definido (I-03, I-10)
    if (activePair && incomingSym && incomingSym !== activePair) {
      return;
    }

    const sym = incomingSym || activePair;
    this.currentSymbol = sym;
    this.activeSymbols.clear();
    this.activeSymbols.add(sym);

    const candles = normalizeWebSocketPayload(payload, this.timeframeSeconds, { symbol: incomingSym });
    if (!candles || candles.length === 0) return;

    for (const candle of candles) {
      if (!isValidCandle(candle)) {
        logger.warn("FEED", `Candle inválido rejeitado: [${candle?.symbol || incomingSym}]`);
        continue;
      }

      const sym = candle.symbol || incomingSym;
      this.activeSymbols.add(sym);

      // 1. Registra tick no IntraminuteTracker
      this.intraminuteTracker.recordTick(
        sym,
        this.timeframeSeconds,
        candle.close,
        candle.timestamp,
        candle.receivedAt
      );

      const result = this.store.ingest(candle);
      this.quality.onRealtimeUpdate(sym, this.timeframeSeconds, result);

      if (sym === this.currentSymbol) {
        this.tickLifecycle();
      }

      const priceStr = candle.close.toFixed(5);
      this.lastPrices.set(sym, priceStr);
      if (sym === this.currentSymbol) {
        this.lastPrice = priceStr;
      }

      if (result.status === "NEW_CANDLE") {
        if (sym === this.currentSymbol && this.timeframeSeconds === 60) {
          marketClock.observeCandleOpen(candle.timestamp, candle.receivedAt);
          this.lifecycle.onCandleOpen(sym, this.timeframeSeconds, candle.timestamp, candle.open);
        }
        logger.success(
          "STORE",
          `Nova vela aberta em ${sym}. Fechamento anterior: ${result.closedCandle?.close?.toFixed(5)}`
        );

        if (result.closedCandle) {
          if (sym === this.currentSymbol) {
            this.lifecycle.onCandleClose(sym, this.timeframeSeconds, result.closedCandle);
          }
          const closedSeries = this.store.getCandles(sym, this.timeframeSeconds, 150);
          this.registry.get(sym).observeClosedCandle(closedSeries);
        }

        const closedSeries = this.store.getCandles(sym, this.timeframeSeconds, 150);
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
        logger.warn("ESTADO", `Gap detectado em ${sym}: de ${result.gapFrom} até ${result.gapTo}`);
      } else if (result.status === "UPDATED" || result.status === "INITIALIZED") {
        if (this._lastLoggedPrices.get(sym) !== priceStr) {
          this._lastLoggedPrices.set(sym, priceStr);
          logger.info("FEED", `${sym} tick: ${priceStr} (máx: ${candle.high.toFixed(5)}, mín: ${candle.low.toFixed(5)})`);
        }
      }
    }

    this.updatePanelDisplay();
  }

  updatePanelDisplay() {
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

      const qReport = this.registry.get(sym).evaluate({
        symbol: sym,
        timeframeSeconds: this.timeframeSeconds,
        candles: closedCandles,
        microMetrics,
        isReady,
        gapCount: report.gapCount,
        isStale: report.state === MarketState.STALE,
      });

      const cSignal = this.strategy?.evaluate ? this.strategy.evaluate({
        symbol: sym,
        timeframeSeconds: this.timeframeSeconds,
        candles: closedCandles,
        isReady,
      }) : { indicators: {} };

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
    if (typeof chrome === "undefined" || !chrome.storage?.local || !this.tabId) return;

    const payload = {
      ...stateObj,
      tabId: this.tabId,
      windowId: this.windowId,
      pair: this.currentSymbol,
      symbol: this.currentSymbol,
      tf: this.timeframeSeconds,
      status: stateObj.state || "BOOTING",
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

    try {
      chrome.storage.local.set({
        [`ifx:tab:${this.tabId}:state`]: payload,
      });
    } catch (_) {}
  }

  get quantPortfolio() {
    return this.registry.get(this.currentSymbol);
  }
}

export const COMPUTE_HOSTS = ["chart.b2trading.io"];

export function isComputeFrame(hostname = "") {
  const host = hostname || (typeof location !== "undefined" ? location.hostname : "");
  return COMPUTE_HOSTS.includes(host);
}

// Inicialização automática do Analyzer no content script (apenas no iframe do gráfico)
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
