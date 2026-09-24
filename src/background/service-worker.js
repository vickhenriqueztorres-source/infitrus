import { handleTabStateChange } from "./notifications.js";

function configureDockedPanel() {
  if (typeof chrome === "undefined" || !chrome.sidePanel?.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

configureDockedPanel();

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    console.log("[Inflitrus] Extensión instalada.");
    configureDockedPanel();
    try {
      chrome.storage.local.clear().catch(() => {});
    } catch (_) {}
  });
}

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

function getSessionStorage(keys, callback) {
  const store = chrome.storage?.session || chrome.storage?.local;
  if (!store?.get) {
    callback({});
    return;
  }
  try {
    const res = store.get(keys, (data) => callback(data || {}));
    if (res instanceof Promise) {
      res.then((data) => callback(data || {})).catch(() => callback({}));
    }
  } catch (_) {
    callback({});
  }
}

function setSessionStorage(obj, callback = () => {}) {
  const store = chrome.storage?.session || chrome.storage?.local;
  if (!store?.set) {
    callback();
    return;
  }
  try {
    const res = store.set(obj, callback);
    if (res instanceof Promise) {
      res.then(() => callback()).catch(() => callback());
    }
  } catch (_) {
    callback();
  }
}

function removeSessionStorage(keys, callback = () => {}) {
  const store = chrome.storage?.session || chrome.storage?.local;
  if (!store?.remove) {
    callback();
    return;
  }
  try {
    const res = store.remove(keys, callback);
    if (res instanceof Promise) {
      res.then(() => callback()).catch(() => callback());
    }
  } catch (_) {
    callback();
  }
}

export function handleServiceWorkerMessage(message, sender, sendResponse) {
  if (message?.type === "ORACLE_GET_TAB_INFO") {
    sendResponse({
      tabId: sender?.tab?.id || null,
      windowId: sender?.tab?.windowId || null,
    });
    return;
  }

  // Trava de instância única por aba: CLAIM_COMPUTE
  if (message?.type === "CLAIM_COMPUTE") {
    const tabId = sender?.tab?.id || message.tabId;
    const frameId = sender?.frameId !== undefined ? sender.frameId : (message.frameId ?? 0);
    if (!tabId) {
      sendResponse({ granted: false, reason: "NO_TAB_ID" });
      return;
    }
    const key = `ifx:compute-owner:${tabId}`;
    const now = Date.now();

    getSessionStorage([key], (res) => {
      const existing = res?.[key];
      // Se já houver dono vivo (heartbeat < 5s) e frameId diferente: DENIED
      if (existing && existing.frameId !== frameId && (now - existing.lastHeartbeat < 5000)) {
        sendResponse({ granted: false, reason: "DENIED" });
        return;
      }
      setSessionStorage(
        {
          [key]: { frameId, lastHeartbeat: now },
        },
        () => {
          sendResponse({ granted: true, frameId, tabId });
        }
      );
    });
    return true;
  }

  if (message?.type === "COMPUTE_HEARTBEAT") {
    const tabId = sender?.tab?.id || message.tabId;
    const frameId = sender?.frameId !== undefined ? sender.frameId : (message.frameId ?? 0);
    if (!tabId) {
      sendResponse({ ok: false, reason: "NO_TAB_ID" });
      return;
    }
    const key = `ifx:compute-owner:${tabId}`;
    const now = Date.now();

    getSessionStorage([key], (res) => {
      const existing = res?.[key];
      if (existing && existing.frameId === frameId) {
        setSessionStorage(
          {
            [key]: { frameId, lastHeartbeat: now },
          },
          () => {
            sendResponse({ ok: true });
          }
        );
      } else {
        sendResponse({ ok: false, reason: "NOT_OWNER" });
      }
    });
    return true;
  }

  if (message?.type === "RELEASE_COMPUTE") {
    const tabId = sender?.tab?.id || message.tabId;
    const frameId = sender?.frameId !== undefined ? sender.frameId : (message.frameId ?? 0);
    if (!tabId) {
      sendResponse({ released: false });
      return;
    }
    const key = `ifx:compute-owner:${tabId}`;
    getSessionStorage([key], (res) => {
      const existing = res?.[key];
      if (existing && existing.frameId === frameId) {
        removeSessionStorage([key], () => {
          sendResponse({ released: true });
        });
      } else {
        sendResponse({ released: false });
      }
    });
    return true;
  }

  // Toda escrita em ifx:tab:<tabId>:state passa pelo SW e é rejeitada se sender.frameId !== owner
  if (message?.type === "ORACLE_SAVE_TAB_STATE") {
    const tabId = sender?.tab?.id || message.tabId;
    const frameId = sender?.frameId !== undefined ? sender.frameId : (message.frameId ?? 0);
    if (!tabId) {
      sendResponse({ saved: false, reason: "NO_TAB_ID" });
      return;
    }
    const key = `ifx:compute-owner:${tabId}`;
    const now = Date.now();

    getSessionStorage([key], (res) => {
      const existing = res?.[key];
      if (existing && existing.frameId !== frameId && (now - existing.lastHeartbeat < 5000)) {
        sendResponse({ saved: false, reason: "DENIED_NOT_OWNER" });
        return;
      }

      if (chrome.storage?.local?.set) {
        chrome.storage.local.set(
          {
            [`ifx:tab:${tabId}:state`]: message.state,
          },
          () => {
            sendResponse({ saved: true });
          }
        );
      } else {
        sendResponse({ saved: false, reason: "NO_LOCAL_STORAGE" });
      }
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
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(handleServiceWorkerMessage);
}

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
      removeSessionStorage([`ifx:compute-owner:${tabId}`]);
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
