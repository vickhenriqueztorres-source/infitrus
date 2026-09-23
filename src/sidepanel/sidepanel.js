import { audioAlertManager } from "../utils/audio-alerts.js";
import { candleTimer } from "../utils/candle-timer.js";
import { MarketClock } from "../utils/market-clock.js";
import { createViewModel } from "../ui/view-model.js";
import { WaveRenderer } from "../ui/wave.js";
import { translateLogMessage, translateLogTag } from "../ui/components/layout.js";
import { selectTabView } from "../ui/tab-view-selector.js";
import { soundsForTransition } from "../ui/sound-transitions.js";

const localMarketClock = new MarketClock();
const NOTIFICATIONS_KEY = "ifx_notifications_v1";
let wave;
let currentLogs = [];
let boundTabId = null;
let boundWindowId = null;
let isBoundTabB2 = false;
let activeMainTab = "signal"; // 'signal' | 'quant' | 'logs'
let activeSignalData = null;
let lastLifecycle = null;
const playedSoundSet = new Set();

function sendToBoundTab(message) {
  if (boundTabId == null) return;
  try {
    const pending = chrome.tabs.sendMessage(boundTabId, message);
    pending?.catch?.(() => {});
  } catch (_) {}
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
    if (s === "call") audioAlertManager.playCallAlert();
    else if (s === "put") audioAlertManager.playPutAlert();
    else if (s === "pip") audioAlertManager.playCountdownPip(1);
    else if (s === "entry") audioAlertManager.playCountdownPip(0);
  }
}

/**
 * Atualiza o cronômetro M1 e a barra de contagem regressiva desacoplado via localMarketClock
 */
function updateClockOnlyUI() {
  const remaining = localMarketClock.remainingInCandle(60);
  const sec = localMarketClock.secondInCandle(60);
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const formattedTime = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  const progressPct = Number((((60 - remaining) / 60) * 100).toFixed(1));

  const timerBadge = document.getElementById("signal-timer-badge");
  if (timerBadge) {
    timerBadge.textContent = formattedTime;
    timerBadge.classList.toggle("warning", remaining <= 15 && remaining > 3);
    timerBadge.classList.toggle("prepare", remaining <= 3);
  }

  const progressBar = document.getElementById("signal-progress-bar");
  if (progressBar) {
    progressBar.style.width = `${Math.min(100, Math.max(0, progressPct))}%`;
  }

  // Pips nos segundos 57, 58 e 59 se houver PRE_SIGNAL ativo
  if (lastLifecycle?.current?.phase === "PRE_SIGNAL") {
    const pipSounds = soundsForTransition(lastLifecycle, lastLifecycle, sec, playedSoundSet);
    playSoundList(pipSounds);
  }
}

/**
 * Atualiza o cronômetro M1 e a barra de contagem regressiva em tempo real
 */
function updateCountdownUI(timerState) {
  if (!timerState) return;

  const timerBadge = document.getElementById("signal-timer-badge");
  if (timerBadge) {
    timerBadge.textContent = timerState.formattedTime || "01:00";
    timerBadge.classList.toggle("warning", timerState.remainingSeconds <= 15 && timerState.remainingSeconds > 3);
    timerBadge.classList.toggle("prepare", timerState.remainingSeconds <= 3);
  }

  const progressBar = document.getElementById("signal-progress-bar");
  if (progressBar) {
    progressBar.style.width = `${Math.min(100, Math.max(0, timerState.progressPct || 0))}%`;
  }

  // Guia de execução na janela de fechamento/abertura
  const guide = document.getElementById("signal-guide");
  const guideText = document.getElementById("guide-text");
  const vm = createViewModel(activeSignalData || {}, timerState);
  const act = vm.signal ? vm.signal.direction : "WAIT";
  const phaseLabel = vm.signal?.phaseLabel || "";

  if (guide && guideText) {
    if (vm.signal && (act === "CALL" || act === "PUT")) {
      guide.style.display = "block";
      if (vm.signal.rawPhase === "ENTRY_NOW" || timerState.remainingSeconds <= 1) {
        guide.className = "signal-guide is-execute";
        guideText.innerHTML = `🚀 <strong>ENTRADA CONFIRMADA (${act})</strong>: Abrir operação agora na ABERTURA!`;
      } else if (timerState.remainingSeconds <= 3) {
        guide.className = "signal-guide";
        guideText.innerHTML = `⚠️ <strong>PREPARE O CLIQUE (${act})</strong>: Abertura em <b>${timerState.remainingSeconds}s</b>`;
      } else {
        guide.className = "signal-guide";
        guideText.innerHTML = `⚠️ <strong>${phaseLabel || "PRÉ-ALERTA"} (${act})</strong>: Entrada na ABERTURA em <b>${timerState.remainingSeconds}s</b>`;
      }
    } else {
      guide.style.display = "none";
    }
  }
}

