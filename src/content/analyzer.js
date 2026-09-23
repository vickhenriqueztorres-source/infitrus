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
import { LIFECYCLE } from "../strategy/lifecycle-config.js";
import { signalAuditor } from "../strategy/signal-auditor.js";
import { intraminuteTracker } from "../market/intraminute-tracker.js";
import { audioAlertManager } from "../utils/audio-alerts.js";
import { candleTimer } from "../utils/candle-timer.js";
import { marketClock } from "../utils/market-clock.js";
import { logger } from "../utils/logger.js";
import { initBridgeListener } from "./bridge.js";
import { DiagnosticPanel } from "./panel.js";

export class MarketAnalyzer {
  constructor() {
    this.timeframeSeconds = 60; // Padrão M1
    this.currentSymbol = "EURUSD";
    this.activeSymbols = new Set(["EURUSD"]);
    this.lastPrices = new Map();
    this._lastLoggedPrices = new Map();
    this.store = new CandleStore({ maxCandlesPerSeries: 500 });

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
        if (lc.direction === "CALL") audioAlertManager.playCallAlert();
        else if (lc.direction === "PUT") audioAlertManager.playPutAlert();

        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
          try {
            chrome.runtime.sendMessage({
              type: "ORACLE_NEW_SIGNAL",
              signal: {
                id: lc.id,
                action: lc.direction,
                symbol: lc.pair,
                timeframeSeconds: lc.tf,
                candleTimestamp: lc.formingTs,
                targetTimestamp: lc.targetTs,
                probability: lc.snapshot?.probability ?? 0.5,
                tabId: this.tabId,
              },
            }).catch(() => {});
          } catch (_) {}
        }
        this.updatePanelDisplay();
      } else if (event === Phase.ENTRY_NOW || event === Phase.IN_TRADE) {
        this.updatePanelDisplay();
      } else if (event === Phase.SETTLED) {
        this.signalAuditor.settle(lc.id, {
          result: lc.result,
          entryPrice: lc.entryPrice,
          closePrice: lc.closePrice,
        });
        if (lc.result === "WIN" || lc.result === "LOSS") {
          this.registry.get(lc.pair).recordOutcome(lc.snapshot, lc.result === "WIN");
        }
        this.updatePanelDisplay();
      } else if (event === Phase.CANCELLED) {
        this.signalAuditor.cancel(lc.id, lc.reason);
        this.updatePanelDisplay();
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
    this.panel = typeof window !== "undefined" && window === window.top ? new DiagnosticPanel() : null;

    this.socketStatus = "desconectado";
    this.lastPrice = "---";
    this._lastLoggedPrice = null;
    this._lastState = null;
    this._lastSigKey = null;

    this.hasChildFrameData = false;
    this.lastChildFrameSyncAt = 0;
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
            logger.setContext({ tabId: this.tabId, symbol: this.currentSymbol });
          }
        });
      } catch (_) {}
    }

    // 1. Escuta eventos da Bridge
    initBridgeListener({
      onMarketEvent: (event) => this.handleMarketEvent(event),
      onSocketStatus: (info) => this.handleSocketStatus(info),
    });

    // 2. Se for o frame filho (gráfico), escuta respostas e também encaminha dados consolidados ao topo
    if (typeof window !== "undefined" && window !== window.top) {
      this.setupChildToParentBridge();
    }

    // 3. Se for a janela principal (top), escuta atualizações de frames filhos
    if (typeof window !== "undefined" && window === window.top) {
      this.setupParentFrameReceiver();
    }

    // 4. Verificação periódica de Heartbeat / Stale feed a cada 2.5s e loop contínuo do SignalLifecycle
    if (typeof window !== "undefined") {
      setInterval(() => {
        this.quality.checkStale(this.currentSymbol, this.timeframeSeconds);
        this.updatePanelDisplay();
      }, 2500);

      setInterval(() => {
        this.tickLifecycle();
      }, 250);
    }

    logger.info("SISTEMA", `Analyzer ativo em ${typeof window !== "undefined" && window === window.top ? "janela principal" : "iframe gráfico"}`);
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
    const pair = this.currentSymbol;
    const tf = this.timeframeSeconds;

    if (tf !== LIFECYCLE.SUPPORTED_TF_SEC) {
      this.currentLifecycleSnapshot = { status: "TF_NOT_SUPPORTED" };
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
      this.processHistoryPayload(event.payload);
    } else {
      this.processRealtimePayload(event.payload);
    }
  }

  processHistoryPayload(payload) {
    const bars = normalizeHistoryBars(payload, this.currentSymbol, this.timeframeSeconds);
    if (!bars || bars.length === 0) return;

    // Se o payload indicar outro ativo, atualiza
    const detectedSym = bars[0].symbol;
    if (detectedSym && detectedSym !== this.currentSymbol) {
      this.currentSymbol = detectedSym;
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
    this.notifyParentIfInFrame();
  }

  processRealtimePayload(payload) {
    const rawSym = payload.pair || payload.symbol;
    const incomingSym = (rawSym && typeof rawSym === "string") ? rawSym.trim().toUpperCase() : this.currentSymbol;
    if (incomingSym) {
      const isNew = !this.activeSymbols.has(incomingSym);
      this.activeSymbols.add(incomingSym);
      if (isNew) {
        logger.info("FEED", `Ativo registrado no feed: ${incomingSym}`);
        if (!this.currentSymbol || this.currentSymbol === "EURUSD") {
          this.currentSymbol = incomingSym;
          logger.setContext({ symbol: this.currentSymbol, tabId: this.tabId });
        }
      }
      if (this.quality.getState(incomingSym, this.timeframeSeconds) === MarketState.BOOTING) {
        const existingCount = this.store.getCandles(incomingSym, this.timeframeSeconds, 150).length;
        if (existingCount >= this.quality.minHistoryBars) {
          this.quality.onHistoryLoaded(incomingSym, this.timeframeSeconds, existingCount);
          this.quality.onRealtimeUpdate(incomingSym, this.timeframeSeconds, { status: "UPDATED" });
        } else {
          this.quality.onStartHistorySync(incomingSym, this.timeframeSeconds);
        }
      }
    }

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
    this.notifyParentIfInFrame();
  }

  updatePanelDisplay() {
    if (
      typeof window !== "undefined" &&
      window === window.top &&
      this.hasChildFrameData &&
      Date.now() - this.lastChildFrameSyncAt < 10000
    ) {
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

      const qReport = this.registry.get(sym).evaluate({
        symbol: sym,
        timeframeSeconds: this.timeframeSeconds,
        candles: closedCandles,
        microMetrics,
        isReady,
        gapCount: report.gapCount,
        isStale: report.state === MarketState.STALE,
      });

      const cSignal = this.strategy.evaluate({
        symbol: sym,
        timeframeSeconds: this.timeframeSeconds,
        candles: closedCandles,
        isReady,
      });

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
        action: displayAction,
        rawAction: qReport.action,
        strategyName: qReport.strategyName,
        subStrategy: qReport.subStrategy,
        correlationGroup: qReport.correlationGroup,
        timeframe: `${this.timeframeSeconds / 60} minuto(s)`,
        timeframeSeconds: this.timeframeSeconds,
        historyCount: closedCandles.length,
        lastCandleTime: lastTimeStr,
        lastPrice: symPrice,
        gaps: report.gapCount,
        state: isReady ? MarketState.READY : report.state,
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
        indicators: cSignal.indicators,
        candleTimestamp: lastCandle?.timestamp || Math.floor(marketClock.nowSec()),
        candleTimer: candleTimer.getState(),
        clockOffsetMs: marketClock.offsetMs,
        isSoundEnabled: audioAlertManager.isSoundEnabled(),
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
      clockOffsetMs: marketClock.offsetMs,
      symbols: symbolsMap,
      allSymbols: Object.keys(symbolsMap),
    };

    if (this.panel) {
      this.panel.update(stateObj);
    }

    this.saveMarketStateToStorage(stateObj, symbolsMap);
  }

  saveMarketStateToStorage(stateObj, symbolsMap = {}) {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    try {
      const currentSym = stateObj.symbol || this.currentSymbol;

      // 1. Grava no storage isolado exclusivo desta aba (se tabId estiver identificado)
      if (this.tabId) {
        chrome.storage.local.set({
          [`oracleMarketState_tab_${this.tabId}`]: {
            ...stateObj,
            tabId: this.tabId,
            windowId: this.windowId,
          },
        });
      }

      // 2. Mescla no estado compartilhado com isolamento por aba e símbolo
      chrome.storage.local.get(["oracleMarketState"], (res) => {
        const prev = res?.oracleMarketState || {};
        const prevSymbols = prev.symbols || {};
        const prevTabs = prev.tabs || {};

        const mergedSymbols = {
          ...prevSymbols,
          ...symbolsMap,
          [currentSym]: {
            ...(prevSymbols[currentSym] || {}),
            ...stateObj,
            symbol: currentSym,
          },
        };

        const mergedTabs = { ...prevTabs };
        if (this.tabId) {
          mergedTabs[this.tabId] = {
            tabId: this.tabId,
            windowId: this.windowId,
            symbol: currentSym,
            lastPrice: stateObj.lastPrice || "---",
            state: stateObj.state || "BOOTING",
            updatedAt: Date.now(),
          };
        }

        const mergedState = {
          ...prev,
          // Mantém símbolo ativo anterior ou o atual caso não haja
          symbol: prev.symbol || currentSym,
          symbols: mergedSymbols,
          allSymbols: Object.keys(mergedSymbols),
          tabs: mergedTabs,
          lastUpdatedTab: this.tabId || prev.lastUpdatedTab,
        };

        chrome.storage.local.set({ oracleMarketState: mergedState });
      });
    } catch (e) {}
  }

  notifyParentIfInFrame() {
    if (typeof window === "undefined" || window === window.top) return;

    const report = this.quality.getReport(this.currentSymbol, this.timeframeSeconds);
    const lastCandle = this.store.getLast(this.currentSymbol, this.timeframeSeconds);
    const candlesCount = this.store.getCandles(this.currentSymbol, this.timeframeSeconds, 500).length;

    try {
      window.parent.postMessage(
        {
          type: "ORACLE_INTERNAL_FRAME_SYNC",
          data: {
            symbol: this.currentSymbol,
            timeframeSeconds: this.timeframeSeconds,
            state: report.state,
            wsStatus: this.socketStatus,
            lastPrice: this.lastPrice,
            lastTimestamp: lastCandle?.timestamp,
            historyCount: candlesCount,
            gapCount: report.gapCount,
            lifecycle: this.currentLifecycleSnapshot || this.lifecycle?.snapshot(this.currentSymbol, this.timeframeSeconds, marketClock.nowSec()),
            // Portfólio das 5 Estratégias
            quantAction: this.quantReport?.action || "WAIT",
            quantLabel: this.quantReport?.label || "AGUARDAR",
            quantProbability: this.quantReport?.probability || 0.50,
            quantEV: this.quantReport?.ev || 0,
            isConfluence: this.quantReport?.isConfluence || false,
            confluence: this.quantReport?.confluence || null,
            isDivergent: this.quantReport?.isDivergent || false,
            strategiesResults: this.quantReport?.strategiesResults || [],
            quantReasons: this.quantReport?.reasons || [],
            payout: this.payout || 0.80,
            signalsHistory: this.signalAuditor.getSignals().slice(0, 20),
            stats: this.signalAuditor.getStats(),
            // Legado
            signal: this.quantReport?.action !== "WAIT" ? this.quantReport?.action : this.currentSignal?.action || "WAIT",
            signalLabel: this.quantReport?.action !== "WAIT" ? this.quantReport?.label : this.currentSignal?.label || "AGUARDAR",
            signalReasons: this.quantReport?.action !== "WAIT" ? this.quantReport?.reasons : this.currentSignal?.reasons || [],
            indicators: this.currentSignal?.indicators || {},
          },
        },
        "*"
      );
    } catch (e) {}
  }

  get quantPortfolio() {
    return this.registry.get(this.currentSymbol);
  }

  setupChildToParentBridge() {
    // Encaminha logs emitidos no iframe do gráfico para a janela principal
    logger.subscribe((entry) => {
      if (!entry) return;
      try {
        window.parent.postMessage(
          {
            type: "ORACLE_INTERNAL_LOG_SYNC",
            entry,
          },
          "*"
        );
      } catch (e) {}
    });
  }

  setupParentFrameReceiver() {
    window.addEventListener("message", (event) => {
      if (!event.data) return;

      if (event.data.type === "ORACLE_INTERNAL_LOG_SYNC") {
        const entry = event.data.entry;
        if (entry && entry.tag && entry.message) {
          logger.add(entry.tag, entry.message, entry.level || "info", {
            id: entry.id,
            symbol: entry.symbol || this.currentSymbol,
            tabId: entry.tabId || this.tabId,
            skipConsole: true,
          });
        }
        return;
      }

      if (event.data.type === "ORACLE_SET_PAYOUT" && event.data.payout) {
        this.payout = event.data.payout;
        this.registry.setGlobalPayout(event.data.payout);
        this.updatePanelDisplay();
        return;
      }

      if (event.data.type !== "ORACLE_INTERNAL_FRAME_SYNC") return;
      const d = event.data.data;
      if (!d) return;

      this.hasChildFrameData = true;
      this.lastChildFrameSyncAt = Date.now();
      if (d.symbol && d.symbol !== this.currentSymbol) {
        this.currentSymbol = d.symbol;
      }
      if (d.lastPrice && d.lastPrice !== "---") {
        this.lastPrice = d.lastPrice;
      }

      let lastTimeStr = "--:--:--";
      if (d.lastTimestamp) {
        const dateObj = new Date(d.lastTimestamp * 1000);
        lastTimeStr = dateObj.toTimeString().split(" ")[0];
      }

      const stateObj = {
        frameStatus: "iframe conectado",
        wsStatus: d.wsStatus || "conectado",
        symbol: d.symbol || this.currentSymbol,
        timeframe: `${(d.timeframeSeconds || 60) / 60} minuto(s)`,
        historyCount: d.historyCount || 0,
        lastCandleTime: lastTimeStr,
        lastPrice: d.lastPrice || "---",
        gaps: d.gapCount || 0,
        state: d.state || "SYNCING",
        // Portfólio das 5 Estratégias
        quantAction: d.quantAction || "WAIT",
        quantLabel: d.quantLabel || "AGUARDAR",
        quantProbability: d.quantProbability || 0.50,
        quantEV: d.quantEV || 0,
        isConfluence: d.isConfluence || false,
        confluence: d.confluence || null,
        isDivergent: d.isDivergent || false,
        strategiesResults: d.strategiesResults || [],
        quantReasons: d.quantReasons || [],
        payout: d.payout || 0.80,
        // Histórico de Sinais Gravados e Auditoria
        signalsHistory: d.signalsHistory || [],
        stats: d.stats || {},
        // Legado
        signal: d.signal || "WAIT",
        signalLabel: d.signalLabel || "AGUARDAR",
        signalReasons: d.signalReasons || [],
        indicators: d.indicators || {},
        updatedAt: Date.now(),
      };

      if (this.panel) {
        this.panel.update(stateObj);
      }

      this.saveMarketStateToStorage(stateObj);
    });

    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === "ORACLE_SET_PAYOUT" && msg.payout) {
          this.payout = msg.payout;
          this.registry.setGlobalPayout(msg.payout);
          this.updatePanelDisplay();
        }
      });
    }
  }
}

// Inicialização automática do Analyzer no content script
if (typeof window !== "undefined") {
  window.__oracleAnalyzer = new MarketAnalyzer();
}
