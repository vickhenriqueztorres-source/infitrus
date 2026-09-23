import { ES, translateReason, translateRegime } from "./i18n/es.js";

const CONNECTING = new Set(["BOOTING", "WAITING_FOR_FRAME", "CONNECTING"]);
const CALIBRATING = new Set(["SYNCING", "SYNCING_HISTORY", "SYNCING_REALTIME"]);
const SCANNING = new Set(["READY", "CANDLE_UPDATING", "CANDLE_CLOSED"]);
const BLOCKED = new Set(["STALE", "DATA_GAP", "INVALID_DATA", "FORMAT_CHANGED", "RECONNECTING", "ERROR"]);

const BLOCKED_WHISPERS = Object.freeze({
  STALE: "Datos congelados. No operar.",
  DATA_GAP: "Faltan velas. Recalibrando…",
  INVALID_DATA: "Datos inválidos detectados.",
  FORMAT_CHANGED: "La plataforma cambió. Revisando…",
  RECONNECTING: "Señal perdida. Reconectando…",
  ERROR: "Error interno. Revisa Sistema.",
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatNumber(value, digits = 1) {
  return finite(value).toLocaleString("es-419", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function timeframeLabel(data) {
  if (Number.isFinite(Number(data.timeframeSeconds))) {
    const seconds = Number(data.timeframeSeconds);
    return seconds % 60 === 0 ? `M${seconds / 60}` : `${seconds}s`;
  }
  const raw = String(data.timeframe || "M1");
  const match = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return "M1";
  return `M${String(match[1]).replace(",", ".")}`;
}

function signalDirection(data) {
  const action = String(data.quantAction || data.signal || "WAIT").toUpperCase();
  if (action === "BUY" || action === "CALL") return "CALL";
  if (action === "SELL" || action === "PUT") return "PUT";
  return null;
}

function latestSignal(data, direction) {
  const rows = Array.isArray(data.signalsHistory) ? data.signalsHistory : [];
  return rows.find((row) => !direction || row.direction === direction) || null;
}

function makeSignal(data, timer, now, debugState) {
  const lc = data.lifecycle;
  if (lc) {
    const current = lc.current;
    const trade = lc.trade;
    const lastResult = lc.lastResult;

    let item = null;
    if (trade && (trade.phase === "ENTRY_NOW" || trade.phase === "IN_TRADE")) {
      item = trade;
    } else if (current && current.phase === "PRE_SIGNAL") {
      item = current;
    } else if (lastResult && lastResult.phase === "SETTLED") {
      item = lastResult;
    } else if (current && current.phase === "CANCELLED") {
      item = current;
    }

    if (item && item.direction) {
      const phaseMap = {
        PRE_SIGNAL: "PRE-SEÑAL",
        ENTRY_NOW: "ENTRA AHORA",
        IN_TRADE: "EN OPERACIÓN",
        SETTLED: item.result || "FINALIZADO",
        CANCELLED: "SEÑAL CANCELADA",
      };

      const direction = item.direction;
      const recordedAt = item.lockedAt ? item.lockedAt * 1000 : finite(data.updatedAt, now);
      return {
        id: item.id || `${direction}:${recordedAt}`,
        direction,
        arrow: direction === "CALL" ? "▲" : "▼",
        phase: item.phase === "PRE_SIGNAL" || item.phase === "ENTRY_NOW" ? "live" : item.phase.toLowerCase(),
        rawPhase: item.phase,
        phaseLabel: phaseMap[item.phase] || "ANALIZANDO",
        result: item.result,
        reason: item.reason,
        probability: item.probability,
        validRemainingSec: Math.max(0, finite(timer.remainingSeconds, 60)),
        progress: Math.max(0, Math.min(1, finite(timer.progressPct, 0) / 100)),
        recordedAt,
      };
    }
  }

  const direction = signalDirection(data);
  if (!direction && debugState !== "SENAL") return null;
  const effectiveDirection = direction || "CALL";
  const record = latestSignal(data, effectiveDirection);
  const recordedAt = finite(record?.recordedAt, finite(data.updatedAt, now));
  const ageSec = Math.max(0, (now - recordedAt) / 1000);
  const timeframeSeconds = Math.max(1, finite(record?.timeframeSeconds, 60));
  const debugLive = debugState === "SENAL";
  const phase = debugLive || ageSec <= 5 ? "live" : ageSec < timeframeSeconds ? "expired" : null;
  if (!phase) return null;
  const remaining = phase === "live" ? Math.max(0, Math.ceil(5 - ageSec)) : 0;
  return {
    id: record?.id || `${effectiveDirection}:${recordedAt}`,
    direction: effectiveDirection,
    arrow: effectiveDirection === "CALL" ? "▲" : "▼",
    phase,
    phaseLabel: phase === "live" ? "PRE-SEÑAL" : "FINALIZADO",
    validRemainingSec: debugLive ? 5 : remaining,
    progress: phase === "live" ? (debugLive ? 1 : remaining / 5) : 0,
    recordedAt,
  };
}

function makeChecklist(data, signal, debug = false) {
  const source = Array.isArray(data.quantReasons) && data.quantReasons.length
    ? data.quantReasons
    : Array.isArray(data.signalReasons)
      ? data.signalReasons
      : [];
  const translated = source.map((reason) => translateReason(reason, { debug }));
  const fallback = signal?.direction === "PUT"
    ? ["EMA 9 cruzó bajo EMA 21", "RSI < 50", "Vela confirmada"]
    : ["EMA 9 cruzó EMA 21", "RSI > 50", "Vela confirmada"];
  const labels = translated.length ? translated : fallback;
  return labels.slice(0, 3).map((label, index) => ({
    label,
    status: signal?.phase === "live" ? "ok" : signal?.phase === "expired" ? "fail" : index === 0 && translated.length ? "ok" : "pending",
  }));
}

function feedState(data, technicalState) {
  const socket = String(data.wsStatus || "").toLowerCase();
  if (!data.updatedAt && technicalState === "BOOTING") return ES.noData;
  if (BLOCKED.has(technicalState) || !socket.includes("conect")) return ES.unstable;
  return ES.stable;
}

function statusFor(technicalState, visualState) {
  if (technicalState === "ERROR") return "coral";
  if (visualState === "CONECTANDO" || visualState === "CALIBRANDO" || visualState === "BLOQUEADO") return "amber";
  return "teal";
}

export function createViewModel(data = {}, timer = {}, options = {}) {
  const now = finite(options.now, Date.now());
  const debugState = options.debugState || null;
  let technicalState = String(data.state || "BOOTING").toUpperCase();
  if (!CONNECTING.has(technicalState) && !CALIBRATING.has(technicalState) && !SCANNING.has(technicalState) && !BLOCKED.has(technicalState)) {
    technicalState = technicalState === "SENAL" ? "READY" : "CONNECTING";
  }

  let visualState = CONNECTING.has(technicalState)
    ? "CONECTANDO"
    : CALIBRATING.has(technicalState)
      ? "CALIBRANDO"
      : BLOCKED.has(technicalState)
        ? "BLOQUEADO"
        : "ESCANEANDO";

  if (debugState) visualState = debugState;
  const signal = visualState === "BLOQUEADO" || visualState === "CONECTANDO" || visualState === "CALIBRANDO"
    ? null
    : makeSignal(data, timer, now, debugState);
  if (signal) visualState = "SENAL";

  const historyCount = Math.max(0, finite(data.historyCount));
  const calibrationNeed = 15;
  const remaining = Math.max(0, finite(timer.remainingSeconds, 60));
  const candleProgress = Math.max(0, Math.min(1, finite(timer.progressPct) / 100));

  let title = ES.scanning;
  let whisper = ES.marketNoise;
  let wave = "noise";
  if (visualState === "CONECTANDO") {
    title = ES.connecting;
    whisper = ES.searchingTransmission;
    wave = "flat";
  } else if (visualState === "CALIBRANDO") {
    title = ES.calibrating;
    whisper = `${historyCount}/${calibrationNeed} velas sincronizadas.`;
    wave = "analyzing";
  } else if (visualState === "BLOQUEADO") {
    title = ES.blocked;
    whisper = BLOCKED_WHISPERS[technicalState] || "Datos inestables. No operar.";
    wave = "broken";
  } else if (signal) {
    title = ES.intercepted;
    whisper = signal.phase === "expired" ? ES.windowClosed : ES.transmissionIntercepted;
    wave = signal.phase === "expired" ? "flat" : "locked";
  }

  const payout = finite(data.payout, 0.8);
  const indicators = data.indicators || {};
  const probability = finite(data.quantProbability, 0.5);
  const quality = finite(data.quality, 0.5);
  const edge = finite(data.edge, finite(data.quantEV));
  const strategies = Array.isArray(data.strategiesResults) ? data.strategiesResults : [];
  const micro = data.microstructure || {};
  const stats = data.stats || {};

  const vm = {
    visualState,
    technicalState,
    statusDot: statusFor(technicalState, visualState),
    asset: String(data.symbol || "---").toUpperCase(),
    timeframe: timeframeLabel(data),
    wave,
    whisper,
    title,
    signal,
    countdown: {
      secondsToCandleClose: remaining,
      formatted: `0:${String(remaining).padStart(2, "0")}`,
      progress: signal?.phase === "live" ? signal.progress : candleProgress,
      urgent: Boolean(signal?.phase === "live" && signal.validRemainingSec <= 2),
    },
    calibration: visualState === "CALIBRANDO" ? {
      have: historyCount,
      need: calibrationNeed,
      progress: Math.min(1, historyCount / calibrationNeed),
    } : null,
    checklist: makeChecklist(data, signal, Boolean(options.debug)),
    checklistExtra: Math.max(0, (Array.isArray(data.quantReasons) ? data.quantReasons.length : 0) - 3),
    context: {
      price: data.lastPrice === "---" || data.lastPrice == null ? "—" : String(data.lastPrice),
      payout: Math.round(payout * 100),
      feed: feedState(data, technicalState),
    },
    registro: {
      winRate: finite(stats.winRate),
      wins: finite(stats.wins),
      losses: finite(stats.losses),
      rows: Array.isArray(data.signalsHistory) ? data.signalsHistory.slice(0, 20) : [],
    },
    mercado: {
      ema9: indicators.ema9,
      ema21: indicators.ema21,
      rsi14: indicators.rsi14,
      probability,
      edge,
      quality,
      breakEven: 1 / (1 + payout),
      strategies,
      pressure: finite(micro.tickPressure ?? micro.directionalPressure ?? micro.pressure, 0),
      regime: translateRegime(data.regime),
      lastCandle: data.lastCandleTime || "—",
      dataAge: data.updatedAt ? Math.max(0, Math.round((now - finite(data.updatedAt, now)) / 1000)) : null,
    },
    sistema: {
      websocket: String(data.wsStatus || ES.noData),
      history: historyCount,
      gaps: finite(data.gaps),
      technicalState,
    },
    debug: Boolean(options.debug),
  };

  if (options.debug && typeof console !== "undefined") console.debug("[inflitrus] vm", vm);
  return vm;
}

export const __private__ = { BLOCKED_WHISPERS, signalDirection, timeframeLabel, formatNumber };