/**
 * Renderiza o Card Visual de Sinal M1
 */
function renderSignalCard(data, timerState = null) {
  const card = document.getElementById("signal-card");
  if (!card) return;

  activeSignalData = data;
  const currentTimer = timerState || candleTimer.getState();
  const vm = createViewModel(data || {}, currentTimer);

  const action = vm.signal ? vm.signal.direction : "WAIT";
  const prob = Number(vm.signal?.probability || data?.conservativeProbability || data?.probability || data?.quantProbability || 0.5);
  const edge = Number(data?.edge ?? 0);
  const qual = Number(data?.quality ?? 0);
  const substrat = data?.subStrategy || data?.strategyName || (action !== "WAIT" ? "Quant M1" : "21 SUBESTRATÉGIAS");
  const stats = data?.stats || {};

  // Classes do Card
  card.classList.remove("is-call", "is-put", "is-wait");
  const badge = document.getElementById("signal-direction-badge");
  const stratBadge = document.getElementById("signal-strategy-badge");
  const iconEl = document.getElementById("signal-icon");
  const titleEl = document.getElementById("signal-title");
  const subTitleEl = document.getElementById("signal-subtitle");
  const timingLabel = document.getElementById("entry-timing-label");

  if (action === "CALL") {
    card.classList.add("is-call");
    if (badge) {
      badge.className = "signal-badge call";
      badge.textContent = "▲ CALL (COMPRA)";
    }
    if (iconEl) iconEl.textContent = "▲";
    if (titleEl) titleEl.textContent = `Operação CALL · ${substrat}`;
    if (subTitleEl) subTitleEl.textContent = "Frequência de alta detectada no fluxo. Entrada na abertura.";
    if (timingLabel) timingLabel.textContent = "NA ABERTURA DA VELA (00:00)";
  } else if (action === "PUT") {
    card.classList.add("is-put");
    if (badge) {
      badge.className = "signal-badge put";
      badge.textContent = "▼ PUT (VENDA)";
    }
    if (iconEl) iconEl.textContent = "▼";
    if (titleEl) titleEl.textContent = `Operação PUT · ${substrat}`;
    if (subTitleEl) subTitleEl.textContent = "Frequência de baixa detectada no fluxo. Entrada na abertura.";
    if (timingLabel) timingLabel.textContent = "NA ABERTURA DA VELA (00:00)";
  } else {
    card.classList.add("is-wait");
    if (badge) {
      badge.className = "signal-badge wait";
      badge.textContent = data?.signalLabel || "ESCANEANDO";
    }
    if (iconEl) iconEl.textContent = "◎";
    if (titleEl) titleEl.textContent = "Aguardando Oportunidade";
    if (subTitleEl) subTitleEl.textContent = "Analisando microestrutura e confluências quantitativas...";
    if (timingLabel) timingLabel.textContent = "NA ABERTURA DA PRÓXIMA VELA";
  }

  if (stratBadge) {
    stratBadge.textContent = substrat.toUpperCase();
  }

  // Métricas do Card
  const probEl = document.getElementById("sig-prob");
  if (probEl) probEl.textContent = action !== "WAIT" ? `${(prob * 100).toFixed(0)}%` : "--%";

  const edgeEl = document.getElementById("sig-edge");
  if (edgeEl) edgeEl.textContent = action !== "WAIT" ? `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%` : "--%";

  const qualEl = document.getElementById("sig-qual");
  if (qualEl) qualEl.textContent = action !== "WAIT" ? `${(qual * 100).toFixed(0)}%` : "--%";

  const wrEl = document.getElementById("sig-wr");
  if (wrEl) wrEl.textContent = stats.total > 0 ? `${Number(stats.winRate || 0).toFixed(0)}%` : "--%";

  updateCountdownUI(currentTimer);
}

/**
 * Renderiza a Aba de Análise Quantitativa Detalhada
 */
