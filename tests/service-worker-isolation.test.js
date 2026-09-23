import test from "node:test";
import assert from "node:assert/strict";
import { handleTabStateChange } from "../src/background/notifications.js";

test("Service Worker Isolation: setBadgeText sempre recebe tabId e nunca é chamado sem tabId", async () => {
  const badgeCalls = [];
  const badgeColorCalls = [];
  const notifCalls = [];
  const sessionStore = {};

  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    action: {
      setBadgeText: (args) => {
        badgeCalls.push(args);
      },
      setBadgeBackgroundColor: (args) => {
        badgeColorCalls.push(args);
      },
    },
    storage: {
      session: {
        get: async (keys) => {
          const res = {};
          keys.forEach((k) => {
            if (sessionStore[k] !== undefined) res[k] = sessionStore[k];
          });
          return res;
        },
        set: async (obj) => {
          Object.assign(sessionStore, obj);
        },
      },
    },
    notifications: {
      create: async (id, opts) => {
        notifCalls.push({ id, opts });
      },
    },
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
    },
  };

  try {
    const newStateTab1 = {
      tabId: 1,
      windowId: 10,
      symbol: "EURUSD",
      lifecycle: {
        current: {
          id: "sig-sw-1",
          phase: "PRE_SIGNAL",
          direction: "CALL",
          pair: "EURUSD",
        },
      },
    };

    // 1. Dispara transição na aba 1
    await handleTabStateChange(1, newStateTab1);

    assert.equal(badgeCalls.length, 1);
    assert.equal(badgeCalls[0].tabId, 1);
    assert.equal(badgeCalls[0].text, "▲");
    assert.ok(badgeCalls[0].tabId !== undefined, "tabId é obrigatório");

    assert.equal(badgeColorCalls.length, 1);
    assert.equal(badgeColorCalls[0].tabId, 1);

    // Notificação disparada pela primeira vez
    assert.equal(notifCalls.length, 1);
    assert.ok(notifCalls[0].opts.title.includes("EURUSD"));
    assert.ok(notifCalls[0].opts.title.includes("CALL"));

    // 2. Mesma fase disparada uma segunda vez na aba 1: NÃO pode duplicar a notificação
    await handleTabStateChange(1, newStateTab1);

    assert.equal(notifCalls.length, 1, "Deduplicação impediu segunda notificação para a mesma fase");

    // 3. Transição na aba 2 não afeta a aba 1 e passa tabId: 2
    const newStateTab2 = {
      tabId: 2,
      windowId: 20,
      symbol: "AUDCAD",
      lifecycle: {
        current: {
          id: "sig-sw-2",
          phase: "PRE_SIGNAL",
          direction: "PUT",
          pair: "AUDCAD",
        },
      },
    };

    await handleTabStateChange(2, newStateTab2);

    assert.equal(badgeCalls.length, 3);
    assert.equal(badgeCalls[2].tabId, 2);
    assert.equal(badgeCalls[2].text, "▼");

    // 4. Sem sinal ativo na aba 1 limpa badge exclusivamente com tabId: 1
    const clearedStateTab1 = {
      tabId: 1,
      windowId: 10,
      symbol: "EURUSD",
      lifecycle: { current: null, trade: null },
    };

    await handleTabStateChange(1, clearedStateTab1);

    assert.equal(badgeCalls.length, 4);
    assert.equal(badgeCalls[3].tabId, 1);
    assert.equal(badgeCalls[3].text, "");

    // Garante que NENHUMA chamada de setBadgeText ocorreu sem tabId
    badgeCalls.forEach((call) => {
      assert.ok(Number.isInteger(call.tabId), "Todas as chamadas setBadgeText devem especificar tabId numérico");
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});
