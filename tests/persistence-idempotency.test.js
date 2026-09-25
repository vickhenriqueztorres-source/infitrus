/**
 * persistence-idempotency.test.js
 * Testes para Etapa 4: Idempotência de persistência transacional (settleSignal, cancelSignal e sequenciamento)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SignalStore } from "../src/storage/signal-store.js";
import { handleServiceWorkerMessage } from "../src/background/service-worker.js";

test("Etapa 4: settleSignal é atômico e estritamente idempotente", async () => {
  const store = new SignalStore({ dbName: "test_db_settle", storeName: "signals" });
  await store.clear();

  const id = "EURUSD:60:1727180000:1.0.0";
  const signal = {
    id,
    symbol: "EURUSD",
    timeframe: 60,
    candleTimestamp: 1727180000,
    action: "CALL",
    entryPrice: 1.08500,
    seq: 1,
    status: "PENDING",
    createdAt: Date.now(),
  };

  await store.putSignal(signal);

  // Primeira liquidação: deve retornar o registro liquidado
  const settled1 = await store.settleSignal(id, {
    result: "WIN",
    closePrice: 1.08550,
    settledAt: Date.now(),
  });
  assert.ok(settled1, "Primeira liquidação deve retornar o registro");
  assert.equal(settled1.status, "SETTLED");
  assert.equal(settled1.result, "WIN");
  assert.equal(settled1.closePrice, 1.08550);

  const rec1 = await store.getSignalById(id);
  assert.equal(rec1.status, "SETTLED");
  assert.equal(rec1.result, "WIN");
  assert.equal(rec1.closePrice, 1.08550);

  // Segunda liquidação (idêntica ou reenviada): deve ser idempotente
  const settled2 = await store.settleSignal(id, {
    result: "WIN",
    closePrice: 1.08550,
    settledAt: Date.now(),
  });
  assert.ok(settled2, "Segunda liquidação idempotente deve retornar o registro");
  assert.equal(settled2.result, "WIN", "Resultado original WIN deve ser preservado");

  // Liquidação de ID inexistente
  const settledNonExistent = await store.settleSignal("NON_EXISTENT", { result: "LOSS" });
  assert.equal(settledNonExistent, null, "ID inexistente deve retornar null");
});

test("Etapa 4: cancelSignal é atômico e idempotente", async () => {
  const store = new SignalStore({ dbName: "test_db_cancel", storeName: "signals" });
  await store.clear();

  const id = "EURUSD:60:1727180060:1.0.0";
  const signal = {
    id,
    symbol: "EURUSD",
    timeframe: 60,
    candleTimestamp: 1727180060,
    action: "PUT",
    entryPrice: 1.08600,
    seq: 2,
    status: "PENDING",
    createdAt: Date.now(),
  };

  await store.putSignal(signal);

  // Primeiro cancelamento
  const cancel1 = await store.cancelSignal(id, "SPREAD_TOO_HIGH");
  assert.ok(cancel1, "Primeiro cancelamento deve retornar o registro");
  assert.equal(cancel1.status, "CANCELLED");
  assert.equal(cancel1.cancelReason, "SPREAD_TOO_HIGH");

  const rec1 = await store.getSignalById(id);
  assert.equal(rec1.status, "CANCELLED");
  assert.equal(rec1.cancelReason, "SPREAD_TOO_HIGH");

  // Segundo cancelamento repetido
  const cancel2 = await store.cancelSignal(id, "SPREAD_TOO_HIGH");
  assert.ok(cancel2, "Cancelamento repetido deve retornar o registro de forma idempotente");
  assert.equal(cancel2.status, "CANCELLED");

  // Não cancela se ID não existe
  const cancelNonExistent = await store.cancelSignal("GHOST_SIGNAL", "TIMEOUT");
  assert.equal(cancelNonExistent, null, "Sinal inexistente deve retornar null");
});

test("Etapa 4: Mensagens do Service Worker com ORACLE_SETTLE_SIGNAL e ORACLE_CANCEL_SIGNAL", async () => {
  const sender = { tab: { id: 99 }, frameId: 0 };

  // Grava sinal
  const sigId = `TEST_SW_${Date.now()}`;
  let recordResp = null;
  await new Promise((resolve) => {
    handleServiceWorkerMessage(
      {
        type: "ORACLE_RECORD_SIGNAL",
        signal: {
          id: sigId,
          symbol: "ARBITRIUM",
          action: "CALL",
          candleTimestamp: 1727180120,
        },
      },
      sender,
      (res) => {
        recordResp = res;
        resolve();
      }
    );
  });

  assert.ok(recordResp && recordResp.ok, "Service worker deve gravar o sinal com sucesso");
  assert.ok(typeof recordResp.signal?.seq === "number", "Deve atribuir seq monotônico");

  // Settle via SW
  let settleResp = null;
  await new Promise((resolve) => {
    handleServiceWorkerMessage(
      {
        type: "ORACLE_SETTLE_SIGNAL",
        id: sigId,
        outcome: { result: "WIN", closePrice: 500.25 },
      },
      sender,
      (res) => {
        settleResp = res;
        resolve();
      }
    );
  });
  assert.ok(settleResp && settleResp.ok, "Service worker deve liquidar via mensagem");
  assert.equal(settleResp.signal.status, "SETTLED");
  assert.equal(settleResp.signal.result, "WIN");

  // Settle duplicado via SW (idempotência)
  let settleResp2 = null;
  await new Promise((resolve) => {
    handleServiceWorkerMessage(
      {
        type: "ORACLE_SETTLE_SIGNAL",
        id: sigId,
        outcome: { result: "WIN", closePrice: 500.25 },
      },
      sender,
      (res) => {
        settleResp2 = res;
        resolve();
      }
    );
  });
  assert.ok(settleResp2 && settleResp2.ok, "Service worker deve responder com sucesso de forma idempotente");
  assert.equal(settleResp2.signal.status, "SETTLED");
});