function renderQuantAnalysis(data) {
  if (!data) return;

  // 1. Radar Quantitativo
  const regimeEl = document.getElementById("q-regime");
  if (regimeEl) regimeEl.textContent = `REGIME: ${(data.regime || "NORMAL").toUpperCase()}`;

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
      { id: "continuation", label: "Continuação", defaultSub: "Impulse / Trend Thrust" },
      { id: "reversion", label: "Reversão", defaultSub: "Wick / Exaustão" },
      { id: "microstructure", label: "Microestrutura", defaultSub: "Tick Pressure / Flow" },
      { id: "volatility_expansion", label: "Volatilidade", defaultSub: "Breakout / Expansion" },
      { id: "historical_analogy", label: "Analogia (KNN)", defaultSub: "Exact Pattern / Shape" },
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
      famActiveCountEl.textContent = `${activeCount}/5 ativas`;
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
      li.textContent = "Monitorando fluxo e confluências de microestrutura...";
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
 * Renderiza o Histórico de Sinais na Aba de Logs
 */
function renderSignalsHistory(signals = []) {
  const list = document.getElementById("signals-history-list");
  const countBadge = document.getElementById("history-count");
  if (!list) return;

  const rawList = Array.isArray(signals) ? signals : [];
  if (countBadge) countBadge.textContent = `${rawList.length} sinais`;

  if (!rawList.length) {
    list.innerHTML = `<p class="logs-empty">Nenhum sinal liquidado ainda nesta sessão.</p>`;
    return;
  }

  list.replaceChildren();
  rawList.slice(0, 15).forEach((sig) => {
    const row = document.createElement("div");
    row.className = "history-row";

    const time = document.createElement("time");
    time.textContent = sig.timeFormatted || "--:--";

    const badge = document.createElement("span");
    const res = sig.result || sig.status || "PENDING";
    badge.className = `history-badge ${res}`;
    badge.textContent = res;

    const desc = document.createElement("span");
    desc.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ice);font-weight:500;";
    desc.textContent = `${sig.direction} ${sig.symbol || ""}`;

    const prob = document.createElement("span");
    prob.style.cssText = "text-align:right;color:var(--steel);";
    prob.textContent = sig.probability ? `${(sig.probability * 100).toFixed(0)}%` : "--";

    const pnl = document.createElement("span");
    pnl.style.cssText = `text-align:right;font-weight:700;color:${sig.pnlUnits > 0 ? "#3FE0C5" : sig.pnlUnits < 0 ? "#FF5A6E" : "var(--steel)"}`;
    pnl.textContent = sig.pnlUnits != null ? `${sig.pnlUnits > 0 ? "+" : ""}${sig.pnlUnits.toFixed(1)} un` : "--";

    row.append(time, badge, desc, prob, pnl);
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
    empty.textContent = "Esperando eventos do sistema…";
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

  const feedCopyEl = document.getElementById("feed-copy");
  if (feedCopyEl) feedCopyEl.textContent = "Sin datos";

  const feedDotEl = document.getElementById("feed-dot");
  if (feedDotEl) feedDotEl.className = "dot amber";

  renderSignalCard({ symbol: "---", action: "WAIT" });
  renderSignalsHistory([]);
  renderLogs([]);
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

    const displayData = state;

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

    const currentTimerState = candleTimer.getState();

    // 1. Renderiza Card Visual de Sinal, Análise e Histórico
    renderSignalCard(displayData, currentTimerState);
    renderQuantAnalysis(displayData);
    renderSignalsHistory(signals);
    renderLogs(logs);

    // 2. Renderização dos elementos do Status Card
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

    const canvas = document.getElementById("side-wave");
    if (canvas) {
      wave?.destroy();
      wave = new WaveRenderer(canvas, { state: vm.wave });
    }
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
      boundTabId = activeTab?.id || null;
      const url = activeTab?.url || "";
      isBoundTabB2 = url.includes("b2trading.io");
    }
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

  const stateKey = `ifx:tab:${boundTabId}:state`;
  const signalsKey = `ifx:tab:${boundTabId}:signals`;
  const logsKey = `ifx:tab:${boundTabId}:logs`;
  const soundKey = boundWindowId ? `ifx:window:${boundWindowId}:sound` : null;

  const keysToGet = [stateKey, signalsKey, logsKey];
  if (soundKey) keysToGet.push(soundKey);

  chrome.storage.local.get(keysToGet, (res) => {
    if (soundKey && res[soundKey] !== undefined) {
      audioAlertManager.setSoundEnabled(Boolean(res[soundKey]));
      const soundToggle = document.getElementById("sound-toggle");
      if (soundToggle) soundToggle.checked = Boolean(res[soundKey]);
    }

    const view = selectTabView(res, boundTabId);
    renderState(view.state, view.signals, view.logs);
  });
}

async function initSidepanel() {
  // Desbloqueia o áudio imediatamente em qualquer clique
  document.addEventListener("click", () => {
    audioAlertManager._ensureContext();
    if (audioAlertManager.audioCtx?.state === "suspended") {
      audioAlertManager.audioCtx.resume().catch(() => {});
    }
  });

  // 1. Cronômetro M1 desacoplado atualizado a 250ms via localMarketClock
  setInterval(updateClockOnlyUI, 250);
  updateClockOnlyUI();

  // 2. Identifica janela e aba ligadas
  await updateBoundContext();

  if (typeof chrome !== "undefined" && chrome.tabs) {
    if (chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(async (activeInfo) => {
        if (activeInfo.windowId === boundWindowId) {
          boundTabId = activeInfo.tabId;
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

  // 6. Observador de mudanças no Storage estritamente isolado para a aba vinculada
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !boundTabId) return;

    const tabPrefix = `ifx:tab:${boundTabId}:`;
    const relevant = Object.keys(changes).some((k) => k.startsWith(tabPrefix) || k === winSoundKey);
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
