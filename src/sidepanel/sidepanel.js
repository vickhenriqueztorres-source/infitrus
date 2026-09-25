import { audioAlertManager } from "../utils/audio-alerts.js";
import { candleTimer } from "../utils/candle-timer.js";
import { MarketClock } from "../utils/market-clock.js";
import { createViewModel } from "../ui/view-model.js";
import { WaveRenderer } from "../ui/wave.js";
import { translateLogMessage, translateLogTag } from "../ui/components/layout.js";
import { selectTabView } from "../ui/tab-view-selector.js";
import { soundsForTransition } from "../ui/sound-transitions.js";
import { formatLifecycleCard } from "../ui/lifecycle-card.js";
import { rec, configureFlightRecorder, generateUUID } from "../diagnostics/flight-recorder.js";
import { signalStore } from "../storage/signal-store.js";

const panelInstanceId = generateUUID();
configureFlightRecorder({
  ctx: "sidepanel",
  instanceId: panelInstanceId,
});

const localMarketClock = new MarketClock();
const NOTIFICATIONS_KEY = "ifx_notifications_v1";
let wave;
let currentLogs = [];
let boundTabId = null;
let boundWindowId = null;
let currentWindowLabel = "Ventana 1";
let isBoundTabB2 = false;
let activeMainTab = "signal"; // 'signal' | 'quant' | 'logs'
let activeSignalData = null;
let lastLifecycle = null;
let lastRenderedSeq = null;
let lastRenderedSignalSeq = 0;
const playedSoundSet = new Set();

function sendToBoundTab(message) {
  if (boundTabId == null) return;
  try {
    const pending = chrome.tabs.sendMessage(boundTabId, message);
    pending?.catch?.(() => {});
  } catch (_) {}
}

/**
 * Atualiza o rótulo identificador amigável da janela (Ventana 1, Ventana 2, ...)
 */
async function updateWindowLabel() {
  if (!boundWindowId || typeof chrome === "undefined" || !chrome.windows?.getAll) {
    currentWindowLabel = boundWindowId ? `Ventana ${boundWindowId}` : "Ventana 1";
    return;
  }
  try {
    const wins = await chrome.windows.getAll();
    const sorted = wins.sort((a, b) => a.id - b.id);
    const idx = sorted.findIndex((w) => w.id === boundWindowId);
    currentWindowLabel = idx >= 0 ? `Ventana ${idx + 1}` : `Ventana ${boundWindowId}`;
  } catch (_) {
    currentWindowLabel = `Ventana ${boundWindowId}`;
  }
  const winTag = document.getElementById("window-tag");
  if (winTag) winTag.textContent = currentWindowLabel;
}

/**
 * Alterna as abas principais do Side Panel: [Sinal] | [Análise Quant] | [Logs]
 */
function switchMainTab(tabName) {
  activeMainTab = tabName;
  const tabs = ["signal", "quant", "logs"];
  tabs.forEach((t) => {
    const btn = document.getElementById(`tab-btn-${t}`);
    const pane = document.getElementById(`view-${t}`);
    if (btn) btn.classList.toggle("is-active", t === tabName);
    if (pane) pane.style.display = t === tabName ? "block" : "none";
  });

  // Ao alternar para o Sinal, redimensiona a onda se necessário
  if (tabName === "signal" && wave) {
    wave.start();
  }
}

/**
 * Reproduz lista de efeitos sonoros
 */
function playSoundList(sounds = []) {
  if (!sounds || !sounds.length) return;
  for (const s of sounds) {
    const isDedup = playedSoundSet.has(s);
    rec("SOUND", { soundName: s, deduplicated: isDedup });
    if (s === "call") audioAlertManager.playCallAlert();
    else if (s === "put") audioAlertManager.playPutAlert();
    else if (s === "pip") audioAlertManager.playCountdownPip(1);
    else if (s === "entry") audioAlertManager.playCountdownPip(0);
  }
}

/**
 * Atualiza o cronômetro M1 e a barra de contagem regressiva desacoplado via localMarketClock (T-06)
 * Card principal = UMA frase por estado, sem mensagens contraditórias.
 */
