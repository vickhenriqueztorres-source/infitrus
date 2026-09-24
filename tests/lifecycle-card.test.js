import test from "node:test";
import assert from "node:assert/strict";
import { formatLifecycleCard } from "../src/ui/lifecycle-card.js";

test("formatLifecycleCard: SCANNING formata frase correta e calcula segundos restantes", () => {
  const formingTs = 1700000000;
  const snapshot = {
    pair: "EURUSD",
    current: {
      pair: "EURUSD",
      tf: 60,
      formingTs,
      targetTs: formingTs + 60,
      phase: "SCANNING",
    },
  };

  // Aos 10s da vela: faltam 35s para 45s
  const card1 = formatLifecycleCard(snapshot, formingTs + 10);
  assert.equal(card1.phase, "SCANNING");
  assert.equal(card1.primaryText, "Escuchando EURUSD · decisión en 35s");
  assert.equal(card1.secondsRemaining, 35);
  assert.equal(card1.ariaLive, "polite");
  assert.ok(card1.progressPct > 0);

  // Clamp em 0 quando passa de 45s
  const cardClamp = formatLifecycleCard(snapshot, formingTs + 50);
  assert.equal(cardClamp.primaryText, "Escuchando EURUSD · decisión en 0s");
  assert.equal(cardClamp.secondsRemaining, 0);
});

test("formatLifecycleCard: DECIDING formata frase e contagem até o segundo 58", () => {
  const formingTs = 1700000000;
  const snapshot = {
    pair: "EURUSD",
    current: {
      pair: "EURUSD",
      tf: 60,
      formingTs,
      targetTs: formingTs + 60,
      phase: "DECIDING",
    },
  };

  // Aos 50s da vela: faltam 8s para 58s
  const card = formatLifecycleCard(snapshot, formingTs + 50);
  assert.equal(card.phase, "DECIDING");
  assert.equal(card.primaryText, "Analizando cierre · decide en 8s");
  assert.equal(card.secondsRemaining, 8);

  // Clamp em 0 quando nowSec >= formingTs + 58
  const cardClamp = formatLifecycleCard(snapshot, formingTs + 59);
  assert.equal(cardClamp.primaryText, "Analizando cierre · decide en 0s");
  assert.equal(cardClamp.secondsRemaining, 0);
});

test("formatLifecycleCard: PRE_SIGNAL formata CALL e PUT com contagem regressiva até targetTs", () => {
  const formingTs = 1700000000;
  const targetTs = formingTs + 60;

  const snapshotCall = {
    pair: "EURUSD",
    current: {
      pair: "EURUSD",
      tf: 60,
      formingTs,
      targetTs,
      phase: "PRE_SIGNAL",
      direction: "CALL",
    },
  };

  // Aos 54s da vela: faltam 6s para a entrada no targetTs (60s)
  const cardCall = formatLifecycleCard(snapshotCall, formingTs + 54);
  assert.equal(cardCall.phase, "PRE_SIGNAL");
  assert.equal(cardCall.direction, "CALL");
  assert.equal(cardCall.primaryText, "PRE-SEÑAL CALL ▲ · entra en 6s");
  assert.equal(cardCall.secondsRemaining, 6);
  assert.equal(cardCall.badgeClass, "call");

  const snapshotPut = {
    pair: "AUDCAD",
    current: {
      pair: "AUDCAD",
      tf: 60,
      formingTs,
      targetTs,
      phase: "PRE_SIGNAL",
      direction: "PUT",
    },
  };

  // Aos 58s da vela: faltam 2s
  const cardPut = formatLifecycleCard(snapshotPut, formingTs + 58);
  assert.equal(cardPut.direction, "PUT");
  assert.equal(cardPut.primaryText, "PRE-SEÑAL PUT ▼ · entra en 2s");
  assert.equal(cardPut.badgeClass, "put");

  // Clamp em 0
  const cardClamp = formatLifecycleCard(snapshotPut, targetTs + 2);
  assert.equal(cardClamp.primaryText, "PRE-SEÑAL PUT ▼ · entra en 0s");
  assert.equal(cardClamp.secondsRemaining, 0);
});

test("formatLifecycleCard: NO_ENTRY formata aviso de sem entrada na vela", () => {
  const snapshot = {
    current: { phase: "NO_ENTRY" },
  };

  const card = formatLifecycleCard(snapshot, 1700000059);
  assert.equal(card.phase, "NO_ENTRY");
  assert.equal(card.primaryText, "Sin entrada en esta vela");
});

test("formatLifecycleCard: ENTRY_NOW usa destaque máximo, contagem de 5s e aria-live assertive", () => {
  const targetTs = 1700000060;
  const snapshot = {
    trade: {
      pair: "EURUSD",
      tf: 60,
      targetTs,
      phase: "ENTRY_NOW",
      direction: "CALL",
    },
  };

  // No segundo 1 da nova vela: faltam 4s da janela de 5s
  const card = formatLifecycleCard(snapshot, targetTs + 1);
  assert.equal(card.phase, "ENTRY_NOW");
  assert.equal(card.direction, "CALL");
  assert.equal(card.primaryText, "ENTRA AHORA — CALL ▲ · quedan 4s");
  assert.equal(card.secondsRemaining, 4);
  assert.equal(card.ariaLive, "assertive");
  assert.equal(card.badgeClass, "call");

  // Clamp em 0 após expirar a janela de 5s
  const cardClamp = formatLifecycleCard(snapshot, targetTs + 7);
  assert.equal(cardClamp.primaryText, "ENTRA AHORA — CALL ▲ · quedan 0s");
  assert.equal(cardClamp.secondsRemaining, 0);
});

