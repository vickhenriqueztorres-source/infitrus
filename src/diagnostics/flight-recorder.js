/**
 * flight-recorder.js - Gravador de Voo Unificado para Todos os Contextos
 * Oracle Quant Signals
 *
 * Responsabilidades:
 * - Registrar eventos com timestamp de parede (tWall) e alta precisão (tPerf).
 * - Enviar eventos de qualquer contexto (main, content, sw, sidepanel, popup) para o SW.
 * - No SW: manter ring buffer de 20.000 registros com numeração sequencial monotônica estrita (seq),
 *   atribuindo tabId e frameId a partir do sender real (não confiando no payload).
 * - Espelhar periodicamente em chrome.storage.session (a cada 2s).
 * - Gerar bundle de exportação JSON completo com metadata e dump de storage.
 */

const MAX_RING_BUFFER_SIZE = 20000;
const SESSION_STORAGE_KEY = "ifx:flight_recorder:buffer";
const SESSION_SEQ_KEY = "ifx:flight_recorder:seq";

// Estado interno do contexto atual
let currentCtx = "unknown";
let currentInstanceId = null;
let currentWindowId = null;
let currentTabId = null;

// Estado exclusivo do Service Worker (SW)
let swRingBuffer = [];
let swGlobalSeq = 0;
let swSessionSyncTimer = null;
let swSessionSyncDirty = false;

/**
 * Gera um identificador único simples para instâncias (analyzer, panel, etc.)
 */
export function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch (_) {}
  }
  return "inst_" + Math.random().toString(36).substring(2, 11) + "_" + Date.now().toString(36);
}

/**
 * Configura o contexto atual (chamado na inicialização de cada módulo)
 */
export function configureFlightRecorder({ ctx, instanceId, windowId, tabId } = {}) {
  if (ctx) currentCtx = ctx;
  if (instanceId) currentInstanceId = instanceId;
  if (windowId !== undefined) currentWindowId = windowId;
  if (tabId !== undefined) currentTabId = tabId;
}

export function getFlightRecorderConfig() {
  return {
    ctx: currentCtx,
    instanceId: currentInstanceId,
    windowId: currentWindowId,
    tabId: currentTabId,
  };
}

/**
 * Gera um hash/checksum compacto de uma série de velas para rastrear se os dados de entrada mudaram
 */
export function hashCandles(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return "empty";
  const slice = candles.slice(-60);
  let hash = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    const str = `${c.timestamp || 0}:${(c.close || 0).toFixed(5)}:${(c.open || 0).toFixed(5)}`;
    for (let j = 0; j < str.length; j++) {
      hash = (hash << 5) - hash + str.charCodeAt(j);
      hash |= 0;
    }
  }
  return `h_${slice.length}_${(hash >>> 0).toString(16)}`;
}

/**
 * Função principal de gravação: rec(type, payload, options)
 * Fire-and-forget, sem await no caminho crítico.
 */
export function rec(type, payload = {}, options = {}) {
  try {
    const tWall = Date.now();
    const tPerf = typeof performance !== "undefined" && performance.now ? performance.now() : 0;
    const ctx = options.ctx || currentCtx;
    const instanceId = options.instanceId || currentInstanceId;
    const windowId = options.windowId !== undefined ? options.windowId : currentWindowId;
    const tabId = options.tabId !== undefined ? options.tabId : currentTabId;
    const frameId = options.frameId !== undefined ? options.frameId : null;

    const record = {
      tWall,
      tPerf,
      ctx,
      tabId,
      frameId,
      windowId,
      instanceId,
      type,
      payload,
    };

    // 1. Se estiver executando no próprio Service Worker: grava diretamente no buffer
    if (ctx === "sw" || (typeof window === "undefined" && typeof importScripts === "function")) {
      swIngestRecord(record);
      return record;
    }

    // 2. Se for contexto com chrome.runtime.sendMessage (content script, sidepanel, popup):
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: "REC",
          record,
        }, () => {
          // Ignora lastError se o SW estiver adormecido
          if (chrome.runtime?.lastError) {}
        });
      } catch (_) {}
      return record;
    }

    // 3. Se for MAIN WORLD (página nativa sem acesso à API chrome.runtime):
    if (typeof window !== "undefined" && window.postMessage) {
      try {
        window.postMessage({
          type: "ORACLE_FLIGHT_REC",
          record,
        }, window.location?.origin || "*");
      } catch (_) {}
      return record;
    }

    // Fallback para ambiente de teste ou isolado
    return record;
  } catch (_) {
    return null;
  }
}

/**
 * Manipulação interna de ingestão de registros no Service Worker
 */
