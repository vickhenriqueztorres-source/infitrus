/**
 * notifications.js - Notificações e Badges por Aba no Background Service Worker
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Gerenciar badges de ícone da extensão EXCLUSIVAMENTE vinculados ao tabId da aba (I-06, I-07).
 * - Exibir notificações nativas do Chrome apenas em transições PRE_SIGNAL e ENTRY_NOW.
 * - Deduplicar notificações por ${signal.id}:${fase} via chrome.storage.session.
 */

import { rec } from "../diagnostics/flight-recorder.js";

/**
 * Trata mudança de estado de uma aba específica e atualiza badge e notificações.
 *
 * @param {number} tabId
 * @param {Object} newState
 * @param {Object} [oldState]
 */
export async function handleTabStateChange(tabId, newState, oldState = null) {
  if (!tabId || !newState) return;

  const lc = newState.lifecycle;
  const activeSignal = lc?.trade || lc?.current;

  // 1. Badge estritamente vinculado ao tabId (NUNCA global sem tabId)
  if (globalThis.chrome?.action?.setBadgeText) {
    if (activeSignal && (activeSignal.phase === "PRE_SIGNAL" || activeSignal.phase === "ENTRY_NOW")) {
      const text = activeSignal.direction === "CALL" ? "▲" : "▼";
      const color = activeSignal.direction === "CALL" ? "#00D696" : "#FF3B69";
      try {
        globalThis.chrome.action.setBadgeText({ tabId, text });
        if (globalThis.chrome.action.setBadgeBackgroundColor) {
          globalThis.chrome.action.setBadgeBackgroundColor({ tabId, color });
        }
        rec("BADGE_SET", { tabId, text, color });
      } catch (_) {}
    } else {
      try {
        globalThis.chrome.action.setBadgeText({ tabId, text: "" });
        rec("BADGE_SET", { tabId, text: "" });
      } catch (_) {}
    }
  }

  // 2. Notificações apenas em PRE_SIGNAL e ENTRY_NOW
  if (!activeSignal || !["PRE_SIGNAL", "ENTRY_NOW"].includes(activeSignal.phase)) return;
  const dedupKey = `notif:${activeSignal.id}:${activeSignal.phase}`;

  let alreadyNotified = false;
  try {
    if (globalThis.chrome?.storage?.session) {
      const sess = await globalThis.chrome.storage.session.get([dedupKey]);
      if (sess && sess[dedupKey]) {
        alreadyNotified = true;
      } else {
        await globalThis.chrome.storage.session.set({ [dedupKey]: true });
      }
    }
  } catch (_) {}

  if (alreadyNotified) return;

  const pair = activeSignal.pair || newState.symbol || "Mercado";
  const dir = activeSignal.direction;
  const arrow = dir === "CALL" ? "▲" : "▼";
  const winIdStr = newState.windowId ? `[Ventana ${newState.windowId}] ` : "";

  const title = `${pair} · ${dir} ${arrow}`;
  const message = activeSignal.phase === "ENTRY_NOW"
    ? `${winIdStr}¡Entra ahora en ${pair} (${dir})!`
    : `${winIdStr}Pre-señal en ${pair}. Entrada al abrir la próxima vela.`;

  if (globalThis.chrome?.notifications?.create) {
    try {
      const notifId = `ifx-${activeSignal.id}-${activeSignal.phase}`;
      const notifOpts = {
        type: "basic",
        iconUrl: globalThis.chrome.runtime?.getURL?.("assets/icons/icon-128.png") || "",
        title,
        message,
        priority: 2,
      };
      rec("NOTIFY", { id: notifId, options: notifOpts });
      await globalThis.chrome.notifications.create(notifId, notifOpts);
    } catch (_) {}
  }
}
