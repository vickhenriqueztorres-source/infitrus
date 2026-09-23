/**
 * tab-view-selector.js - Seletor Isolado de Visualização por Aba (I-01, I-02)
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Extrair de forma pura e estritamente isolada o estado, histórico de sinais e logs
 *   pertencentes EXCLUSIVAMENTE a uma aba específica (boundTabId).
 * - Sem fallback para nenhuma outra aba ou estado global.
 */

/**
 * Seleciona os dados da aba vinculada a partir do snapshot de storage.
 *
 * @param {Object} storageSnapshot
 * @param {number|string} boundTabId
 * @returns {{ state: Object|null, signals: Array, logs: Array, symbol?: string, action?: string, tabId?: number|string }}
 */
export function selectTabView(storageSnapshot = {}, boundTabId = null) {
  if (!boundTabId) {
    return { state: null, signals: [], logs: [] };
  }

  const id = Number(boundTabId);
  const stateKey = `ifx:tab:${id}:state`;
  const signalsKey = `ifx:tab:${id}:signals`;
  const logsKey = `ifx:tab:${id}:logs`;

  // Lê estritamente as chaves exclusivas da aba (com suporte retroativo a tabs[id])
  const state =
    storageSnapshot[stateKey] ||
    (storageSnapshot.tabs && (storageSnapshot.tabs[id] || storageSnapshot.tabs[String(boundTabId)])) ||
    null;

  const signals =
    storageSnapshot[signalsKey] ||
    (state?.signalsHistory) ||
    [];

  const logs =
    storageSnapshot[logsKey] ||
    [];

  return {
    ...(state || {}),
    tabId: state?.tabId ?? id,
    state,
    signals,
    logs,
  };
}
