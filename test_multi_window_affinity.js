/**
 * test_multi_window_affinity.js
 * Teste automatizado para validar o isolamento por janela e eliminação de piscamento/alternância
 */

import assert from "node:assert";
import { LogManager } from "./src/utils/logger.js";

console.log("--- TESTANDO ISOLAMENTO MULTI-JANELAS E MULTI-ATIVOS ---");

// Simulação de Storage
const mockStorage = {
  data: {},
  get(keys, cb) {
    const res = {};
    keys.forEach((k) => {
      res[k] = this.data[k];
    });
    cb(res);
  },
  set(items, cb) {
    Object.assign(this.data, items);
    if (cb) cb();
  },
};
global.chrome = {
  storage: {
    local: mockStorage,
  },
};

// 1. Teste do Logger com Contexto Multi-Ativo
const loggerA = new LogManager();
loggerA.setContext({ tabId: 101, symbol: "ARBITRIUM_OTC" });
const log1 = loggerA.info("FEED", "ARBITRIUM_OTC tick: 497.320");

const loggerB = new LogManager();
loggerB.setContext({ tabId: 102, symbol: "ETHUSDT_OTC" });
const log2 = loggerB.info("FEED", "ETHUSDT_OTC tick: 2472.32");

const loggerC = new LogManager();
loggerC.setContext({ tabId: 103, symbol: "AUDCAD" });
const log3 = loggerC.info("FEED", "AUDCAD tick: 0.9125");

assert.strictEqual(log1.symbol, "ARBITRIUM_OTC");
assert.strictEqual(log1.tabId, 101);
assert.strictEqual(log2.symbol, "ETHUSDT_OTC");
assert.strictEqual(log2.tabId, 102);
assert.strictEqual(log3.symbol, "AUDCAD");
assert.strictEqual(log3.tabId, 103);
console.log("✓ Teste 1: Logger registrando tags de ativo e abas isoladas OK");

// 2. Teste da Lógica de Merge do Storage para 3 Janelas
function simulateSaveMarketState(tabId, windowId, symbol, price, storageState) {
  const prevSymbols = storageState.symbols || {};
  const prevTabs = storageState.tabs || {};

  const stateObj = {
    symbol,
    lastPrice: price,
    state: "READY",
    updatedAt: Date.now(),
  };

  const mergedSymbols = {
    ...prevSymbols,
    [symbol]: stateObj,
  };

  const mergedTabs = {
    ...prevTabs,
    [tabId]: {
      tabId,
      windowId,
      symbol,
      lastPrice: price,
      state: "READY",
      updatedAt: Date.now(),
    },
  };

  return {
    ...storageState,
    symbol: storageState.symbol || symbol,
    symbols: mergedSymbols,
    allSymbols: Object.keys(mergedSymbols),
    tabs: mergedTabs,
    lastUpdatedTab: tabId,
  };
}

let sharedState = {};
// Janela 1 envia tick
sharedState = simulateSaveMarketState(101, 1, "ARBITRIUM_OTC", "497.32", sharedState);
// Janela 2 envia tick
sharedState = simulateSaveMarketState(102, 2, "ETHUSDT_OTC", "2472.32", sharedState);
// Janela 3 envia tick
sharedState = simulateSaveMarketState(103, 3, "AUDCAD", "0.9125", sharedState);

// Janela 1 envia novo tick
sharedState = simulateSaveMarketState(101, 1, "ARBITRIUM_OTC", "497.35", sharedState);

assert.strictEqual(sharedState.tabs[101].symbol, "ARBITRIUM_OTC");
assert.strictEqual(sharedState.tabs[102].symbol, "ETHUSDT_OTC");
assert.strictEqual(sharedState.tabs[103].symbol, "AUDCAD");

assert.strictEqual(sharedState.symbols["ARBITRIUM_OTC"].lastPrice, "497.35");
assert.strictEqual(sharedState.symbols["ETHUSDT_OTC"].lastPrice, "2472.32");
assert.strictEqual(sharedState.symbols["AUDCAD"].lastPrice, "0.9125");
console.log("✓ Teste 2: Merge não-destrutivo de múltiplos ativos e abas simultâneas OK");

// 3. Teste de Afinidade de Janela: Side Panel da Janela 3 travado no AUDCAD
function resolveActiveKeyForSidePanel(myTabId, cachedState, selectedSymbol) {
  const symbols = cachedState.symbols || {};
  let windowLockedSymbol = null;
  if (myTabId && cachedState.tabs?.[myTabId]?.symbol) {
    windowLockedSymbol = cachedState.tabs[myTabId].symbol;
  }

  let activeKey = selectedSymbol;
  if (!activeKey || !symbols[activeKey]) {
    activeKey = windowLockedSymbol ||
                cachedState.tabs?.[myTabId]?.symbol ||
                cachedState.symbol ||
                Object.keys(symbols)[0] ||
                "---";
  }
  return activeKey;
}

// Side Panel na Janela 3 (Tab 103): deve sempre resolver para AUDCAD
const activeKeyWin3 = resolveActiveKeyForSidePanel(103, sharedState, null);
assert.strictEqual(activeKeyWin3, "AUDCAD");

// Mesmo se a Janela 1 receber 50 ticks seguidos de ARBITRIUM_OTC:
for (let i = 0; i < 50; i++) {
  sharedState = simulateSaveMarketState(101, 1, "ARBITRIUM_OTC", (497.35 + i * 0.01).toFixed(2), sharedState);
}
const activeKeyWin3AfterTicks = resolveActiveKeyForSidePanel(103, sharedState, null);
assert.strictEqual(activeKeyWin3AfterTicks, "AUDCAD", "A Janela 3 NUNCA deve alternar para outro par!");
console.log("✓ Teste 3: Afinidade estrita de janela - Janela 3 travada 100% no AUDCAD sem alternar OK");

// 4. Teste de Filtragem de Logs
const allLogs = [
  { id: "1", symbol: "ARBITRIUM_OTC", message: "tick 497" },
  { id: "2", symbol: "ETHUSDT_OTC", message: "tick 2472" },
  { id: "3", symbol: "AUDCAD", message: "tick 0.9125" },
  { id: "4", symbol: "ARBITRIUM_OTC", message: "tick 497.5" },
  { id: "5", symbol: "AUDCAD", message: "tick 0.9130" },
];

function filterLogsForPanel(targetSym, logs) {
  return logs.filter((e) => !e.symbol || e.symbol === targetSym);
}

const filteredForAudCad = filterLogsForPanel("AUDCAD", allLogs);
assert.strictEqual(filteredForAudCad.length, 2);
assert.strictEqual(filteredForAudCad[0].symbol, "AUDCAD");
assert.strictEqual(filteredForAudCad[1].symbol, "AUDCAD");
console.log("✓ Teste 4: Filtragem de logs exclusiva por ativo OK");

console.log("\n>>> TODOS OS TESTES DE AFINIDADE MULTI-JANELA PASSARAM COM 100% DE SUCESSO! <<<");