function updateClockOnlyUI() {
  const nowSec = localMarketClock.nowSec();
  const lifecycleData = activeSignalData?.lifecycle || lastLifecycle || {
    pair: activeSignalData?.symbol || "Mercado",
    tf: activeSignalData?.timeframeSeconds || 60,
  };

  const cardData = formatLifecycleCard(lifecycleData, nowSec);

  // 1. Classes do Card e acessibilidade aria-live (assertive em ENTRY_NOW, polite no resto)
  const card = document.getElementById("signal-card");
  if (card) {
    card.classList.remove("is-call", "is-put", "is-wait", "is-execute", "is-in-trade");
    card.setAttribute("aria-live", cardData.ariaLive);

    if (cardData.phase === "ENTRY_NOW") {
      card.classList.add("is-execute", cardData.direction === "CALL" ? "is-call" : "is-put");
    } else if (cardData.phase === "PRE_SIGNAL") {
      card.classList.add(cardData.direction === "CALL" ? "is-call" : "is-put");
    } else if (cardData.phase === "IN_TRADE") {
      card.classList.add("is-in-trade", cardData.direction === "CALL" ? "is-call" : "is-put");
    } else if (cardData.phase === "SETTLED") {
      card.classList.add(cardData.badgeClass === "call" ? "is-call" : cardData.badgeClass === "put" ? "is-put" : "is-wait");
    } else {
      card.classList.add("is-wait");
    }
  }

  // 2. Badge de Fase / Direção
  const badge = document.getElementById("signal-direction-badge");
  if (badge) {
    badge.className = `signal-badge ${cardData.badgeClass}`;
    badge.textContent = cardData.badgeText;
  }

  // 3. Cronômetro / Contagem Regressiva
  const timerBadge = document.getElementById("signal-timer-badge");
  if (timerBadge) {
    timerBadge.textContent = cardData.secondsRemaining !== null && cardData.secondsRemaining !== undefined
      ? `${cardData.secondsRemaining}s`
      : "00s";
    timerBadge.setAttribute("aria-label", cardData.ariaLabel);
    timerBadge.classList.toggle("warning", cardData.secondsRemaining <= 15 && cardData.secondsRemaining > 3);
    timerBadge.classList.toggle("prepare", cardData.secondsRemaining <= 3 && cardData.secondsRemaining > 0);
  }

  // 4. Ícone do Card
  const iconEl = document.getElementById("signal-icon");
  if (iconEl) {
    if (cardData.phase === "ENTRY_NOW" || cardData.phase === "PRE_SIGNAL" || cardData.phase === "IN_TRADE") {
      iconEl.textContent = cardData.direction === "CALL" ? "▲" : "▼";
    } else if (cardData.phase === "SETTLED") {
      iconEl.textContent = cardData.badgeClass === "call" ? "✓" : cardData.badgeClass === "put" ? "✗" : "―";
    } else {
      iconEl.textContent = "◎";
    }
  }

  // 5. Frase Principal Única e Linha Secundária
  const titleEl = document.getElementById("signal-title");
  if (titleEl) {
    titleEl.textContent = cardData.primaryText;
  }

  const subTitleEl = document.getElementById("signal-subtitle");
  if (subTitleEl) {
    subTitleEl.textContent = cardData.secondaryText || (activeSignalData?.subStrategy ? `Estrategia: ${activeSignalData.subStrategy}` : "");
  }

  // 6. Barra de Progresso ligada ao estado (não ao minuto cru)
  const progressBar = document.getElementById("signal-progress-bar");
  if (progressBar) {
    progressBar.style.width = `${Math.min(100, Math.max(0, cardData.progressPct))}%`;
  }

  // 7. Rótulo de Momento de Execução
  const timingLabel = document.getElementById("entry-timing-label");
  if (timingLabel) {
    if (cardData.phase === "ENTRY_NOW") {
      timingLabel.innerHTML = `<span style="color:#3FE0C5;font-weight:800;letter-spacing:0.05em">¡ENTRA AHORA EN LA APERTURA!</span>`;
    } else if (cardData.phase === "PRE_SIGNAL") {
      timingLabel.innerHTML = `AL SEGUNDO :00 DE LA PRÓXIMA VELA (en ${cardData.secondsRemaining}s)`;
    } else if (cardData.phase === "IN_TRADE") {
      if (cardData.secondsRemaining <= 2) {
        timingLabel.innerHTML = `<span style="font-weight:700;color:#F59E0B">FINALIZANDO OPERACIÓN (${cardData.secondsRemaining}s)</span>`;
      } else {
        timingLabel.innerHTML = `<span style="font-weight:700">OPERACIÓN EN CURSO (${cardData.secondsRemaining}s para expirar)</span>`;
      }
    } else if (cardData.phase === "SETTLED") {
      timingLabel.innerHTML = `OPERACIÓN LIQUIDADA (${cardData.badgeText})`;
    } else {
      timingLabel.innerHTML = `EN LA APERTURA DE LA PRÓXIMA VELA`;
    }
  }

  // 8. Pips nos segundos 57, 58 e 59 se houver PRE_SIGNAL ativo
  if (lastLifecycle?.current?.phase === "PRE_SIGNAL") {
    const sec = localMarketClock.secondInCandle(60);
    const pipSounds = soundsForTransition(lastLifecycle, lastLifecycle, sec, playedSoundSet);
    playSoundList(pipSounds);
  }
}

/**
 * Renderiza o Card Visual de Sinal M1
 */
function renderSignalCard(data) {
  activeSignalData = data;
  if (data?.lifecycle) {
    lastLifecycle = data.lifecycle;
  }

  const lc = data?.lifecycle;
  const isPre = lc?.current?.phase === "PRE_SIGNAL";
  const isTrade = lc?.trade && ["ENTRY_NOW", "IN_TRADE"].includes(lc.trade.phase);
  const activeItem = isPre ? lc.current : (isTrade ? lc.trade : null);

  const subStrategy = activeItem?.subStrategy || activeItem?.strategyName || (activeItem?.snapshot?.subStrategy || activeItem?.snapshot?.strategyName) || data?.subStrategy || data?.strategyName || "21 SUBESTRATEGIAS";
  const stratBadge = document.getElementById("signal-strategy-badge");
  if (stratBadge) {
    stratBadge.textContent = subStrategy.toUpperCase();
  }

  const prob = Number(
    activeItem?.conservativeProbability ??
    activeItem?.probability ??
    (activeItem?.snapshot?.conservativeProbability ?? activeItem?.snapshot?.probability) ??
    data?.conservativeProbability ??
    data?.probability ??
    data?.quantProbability ??
    0.5
  );
  const edge = Number(
    activeItem?.edge ??
    (activeItem?.snapshot?.edge) ??
    data?.edge ??
    0
  );
  const qual = Number(
    activeItem?.quality ??
    (activeItem?.snapshot?.quality) ??
    data?.quality ??
    0
  );
  const stats = data?.stats || {};
  const hasActiveSignal = Boolean(activeItem && activeItem.direction && activeItem.direction !== "WAIT");

  const probEl = document.getElementById("sig-prob");
  if (probEl) probEl.textContent = (hasActiveSignal || (data?.action && data.action !== "WAIT")) ? `${(prob * 100).toFixed(0)}%` : "--%";

  const edgeEl = document.getElementById("sig-edge");
  if (edgeEl) edgeEl.textContent = (hasActiveSignal || (data?.action && data.action !== "WAIT")) ? `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%` : "--%";

  const qualEl = document.getElementById("sig-qual");
  if (qualEl) qualEl.textContent = (hasActiveSignal || (data?.action && data.action !== "WAIT")) ? `${(qual * 100).toFixed(0)}%` : "--%";

  const wrEl = document.getElementById("sig-wr");
  if (wrEl) wrEl.textContent = stats.total > 0 ? `${Number(stats.winRate || 0).toFixed(0)}%` : "--%";

  updateClockOnlyUI();
}

