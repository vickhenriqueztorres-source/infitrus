import { registerNotifications } from "./notifications.js";

registerNotifications();

function configureDockedPanel() {
  if (typeof chrome === "undefined" || !chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

configureDockedPanel();

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Inflitrus] Extensión instalada.");
  configureDockedPanel();
});

// Responde a pedidos de identificação de aba/janela e gerenciamento de multitelas
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ORACLE_GET_TAB_INFO") {
    sendResponse({
      tabId: sender.tab?.id || null,
      windowId: sender.tab?.windowId || null,
    });
    return true;
  }

  if (message?.type === "ORACLE_ARRANGE_MULTI_WINDOWS") {
    arrangeMultiWindows(message.count || 3).then(() => {
      sendResponse({ success: true });
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

// Limpeza de abas fechadas para não deixar abas fantasmas no storage
chrome.tabs.onRemoved.addListener((tabId) => {
  try {
    chrome.storage.local.get(["oracleMarketState"], (res) => {
      const state = res?.oracleMarketState;
      if (state && state.tabs && state.tabs[tabId]) {
        delete state.tabs[tabId];
        chrome.storage.local.set({ oracleMarketState: state });
      }
      chrome.storage.local.remove([`oracleMarketState_tab_${tabId}`, `oracle_logs_tab_${tabId}`]);
    });
  } catch (_) {}
});

/**
 * Organiza 2 ou 3 janelas lado a lado com B2Trading aberta
 */
async function arrangeMultiWindows(count = 3) {
  try {
    const currentWin = await chrome.windows.getCurrent();
    const numWindows = Math.max(2, Math.min(4, Number(count) || 3));

    // Determina resolução base
    const totalWidth = currentWin.width && currentWin.width > 800 ? currentWin.width : 1920;
    const totalHeight = currentWin.height && currentWin.height > 600 ? currentWin.height : 1040;
    const winWidth = Math.floor(totalWidth / numWindows);
    const winHeight = totalHeight;
    const startTop = currentWin.top != null ? currentWin.top : 0;
    const startLeft = currentWin.left != null ? currentWin.left : 0;

    // Redimensiona a janela atual para o slot 1 (extrema esquerda)
    await chrome.windows.update(currentWin.id, {
      left: startLeft,
      top: startTop,
      width: winWidth,
      height: winHeight,
      state: "normal",
    });

    // Abre o sidePanel na janela atual
    if (chrome.sidePanel?.open && currentWin.id) {
      chrome.sidePanel.open({ windowId: currentWin.id }).catch(() => {});
    }

    // Cria as janelas subsequentes lado a lado
    for (let i = 1; i < numWindows; i++) {
      const leftPos = startLeft + (i * winWidth);
      const newWin = await chrome.windows.create({
        url: "https://traderoom.b2trading.io/",
        left: leftPos,
        top: startTop,
        width: winWidth,
        height: winHeight,
        type: "normal",
      });

      if (chrome.sidePanel?.open && newWin.id) {
        // Breve espera para o Chrome registrar a nova janela antes de abrir o painel
        setTimeout(() => {
          chrome.sidePanel.open({ windowId: newWin.id }).catch(() => {});
        }, 300);
      }
    }
  } catch (err) {
    console.error("[Inflitrus ServiceWorker] Erro ao organizar janelas:", err);
  }
}