export function swIngestRecord(rawRecord, sender = null) {
  swGlobalSeq++;
  const record = {
    ...rawRecord,
    seq: swGlobalSeq,
  };

  // NUNCA confie no tabId/frameId enviado: sobrescreve com dados oficiais do sender quando presentes
  if (sender) {
    if (sender.tab?.id != null) {
      record.tabId = sender.tab.id;
    }
    if (sender.frameId != null) {
      record.frameId = sender.frameId;
    }
    if (sender.tab?.windowId != null && record.windowId == null) {
      record.windowId = sender.tab.windowId;
    }
  }

  swRingBuffer.push(record);
  if (swRingBuffer.length > MAX_RING_BUFFER_SIZE) {
    swRingBuffer.shift();
  }

  swSessionSyncDirty = true;
  scheduleSessionSync();
  return record;
}

/**
 * Agenda o espelhamento do buffer em chrome.storage.session a cada 2s
 */
function scheduleSessionSync() {
  if (swSessionSyncTimer) return;
  swSessionSyncTimer = setTimeout(() => {
    swSessionSyncTimer = null;
    if (!swSessionSyncDirty) return;
    swSessionSyncDirty = false;

    if (typeof chrome !== "undefined" && chrome.storage?.session?.set) {
      try {
        // Salva os últimos 2.000 registros mais recentes na sessão para não sobrecarregar cota de memória
        const recentRecords = swRingBuffer.slice(-2000);
        chrome.storage.session.set({
          [SESSION_STORAGE_KEY]: recentRecords,
          [SESSION_SEQ_KEY]: swGlobalSeq,
        }).catch(() => {});
      } catch (_) {}
    }
  }, 2000);
}

/**
 * Restaura estado da sessão se o Service Worker reiniciar (MV3 Lifecycle)
 */
export async function swRestoreState() {
  if (typeof chrome === "undefined" || !chrome.storage?.session?.get) return;
  try {
    const data = await chrome.storage.session.get([SESSION_STORAGE_KEY, SESSION_SEQ_KEY]);
    if (Array.isArray(data?.[SESSION_STORAGE_KEY])) {
      swRingBuffer = data[SESSION_STORAGE_KEY];
    }
    if (typeof data?.[SESSION_SEQ_KEY] === "number") {
      swGlobalSeq = Math.max(swGlobalSeq, data[SESSION_SEQ_KEY]);
    }
  } catch (_) {}
}

/**
 * Retorna todos os registros em memória do Service Worker
 */
export function swGetRecords() {
  return [...swRingBuffer];
}

/**
 * Limpa todos os registros do Service Worker (útil para testes ou reinicialização)
 */
export function swResetRecords() {
  swRingBuffer = [];
  swGlobalSeq = 0;
  swSessionSyncDirty = false;
  if (swSessionSyncTimer) {
    clearTimeout(swSessionSyncTimer);
    swSessionSyncTimer = null;
  }
}

/**
 * Constrói o pacote completo de diagnóstico para exportação
 */
export async function swBuildExportBundle() {
  let manifest = {};
  if (typeof chrome !== "undefined" && chrome.runtime?.getManifest) {
    manifest = chrome.runtime.getManifest();
  }

  let tabsList = [];
  if (typeof chrome !== "undefined" && chrome.tabs?.query) {
    try {
      tabsList = await chrome.tabs.query({});
    } catch (_) {}
  }

  let storageLocal = {};
  if (typeof chrome !== "undefined" && chrome.storage?.local?.get) {
    try {
      storageLocal = await chrome.storage.local.get(null);
    } catch (_) {}
  }

  let storageSession = {};
  if (typeof chrome !== "undefined" && chrome.storage?.session?.get) {
    try {
      storageSession = await chrome.storage.session.get(null);
    } catch (_) {}
  }

  return {
    exportedAt: new Date().toISOString(),
    tWall: Date.now(),
    extension: {
      id: typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : "local",
      name: manifest.name || "Inflitrus Signals",
      version: manifest.version || "0.1.0",
      manifestVersion: manifest.manifest_version || 3,
    },
    system: {
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "Node.js",
      recordsCount: swRingBuffer.length,
      currentSeq: swGlobalSeq,
    },
    tabs: tabsList.map((t) => ({
      id: t.id,
      windowId: t.windowId,
      active: t.active,
      url: t.url,
      title: t.title,
    })),
    storage: {
      local: filterIfxKeys(storageLocal),
      session: filterIfxKeys(storageSession),
    },
    records: swGetRecords(),
  };
}

function filterIfxKeys(obj = {}) {
  if (!obj || typeof obj !== "object") return {};
  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("ifx:")) {
      res[k] = v;
    }
  }
  return res;
}