/**
 * Renderiza a Aba de Análise Quantitativa Detalhada
 */
function renderQuantAnalysis(data) {
  if (!data) return;

  // 1. Radar Quantitativo
  const regimeEl = document.getElementById("q-regime");
  if (regimeEl) regimeEl.textContent = `RÉGIMEN: ${(data.regime || "NORMAL").toUpperCase()}`;

  const topSubEl = document.getElementById("q-top-substrat");
  if (topSubEl) topSubEl.textContent = data.subStrategy || data.strategyName || "---";

  const adjEdgeEl = document.getElementById("q-adj-edge");
  const edge = Number(data.edge ?? 0);
  if (adjEdgeEl) adjEdgeEl.textContent = `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`;

  const probConsEl = document.getElementById("q-prob-cons");
  const prob = Number(data.conservativeProbability || data.probability || 0.5);
  if (probConsEl) probConsEl.textContent = `${(prob * 100).toFixed(1)}%`;

  const uncertEl = document.getElementById("q-uncertainty");
  if (uncertEl) uncertEl.textContent = data.uncertainty != null ? Number(data.uncertainty).toFixed(3) : "0.000";

  // 2. As 5 Famílias de Estratégias
  const famTable = document.getElementById("families-table");
  const famActiveCountEl = document.getElementById("q-families-active");
  if (famTable) {
    const rawStrategies = Array.isArray(data.strategiesResults) ? data.strategiesResults : [];
    const stratMap = new Map();
    rawStrategies.forEach((s) => {
      if (s.id) stratMap.set(s.id, s);
      if (s.family) stratMap.set(s.family.toLowerCase(), s);
    });

    const standardFamilies = [
      { id: "continuation", label: "Continuación", defaultSub: "Impulse / Trend Thrust" },
      { id: "reversion", label: "Reversión", defaultSub: "Wick / Exaustión" },
      { id: "microstructure", label: "Microestructura", defaultSub: "Tick Pressure / Flow" },
      { id: "volatility_expansion", label: "Volatilidad", defaultSub: "Breakout / Expansion" },
      { id: "historical_analogy", label: "Analogía (KNN)", defaultSub: "Exact Pattern / Shape" },
    ];

    let activeCount = 0;
    famTable.replaceChildren();

    standardFamilies.forEach((f) => {
      const match = stratMap.get(f.id) || stratMap.get(f.id.replace("_", "")) || {};
      const action = match.action || "WAIT";
      const isAct = action === "CALL" || action === "PUT";
      if (isAct) activeCount++;

      const subName = match.subStrategy || match.name || f.defaultSub;
      const fProb = match.probability != null ? (Number(match.probability) * 100).toFixed(0) : "50";
      const fEdge = Number(match.edge || 0);

      const row = document.createElement("div");
      row.className = "family-row";

      const infoDiv = document.createElement("div");
      infoDiv.className = "family-info";
      infoDiv.innerHTML = `<span class="family-name">${f.label}</span><span class="family-sub">${subName}</span>`;

      const actDiv = document.createElement("div");
      actDiv.className = `family-action ${action}`;
      actDiv.textContent = action;

      const probDiv = document.createElement("div");
      probDiv.className = "family-prob";
      probDiv.textContent = `${fProb}%`;

      const edgeDiv = document.createElement("div");
      edgeDiv.className = `family-edge ${fEdge > 0 ? "positive" : "neutral"}`;
      edgeDiv.textContent = `${fEdge > 0 ? "+" : ""}${(fEdge * 100).toFixed(1)}%`;

      row.append(infoDiv, actDiv, probDiv, edgeDiv);
      famTable.appendChild(row);
    });

    if (famActiveCountEl) {
      famActiveCountEl.textContent = `${activeCount}/5 activas`;
    }
  }

  // 3. Microestrutura
  const micro = data.microstructure || {};
  const velEl = document.getElementById("m-vel");
  if (velEl) velEl.textContent = `${Number(micro.tickVelocity || 0).toFixed(1)} t/s`;

  const buyEl = document.getElementById("m-buy");
  if (buyEl) buyEl.textContent = `${Math.round(Number(micro.buyerPressure ?? 0.5) * 100)}%`;

  const ticksEl = document.getElementById("m-ticks");
  if (ticksEl) ticksEl.textContent = String(micro.candleTickCount || 0);

  const accEl = document.getElementById("m-acc");
  if (accEl) accEl.textContent = Number(micro.velocityAcceleration || 0).toFixed(2);

  // 4. Auditoria
  const stats = data.stats || {};
  const audWrEl = document.getElementById("aud-wr");
  if (audWrEl) audWrEl.textContent = `${Number(stats.winRate || 0).toFixed(1)}%`;

  const audScoreEl = document.getElementById("aud-score");
  if (audScoreEl) audScoreEl.textContent = `${stats.wins || 0}W / ${stats.losses || 0}L`;

  const audPnlEl = document.getElementById("aud-pnl");
  const pnl = Number(stats.netProfitUnits || 0);
  if (audPnlEl) audPnlEl.textContent = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)} un`;

  const audDojisEl = document.getElementById("aud-dojis");
  if (audDojisEl) audDojisEl.textContent = String(stats.dojis || 0);

  // 5. Evidências / Gatilhos
  const reasonsList = document.getElementById("q-reasons-list");
  if (reasonsList) {
    reasonsList.replaceChildren();
    const reasons = data.quantReasons || data.signalReasons || data.reasons || [];
    if (!reasons.length) {
      const li = document.createElement("li");
      li.textContent = "Esperando formación estadística del mercado...";
      reasonsList.appendChild(li);
    } else {
      reasons.slice(0, 5).forEach((r) => {
        const li = document.createElement("li");
        li.textContent = r;
        reasonsList.appendChild(li);
      });
    }
  }
}

/**
 * Renderiza o Histórico de Sinais da aba vinculada (R4, R7, I-01, T-06)
 * Cancelados aparecem riscados, com o motivo, e não contam no placar.
 */
function renderSignalsHistory(signals = []) {
  const list = document.getElementById("signals-history-list");
  const countBadge = document.getElementById("history-count");
  if (!list) return;

  const rawList = Array.isArray(signals) ? signals : [];

  // R4, R7: Filtragem transacional estrita
  const validSignals = [];
  for (const sig of rawList) {
    if (sig.committed === false) {
      rec("SIGNAL_SKIP_NOT_COMMITTED", { id: sig.id, seq: sig.seq });
      continue;
    }

    if (Number.isFinite(sig.seq)) {
      if (sig.seq < lastRenderedSignalSeq) {
        rec("SEQ_GAP", { id: sig.id, seq: sig.seq, lastRenderedSeq: lastRenderedSignalSeq });
        continue;
      }
      if (sig.seq > lastRenderedSignalSeq) {
        lastRenderedSignalSeq = sig.seq;
      }
    }

    validSignals.push(sig);
  }

  if (countBadge) countBadge.textContent = `${validSignals.length} señales`;

  if (!validSignals.length) {
    list.innerHTML = `<p class="logs-empty">Ninguna señal liquidada aún en esta sesión.</p>`;
    return;
  }

  // Compara IDs para evitar re-renderização se idêntico (R4)
  const currentIds = validSignals.slice(0, 20).map((s) => s.id || `${s.symbol}:${s.candleTimestamp}`).join("|");
  if (list.dataset.renderedIds === currentIds) {
    return;
  }
  list.dataset.renderedIds = currentIds;

  list.replaceChildren();
  validSignals.slice(0, 20).forEach((sig) => {
    const row = document.createElement("div");
    const isCancelled = sig.result === "CANCELLED" || sig.status === "CANCELLED";
    row.className = `history-row ${isCancelled ? "is-cancelled" : ""}`;

    const time = document.createElement("time");
    time.textContent = sig.timeFormatted || (sig.candleTimestamp ? new Date(sig.candleTimestamp * 1000).toTimeString().slice(0, 5) : "--:--");

    const pair = document.createElement("span");
    pair.style.cssText = "font-weight:600;color:var(--ice);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    pair.textContent = sig.symbol || sig.pair || "---";

    const dirBadge = document.createElement("span");
    dirBadge.style.cssText = `font-weight:700;color:${sig.action === "CALL" || sig.direction === "CALL" ? "#3FE0C5" : "#FF5A6E"}`;
    dirBadge.textContent = sig.action || sig.direction || "---";

    const detail = document.createElement("span");
    detail.className = "history-desc";
    detail.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--steel);font-size:8px;";

    if (isCancelled) {
      const reason = sig.reason || sig.cancelReason || "datos inestables";
      const reasonText = reason === "ASSET_CHANGED" ? "cambio de activo" : "datos inestables";
      detail.textContent = `Cancelada (${reasonText})`;
      detail.style.textDecoration = "line-through";
    } else {
      const entryP = Number.isFinite(sig.entryPrice) ? Number(sig.entryPrice).toFixed(5) : "---";
      const closeP = Number.isFinite(sig.closePrice) ? Number(sig.closePrice).toFixed(5) : "---";
      detail.textContent = `${entryP} → ${closeP}`;
    }

    const resBadge = document.createElement("span");
    const res = isCancelled ? "CANCELADA" : (sig.result || sig.status || "PENDING");
    const resClass = res === "WIN" || res === "GANADA" ? "WIN" : res === "LOSS" || res === "PERDIDA" ? "LOSS" : res === "DOJI" ? "DOJI" : "PENDING";
    resBadge.className = `history-badge ${resClass}`;
    resBadge.textContent = res;

    row.append(time, pair, dirBadge, detail, resBadge);
    list.appendChild(row);
  });
}

/**
 * Renderiza logs filtrados estritamente pela aba da janela
 */
function renderLogs(logs = []) {
  const rawLogs = Array.isArray(logs) ? logs : [];

  const seenIds = new Set();
  const deduped = [];
  for (const entry of rawLogs) {
    if (entry.id && seenIds.has(entry.id)) continue;
    if (entry.id) seenIds.add(entry.id);

    const last = deduped[deduped.length - 1];
    if (last && last.tag === entry.tag && last.message === entry.message && Math.abs((entry.timeMs || 0) - (last.timeMs || 0)) < 300) {
      continue;
    }
    deduped.push(entry);
  }

  currentLogs = deduped.slice(-80);
  const list = document.getElementById("logs-list");
  if (!list) return;

  list.replaceChildren();
  if (!currentLogs.length) {
    const empty = document.createElement("p");
    empty.className = "logs-empty";
    empty.textContent = "Esperando eventos del sistema…";
    list.appendChild(empty);
    return;
  }

  currentLogs.slice(-40).reverse().forEach((entry) => {
    const row = document.createElement("div");
    const level = ["success", "warn", "error"].includes(entry.level) ? entry.level : "info";
    row.className = `log-row is-${level}`;
    const time = document.createElement("time");
    time.textContent = String(entry.time || "").split(".")[0];
    const tag = document.createElement("b");
    tag.textContent = `[${translateLogTag(entry.tag)}]`;
    const message = document.createElement("span");
    message.textContent = translateLogMessage(entry.message || "");
    row.append(time, tag, message);
    list.appendChild(row);
  });
}

/**
 * Exibe aviso quando a aba ativa desta janela não é da corretora B2Trading (I-01, I-02)
 */
function showOpenB2Notice() {
  const copyEl = document.getElementById("status-copy");
  if (copyEl) copyEl.textContent = "Abre B2Trading en esta ventana";

  const dotEl = document.getElementById("status-dot");
  if (dotEl) dotEl.className = "dot amber";

  const assetEl = document.getElementById("asset");
  if (assetEl) assetEl.textContent = "---";

  const tfEl = document.getElementById("timeframe");
  if (tfEl) tfEl.textContent = "M1";

  const winTag = document.getElementById("window-tag");
  if (winTag) winTag.textContent = currentWindowLabel;

  const feedCopyEl = document.getElementById("feed-copy");
  if (feedCopyEl) feedCopyEl.textContent = "Sin datos";

  const feedDotEl = document.getElementById("feed-dot");
  if (feedDotEl) feedDotEl.className = "dot amber";

  renderSignalCard({ symbol: "---", action: "WAIT" });
  renderSignalsHistory([]);
  renderLogs([]);
}

let panelSelectedSymbol = null;

function renderMultiAssetBar(state, allSymbols = [], currentSelected) {
  const barEl = document.getElementById("multi-asset-bar");
  const pillsEl = document.getElementById("multi-asset-pills");
  if (!barEl || !pillsEl) return;

  if (!allSymbols || allSymbols.length <= 1) {
    barEl.style.display = "none";
    return;
  }

  barEl.style.display = "flex";
  pillsEl.innerHTML = "";

  allSymbols.forEach((sym) => {
    const symData = state.symbols?.[sym] || {};
    const isActive = sym === currentSelected;
    const isTradeActive = symData.lifecycle?.trade?.phase === "IN_TRADE" || symData.lifecycle?.trade?.phase === "ENTRY_NOW";
    const tradeDir = symData.lifecycle?.trade?.direction;
    const preSigDir = symData.lifecycle?.current?.phase === "PRE_SIGNAL" ? symData.lifecycle?.current?.direction : null;
    const action = preSigDir || symData.action || (isTradeActive ? tradeDir : symData.lifecycle?.current?.direction) || "WAIT";
    const phase = symData.lifecycle?.current?.phase === "PRE_SIGNAL"
      ? "PRE_SIGNAL"
      : (symData.lifecycle?.trade?.phase || symData.lifecycle?.current?.phase || "SCANNING");
    const isExpiring = phase === "IN_TRADE" && (symData.lifecycle?.trade?.secondsRemaining ?? 60) <= 2;
    const hasSignal = phase === "PRE_SIGNAL" || phase === "ENTRY_NOW" || (phase === "IN_TRADE" && !isExpiring);

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = `asset-pill ${isActive ? "is-active" : ""}`;

    const dot = document.createElement("span");
    dot.className = `pill-dot ${action === "CALL" ? "call" : action === "PUT" ? "put" : ""}`;
    if (hasSignal) dot.classList.add("pulse");

    const label = document.createElement("span");
    label.textContent = sym;

    pill.appendChild(dot);
    pill.appendChild(label);

    if (hasSignal && action !== "WAIT") {
      const tag = document.createElement("small");
      tag.style.fontSize = "8px";
      tag.style.fontWeight = "800";
      tag.style.marginLeft = "3px";
      tag.textContent = action;
      pill.appendChild(tag);
    }

    pill.addEventListener("click", () => {
      panelSelectedSymbol = sym;
      sendToBoundTab({ type: "ORACLE_SELECT_SYMBOL", symbol: sym });
      refreshWindowState();
    });

    pillsEl.appendChild(pill);
  });
}

function renderCrossAssetAlert(state, currentSelected) {
  const alertEl = document.getElementById("cross-asset-alert");
  const msgEl = document.getElementById("cross-asset-msg");
  const btnEl = document.getElementById("cross-asset-btn");
  if (!alertEl || !msgEl || !btnEl) return;

  if (!state.symbols) {
    alertEl.style.display = "none";
    return;
  }

  let alertAsset = null;
  let alertAction = null;
  let alertProb = null;

  for (const [sym, data] of Object.entries(state.symbols)) {
    if (sym === currentSelected) continue;
    const phase = data.lifecycle?.trade?.phase || data.lifecycle?.current?.phase;
    const action = data.action || data.lifecycle?.current?.direction;
    if ((phase === "PRE_SIGNAL" || phase === "ENTRY_NOW") && (action === "CALL" || action === "PUT")) {
      alertAsset = sym;
      alertAction = action;
      alertProb = data.quantProbability ? Math.round(data.quantProbability * 100) : null;
      break;
    }
  }

  if (alertAsset) {
    alertEl.style.display = "flex";
    alertEl.className = `cross-asset-alert ${alertAction === "CALL" ? "call" : "put"}`;
    msgEl.textContent = `⚡ Señal en ${alertAsset}: ${alertAction} ${alertProb ? `(${alertProb}%)` : ""}`;
    btnEl.textContent = `Ver ${alertAsset}`;
    btnEl.onclick = () => {
      panelSelectedSymbol = alertAsset;
      sendToBoundTab({ type: "ORACLE_SELECT_SYMBOL", symbol: alertAsset });
      refreshWindowState();
    };
  } else {
    alertEl.style.display = "none";
  }
}

/**
 * Renderiza o estado com afinidade estrita à aba e janela vinculadas
 */
function renderState(state = null, signals = [], logs = []) {
  try {
    if (!state) {
      if (!isBoundTabB2) {
        showOpenB2Notice();
      }
      return;
    }

    // Suporte Multi-Chart: identifica símbolos ativos e o ativo selecionado
    const allSymbols = state.allSymbols || (state.symbols ? Object.keys(state.symbols) : (state.symbol ? [state.symbol] : []));
    if (panelSelectedSymbol && state.symbols?.[panelSelectedSymbol]) {
      // Mantém o símbolo escolhido pelo usuário se ainda for válido
    } else {
      panelSelectedSymbol = state.selectedSymbol || state.symbol || allSymbols[0] || null;
    }

    // Dados a serem exibidos no painel principal
    const displayData = (panelSelectedSymbol && state.symbols?.[panelSelectedSymbol])
      ? { ...state.symbols[panelSelectedSymbol], clockOffsetMs: state.clockOffsetMs }
      : state;

    renderMultiAssetBar(state, allSymbols, panelSelectedSymbol);
    renderCrossAssetAlert(state, panelSelectedSymbol);

    // Sincroniza o relógio de mercado com o offset recebido
    if (displayData.clockOffsetMs !== undefined) {
      localMarketClock.offsetMs = displayData.clockOffsetMs;
    }

    // Avalia efeitos sonoros da transição do ciclo de vida
    const nextLifecycle = displayData.lifecycle || null;
    const sec = localMarketClock.secondInCandle(60);
    const sounds = soundsForTransition(lastLifecycle, nextLifecycle, sec, playedSoundSet);
    playSoundList(sounds);
    lastLifecycle = nextLifecycle;

    // 1. Renderiza Card Visual de Sinal, Análise e Histórico
    renderSignalCard(displayData);
    renderQuantAnalysis(displayData);
    renderSignalsHistory(signals);
    renderLogs(logs);

    // 2. Renderização dos elementos do Status Card
    const currentTimerState = candleTimer.getState();
    const vm = createViewModel(displayData, displayData.candleTimer || currentTimerState || {}, { now: Date.now() });
    const copy = {
      CONECTANDO: "Activo · Buscando la transmisión…",
      CALIBRANDO: "Activo · Calibrando datos…",
      ESCANEANDO: "Activo · Escuchando el mercado…",
      SENAL: "Activo · Frecuencia fijada.",
      BLOQUEADO: "Activo · Datos bloqueados.",
    }[vm.visualState] || "Activo · Observador Quant";

    const copyEl = document.getElementById("status-copy");
    if (copyEl) copyEl.textContent = copy;

    const dotEl = document.getElementById("status-dot");
    if (dotEl) dotEl.className = `dot ${vm.statusDot || "amber"}`;

    const assetEl = document.getElementById("asset");
    if (assetEl) assetEl.textContent = vm.asset || displayData.symbol || "---";

    const tfEl = document.getElementById("timeframe");
    if (tfEl) tfEl.textContent = vm.timeframe || "M1";

    const winTag = document.getElementById("window-tag");
    if (winTag) winTag.textContent = currentWindowLabel;

    const feedCopyEl = document.getElementById("feed-copy");
    if (feedCopyEl) {
      feedCopyEl.textContent =
        vm.context?.feed === "Estable" ? "Datos estables" : vm.context?.feed === "Sin datos" ? "Sin datos" : "Datos inestables";
    }

    const feedDotEl = document.getElementById("feed-dot");
    if (feedDotEl) {
      feedDotEl.className = `dot ${vm.context?.feed === "Estable" ? "teal" : "amber"}`;
    }

    const wsEl = document.getElementById("ws");
    if (wsEl) wsEl.textContent = vm.sistema?.websocket || displayData.wsStatus || "Sin datos";

    const histEl = document.getElementById("history");
    if (histEl) histEl.textContent = `${vm.sistema?.history ?? displayData.historyCount ?? 0} velas`;

    const gapsEl = document.getElementById("gaps");
    if (gapsEl) gapsEl.textContent = String(vm.sistema?.gaps ?? displayData.gaps ?? 0);

    const techEl = document.getElementById("technical");
    if (techEl) techEl.textContent = vm.sistema?.technicalState || displayData.state || "BOOTING";

    // P-03: Cria o WaveRenderer apenas uma vez e atualiza com setState
    const canvas = document.getElementById("side-wave");
    if (canvas) {
      if (!wave) {
        wave = new WaveRenderer(canvas, { state: vm.wave });
      } else {
        wave.setState(vm.wave);
      }
    }

    // Atualiza seq renderizado para monitorar se chegam escritas fora de ordem
    if (displayData?.writeSeq !== undefined) {
      lastRenderedSeq = displayData.writeSeq;
    }

    // Registra RENDER com a lista de TODOS os cards visíveis no Flight Recorder
    const cards = [];
    const mainTitleEl = document.getElementById("signal-title");
    const mainBadgeEl = document.getElementById("signal-direction-badge");
    const mainTimerEl = document.getElementById("signal-timer-badge");
    const mainCardEl = document.getElementById("signal-card");

    if (mainCardEl) {
      cards.push({
        origem: "storage.state.lifecycle.current (Card Principal)",
        par: displayData?.symbol || displayData?.pair || "---",
        targetTs: displayData?.lifecycle?.current?.targetTs || null,
        phase: displayData?.lifecycle?.current?.phase || "SCANNING",
        direcao: displayData?.action || displayData?.lifecycle?.current?.direction || "WAIT",
        textoTitulo: mainTitleEl?.textContent || "",
        badge: mainBadgeEl?.textContent || "",
        timer: mainTimerEl?.textContent || "",
      });
    }

    if (displayData?.lifecycle?.trade) {
      cards.push({
        origem: "storage.state.lifecycle.trade (Card Trade)",
        par: displayData.lifecycle.trade.pair || displayData?.symbol || "---",
        targetTs: displayData.lifecycle.trade.targetTs || null,
        phase: displayData.lifecycle.trade.phase,
        direcao: displayData.lifecycle.trade.direction,
        textoTitulo: `Operação em andamento (${displayData.lifecycle.trade.direction})`,
        badge: displayData.lifecycle.trade.direction,
        timer: "--",
      });
    }

    if (signals && signals.length > 0 && signals[0]) {
      const s0 = signals[0];
      cards.push({
        origem: "storage.signals[0] (Último Resultado)",
        par: s0.symbol || s0.pair || "---",
        targetTs: s0.targetTimestamp || null,
        phase: s0.result === "CANCELLED" ? "CANCELLED" : "SETTLED",
        direcao: s0.action || s0.direction || "---",
        textoTitulo: `Resultado ${s0.result}: ${s0.entryPrice || "--"} -> ${s0.closePrice || "--"}`,
        badge: s0.result,
        timer: "--",
      });
    }

    const rawSignalsList = Array.isArray(signals) ? signals : [];
    rawSignalsList.slice(0, 10).forEach((sig, idx) => {
      cards.push({
        origem: `storage.signals[${idx}] (Histórico Item ${idx + 1})`,
        par: sig?.symbol || sig?.pair || "---",
        targetTs: sig?.targetTimestamp || null,
        phase: sig?.result === "CANCELLED" ? "CANCELLED" : (sig?.status || "SETTLED"),
        direcao: sig?.action || sig?.direction || "---",
        textoTitulo: `${sig?.result || "PENDING"} ${sig?.action || sig?.direction || ""}`,
        badge: sig?.result || "PENDING",
        timer: "--",
      });
    });

    rec("RENDER", {
      cardsCount: cards.length,
      cards,
      symbol: displayData?.symbol || null,
      tabId: boundTabId,
      windowId: boundWindowId,
    });
  } catch (err) {
    console.error("[Inflitrus Sidepanel] Error rendering state:", err);
  }
}

/**
 * Atualiza contexto de janela e aba vinculada ao Side Panel
 */
async function updateBoundContext() {
  try {
    if (typeof chrome !== "undefined" && chrome.windows?.getCurrent) {
      const win = await chrome.windows.getCurrent();
      boundWindowId = win?.id || null;
    }
    if (typeof chrome !== "undefined" && chrome.tabs?.query && boundWindowId != null) {
      const tabs = await chrome.tabs.query({ active: true, windowId: boundWindowId });
      const activeTab = tabs?.[0];
      const prevTabId = boundTabId;
      boundTabId = activeTab?.id || null;
      const url = activeTab?.url || "";
      isBoundTabB2 = url.includes("b2trading.io");

      configureFlightRecorder({
        ctx: "sidepanel",
        instanceId: panelInstanceId,
        windowId: boundWindowId,
        tabId: boundTabId,
      });

      if (boundTabId !== prevTabId) {
        rec("TAB_SELECTED", {
          tabId: boundTabId,
          windowId: boundWindowId,
          porQue: "query.active (leitura inicial da aba ativa na janela)",
          source: "query.active",
        });
      }
    }
    await updateWindowLabel();
  } catch (_) {}
}

/**
 * Consulta o estado atual da aba vinculada a esta janela (I-01, I-02)
 */
async function refreshWindowState() {
  await updateBoundContext();
  if (!boundTabId) return;

  if (!isBoundTabB2) {
    showOpenB2Notice();
    return;
  }

  const sessionStateKey = `ifx:session:tab:${boundTabId}:state`;
  const stateKey = `ifx:tab:${boundTabId}:state`;
  const signalsKey = `ifx:tab:${boundTabId}:signals`;
  const logsKey = `ifx:tab:${boundTabId}:logs`;
  const soundKey = boundWindowId ? `ifx:window:${boundWindowId}:sound` : null;

  const sessionStore = chrome.storage?.session;
  const localStore = chrome.storage?.local;

  const sessionPromise = new Promise((resolve) => {
    if (sessionStore?.get) {
      sessionStore.get([sessionStateKey], (sRes) => resolve(sRes || {}));
    } else {
      resolve({});
    }
  });

  const localPromise = new Promise((resolve) => {
    const keysToGet = [stateKey, signalsKey, logsKey];
    if (soundKey) keysToGet.push(soundKey);
    if (localStore?.get) {
      localStore.get(keysToGet, (lRes) => resolve(lRes || {}));
    } else {
      resolve({});
    }
  });

  const [sessionRes, localRes] = await Promise.all([sessionPromise, localPromise]);
  const res = { ...localRes, ...sessionRes };

  if (soundKey && res[soundKey] !== undefined) {
    audioAlertManager.setSoundEnabled(Boolean(res[soundKey]));
    const soundToggle = document.getElementById("sound-toggle");
    if (soundToggle) soundToggle.checked = Boolean(res[soundKey]);
  }

  const view = selectTabView(res, boundTabId);

    // R4: Consulta transacional de sinais no background (GET_SIGNALS) ou SignalStore
    let dbSignals = null;
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        const bgRes = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: "GET_SIGNALS", limit: 150, tabId: boundTabId },
            (resp) => {
              if (chrome.runtime.lastError || !resp?.ok) resolve(null);
              else resolve(resp.signals);
            }
          );
        });
        if (Array.isArray(bgRes)) dbSignals = bgRes;
      } catch (_) {}
    }

    if (!dbSignals) {
      try {
        const directSigs = await signalStore.getSignals(150, { tabId: boundTabId });
        if (Array.isArray(directSigs) && directSigs.length > 0) {
          dbSignals = directSigs;
        }
      } catch (_) {}
    }

    const activeSignals = dbSignals || view.signals || [];
    renderState(view.state, activeSignals, view.logs);
}

async function initSidepanel() {
  // Desbloqueia o áudio imediatamente em qualquer clique
  document.addEventListener("click", () => {
    audioAlertManager._ensureContext();
    if (audioAlertManager.audioCtx?.state === "suspended") {
      audioAlertManager.audioCtx.resume().catch(() => {});
    }
  });

  // 1. Cronômetro M1 desacoplado atualizado a 250ms via localMarketClock (T-06)
  setInterval(updateClockOnlyUI, 250);
  updateClockOnlyUI();

  // 2. Identifica janela e aba ligadas
  await updateBoundContext();
  rec("PANEL_NEW", { windowId: boundWindowId, boundTabId });

  if (typeof chrome !== "undefined" && chrome.tabs) {
    if (chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(async (activeInfo) => {
        if (activeInfo.windowId === boundWindowId) {
          boundTabId = activeInfo.tabId;
          configureFlightRecorder({
            ctx: "sidepanel",
            instanceId: panelInstanceId,
            windowId: boundWindowId,
            tabId: boundTabId,
          });
          rec("TAB_SELECTED", {
            tabId: boundTabId,
            windowId: boundWindowId,
            porQue: "tabs.onActivated (usuário alternou aba ativa)",
            source: "tabs.onActivated",
          });
          await refreshWindowState();
        }
      });
    }

    if (chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (tabId === boundTabId) {
          const url = tab?.url || "";
          isBoundTabB2 = url.includes("b2trading.io");
          refreshWindowState();
        }
      });
    }
  }

  // 3. Carrega preferências e estado inicial
  const winSoundKey = boundWindowId ? `ifx:window:${boundWindowId}:sound` : null;
  const prefKeys = [NOTIFICATIONS_KEY];
  if (winSoundKey) prefKeys.push(winSoundKey);

  chrome.storage.local.get(prefKeys, (result) => {
    const soundToggle = document.getElementById("sound-toggle");
    if (soundToggle) {
      const isSound = winSoundKey && result[winSoundKey] !== undefined ? Boolean(result[winSoundKey]) : audioAlertManager.isSoundEnabled();
      soundToggle.checked = isSound;
      audioAlertManager.setSoundEnabled(isSound);
    }
    const notifToggle = document.getElementById("notification-toggle");
    if (notifToggle) {
      notifToggle.checked = result[NOTIFICATIONS_KEY] !== false;
    }
  });

  await refreshWindowState();

  // 4. Listeners das Abas Principais
  document.getElementById("tab-btn-signal")?.addEventListener("click", () => switchMainTab("signal"));
  document.getElementById("tab-btn-quant")?.addEventListener("click", () => switchMainTab("quant"));
  document.getElementById("tab-btn-logs")?.addEventListener("click", () => switchMainTab("logs"));

  // 5. Switches e Ações
  document.getElementById("sound-toggle")?.addEventListener("change", (event) => {
    const enabled = event.target.checked;
    audioAlertManager.setSoundEnabled(enabled);
    if (winSoundKey) {
      chrome.storage.local.set({ [winSoundKey]: enabled });
    }
  });
  document.getElementById("notification-toggle")?.addEventListener("change", (event) => {
    chrome.storage.local.set({ [NOTIFICATIONS_KEY]: event.target.checked });
  });
  document.getElementById("copy-logs")?.addEventListener("click", () => {
    const text = currentLogs.map((entry) => `[${entry.time || ""}] [${translateLogTag(entry.tag)}] ${translateLogMessage(entry.message || "")}`).join("\n");
    if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  });
  document.getElementById("clear-logs")?.addEventListener("click", () => {
    sendToBoundTab({ type: "ORACLE_CLEAR_LOGS" });
    if (boundTabId) {
      chrome.storage.local.remove([`ifx:tab:${boundTabId}:logs`]);
    }
    renderLogs([]);
  });
  document.getElementById("open-traderoom")?.addEventListener("click", () => {
    chrome.tabs.query({ url: "https://traderoom.b2trading.io/*" }, (tabs) => {
      if (tabs[0]?.id != null) chrome.tabs.update(tabs[0].id, { active: true });
      else chrome.tabs.create({ url: "https://traderoom.b2trading.io/" });
    });
  });

  // Botões de Organização Multi-Telas
  document.getElementById("btn-tile-2")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "ORACLE_ARRANGE_MULTI_WINDOWS", count: 2 });
  });
  document.getElementById("btn-tile-3")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "ORACLE_ARRANGE_MULTI_WINDOWS", count: 3 });
  });

  // Botões de Diagnóstico / Gravador de Voo
  document.getElementById("btn-mark-occurrence")?.addEventListener("click", () => {
    const note = window.prompt("Descreva o que acabou de acontecer (ex: 'trocou de CALL pra PUT', '4 sinais ao mesmo tempo'):", "");
    if (note !== null) {
      rec("USER_MARK", { note: note.trim() || "Sem descrição", at: new Date().toISOString() });
      const btn = document.getElementById("btn-mark-occurrence");
      if (btn) {
        const oldText = btn.textContent;
        btn.textContent = "✓ Marcado!";
        setTimeout(() => { btn.textContent = oldText; }, 2000);
      }
    }
  });

  document.getElementById("btn-export-flight")?.addEventListener("click", () => {
    const btn = document.getElementById("btn-export-flight");
    if (btn) btn.textContent = "⏳...";
    chrome.runtime.sendMessage({ type: "REC_EXPORT" }, (res) => {
      if (btn) btn.textContent = "📥 Exportar";
      if (chrome.runtime?.lastError || !res || !res.ok) {
        alert("Erro ao exportar diagnóstico do voo: " + (chrome.runtime?.lastError?.message || res?.error || "Desconhecido"));
        return;
      }
      const bundleJson = JSON.stringify(res.bundle, null, 2);
      const blob = new Blob([bundleJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `ifx-flight-${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 2000);
    });
  });

  // 6. Observador de mudanças no Storage estritamente isolado para a aba vinculada
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area !== "local" && area !== "session") || !boundTabId) return;

    for (const [key, change] of Object.entries(changes)) {
      if (key === `ifx:session:tab:${boundTabId}:state` || key.startsWith(`ifx:tab:${boundTabId}:`)) {
        const seqRecebido = change.newValue?.writeSeq ?? null;
        const oldPhase = change.oldValue?.lifecycle?.trade?.phase || change.oldValue?.lifecycle?.current?.phase || null;
        const newPhase = change.newValue?.lifecycle?.trade?.phase || change.newValue?.lifecycle?.current?.phase || null;
        rec("STORAGE_CHANGE", {
          chave: key,
          seqRecebido,
          seqAnteriorRenderizado: lastRenderedSeq,
          oldValuePhase: oldPhase,
          newValuePhase: newPhase,
        });
      }
    }

    const tabPrefix = `ifx:tab:${boundTabId}:`;
    const sessionPrefix = `ifx:session:tab:${boundTabId}:`;
    const relevant = Object.keys(changes).some(
      (k) => k.startsWith(tabPrefix) || k.startsWith(sessionPrefix) || k === winSoundKey
    );
    if (relevant) {
      refreshWindowState();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSidepanel);
} else {
  initSidepanel();
}
