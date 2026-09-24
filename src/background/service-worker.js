import { handleTabStateChange } from "./notifications.js";

function configureDockedPanel() {
  if (typeof chrome === "undefined" || !chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

configureDockedPanel();

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Inflitrus] Extensión instalada.");
  configureDockedPanel();
  try {
    chrome.storage.local.clear().catch(() => {});
  } catch (_) {}
});

// Escuta mudanças de estado por aba para atualizar badge e emitir notificações (I-06, I-07)
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    for (const [key, change] of Object.entries(changes)) {
      const match = /^ifx:tab:(\d+):state$/.exec(key);
      if (!match) continue;

      const tabId = Number(match[1]);
      const newState = change.newValue;
      const oldState = change.oldValue;
      if (!newState) continue;

      handleTabStateChange(tabId, newState, oldState).catch(() => {});
    }
  });
}

// Responde a pedidos de identificação de aba/janela e gerenciamento de multitelas
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ORACLE_GET_TAB_INFO") {
    sendResponse({
      tabId: sender.tab?.id || null,
      windowId: sender.tab?.windowId || null,
    });
    return;
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

// Atualiza windowId quando a aba é movida para outra janela
if (typeof chrome !== "undefined" && chrome.tabs?.onAttached) {
  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    try {
      chrome.tabs.sendMessage(tabId, {
        type: "ORACLE_TAB_ATTACHED",
        windowId: attachInfo.newWindowId,
      }).catch(() => {});
    } catch (_) {}
  });
}

// Limpeza de abas fechadas para não deixar chaves órfãs no storage (I-01)
if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    try {
      chrome.storage.local.remove([
        `ifx:tab:${tabId}:state`,
        `ifx:tab:${tabId}:signals`,
        `ifx:tab:${tabId}:logs`,
      ]);
    } catch (_) {}
  });
}

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