test("formatLifecycleCard: IN_TRADE mantém o card principal na operação até o término da vela", () => {
  const tradeTargetTs = 1700000060;
  const currentFormingTs = tradeTargetTs; // Vela em que o trade está correndo (0 a 60s)

  const snapshot = {
    pair: "EURUSD",
    trade: {
      pair: "EURUSD",
      tf: 60,
      targetTs: tradeTargetTs,
      phase: "IN_TRADE",
      direction: "PUT",
      entryPrice: 1.08500,
    },
    current: {
      pair: "EURUSD",
      tf: 60,
      formingTs: currentFormingTs,
      targetTs: currentFormingTs + 60,
      phase: "SCANNING",
    },
  };

  // Aos 18s da nova vela: faltam 42s para expirar o trade (targetTs + 60)
  // O card principal PERMANECE em IN_TRADE com direção PUT
  const card = formatLifecycleCard(snapshot, tradeTargetTs + 18);
  assert.equal(card.phase, "IN_TRADE");
  assert.equal(card.direction, "PUT");
  assert.equal(card.primaryText, "OPERACIÓN EN CURSO — PUT ▼ · expira en 42s");
  assert.equal(card.secondaryText, "Entrada: 1.08500");
  assert.equal(card.badgeClass, "put");
  assert.equal(card.badgeText, "EN OPERACIÓN · PUT");
  assert.equal(card.secondsRemaining, 42);

  // Clamp na expiração
  const cardClamp = formatLifecycleCard(snapshot, tradeTargetTs + 65);
  assert.equal(cardClamp.secondsRemaining, 0);
  assert.ok(cardClamp.primaryText.includes("expira en 0s"));
});

test("formatLifecycleCard: IN_TRADE com novo PRE_SIGNAL na mesma vela exibe PRE_SIGNAL como primário e IN_TRADE como secundário", () => {
  const tradeTargetTs = 1700000060;
  const currentFormingTs = tradeTargetTs;

  const snapshot = {
    pair: "EURUSD",
    trade: {
      pair: "EURUSD",
      tf: 60,
      targetTs: tradeTargetTs,
      phase: "IN_TRADE",
      direction: "PUT",
    },
    current: {
      pair: "EURUSD",
      tf: 60,
      formingTs: currentFormingTs,
      targetTs: currentFormingTs + 60,
      phase: "PRE_SIGNAL",
      direction: "CALL",
    },
  };

  // Aos 52s: novo PRE_SIGNAL de CALL para a próxima vela, enquanto PUT está expirando em 8s
  const card = formatLifecycleCard(snapshot, tradeTargetTs + 52);
  assert.equal(card.phase, "PRE_SIGNAL");
  assert.equal(card.direction, "CALL");
  assert.equal(card.primaryText, "PRE-SEÑAL CALL ▲ · entra en 8s");
  assert.equal(card.secondaryText, "En operación PUT · expira en 8s");
});

test("formatLifecycleCard: SETTLED exibe resultado da operação (GANADA, PERDIDA, EMPATE)", () => {
  const settledAt = 1700000120;

  const snapWin = {
    lastResult: {
      phase: "SETTLED",
      result: "WIN",
      settledAt,
    },
  };
  const cardWin = formatLifecycleCard(snapWin, settledAt + 2);
  assert.equal(cardWin.phase, "SETTLED");
  assert.equal(cardWin.primaryText, "Resultado: GANADA");
  assert.equal(cardWin.badgeClass, "call");

  const snapLoss = {
    lastResult: {
      phase: "SETTLED",
      result: "LOSS",
      settledAt,
    },
  };
  const cardLoss = formatLifecycleCard(snapLoss, settledAt + 3);
  assert.equal(cardLoss.primaryText, "Resultado: PERDIDA");
  assert.equal(cardLoss.badgeClass, "put");

  const snapDoji = {
    lastResult: {
      phase: "SETTLED",
      result: "DOJI",
      settledAt,
    },
  };
  const cardDoji = formatLifecycleCard(snapDoji, settledAt + 4);
  assert.equal(cardDoji.primaryText, "Resultado: EMPATE");
  assert.equal(cardDoji.badgeClass, "wait");
});

test("formatLifecycleCard: CANCELLED formata motivo corretamente", () => {
  const snapUnstable = {
    current: {
      phase: "CANCELLED",
      reason: "DATA_UNSTABLE",
    },
  };
  const card1 = formatLifecycleCard(snapUnstable, 1700000055);
  assert.equal(card1.phase, "CANCELLED");
  assert.equal(card1.primaryText, "Señal cancelada · datos inestables");

  const snapAsset = {
    current: {
      phase: "CANCELLED",
      reason: "ASSET_CHANGED",
    },
  };
  const card2 = formatLifecycleCard(snapAsset, 1700000055);
  assert.equal(card2.primaryText, "Señal cancelada · cambiaste de activo");
});

test("formatLifecycleCard: TF_NOT_SUPPORTED avisa que só suporta M1", () => {
  const snapshot = {
    status: "TF_NOT_SUPPORTED",
    pair: "BTCUSD",
    tf: 300,
  };
  const card = formatLifecycleCard(snapshot, 1700000000);
  assert.equal(card.phase, "TF_NOT_SUPPORTED");
  assert.equal(card.primaryText, "Timeframe no soportado · usa M1");
});
