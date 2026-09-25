/**
 * dual-card-lifecycle.test.js
 * Teste para Etapa 5: Interface sem ambiguidade com duas áreas independentes (Operação Atual vs Próxima Oportunidade)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { formatLifecycleCard } from "../src/ui/lifecycle-card.js";

test("Etapa 5: formatLifecycleCard separa estritamente tradeCard e opportunityCard em composite snapshot", () => {
  const nowSec = 1727180055; // 55s dentro da vela

  // Simula situação crítica do vídeo aos 00:08:
  // Operação em curso em PUT EURUSD, e pré-sinal de CALL na vela formadora seguinte
  const compositeSnapshot = {
    pair: "EURUSD",
    tf: 60,
    trade: {
      phase: "IN_TRADE",
      direction: "PUT",
      entryPrice: 1.08620,
      targetTs: 1727180000,
      pair: "EURUSD",
    },
    current: {
      phase: "PRE_SIGNAL",
      direction: "CALL",
      targetTs: 1727180060,
      pair: "EURUSD",
    },
  };

  const formatted = formatLifecycleCard(compositeSnapshot, nowSec);

  // 1. O tradeCard deve refletir exclusivamente a operação em curso (PUT)
  assert.ok(formatted.tradeCard, "Deve conter tradeCard estruturado");
  assert.equal(formatted.tradeCard.hasTrade, true);
  assert.equal(formatted.tradeCard.phase, "IN_TRADE");
  assert.equal(formatted.tradeCard.direction, "PUT");
  assert.equal(formatted.tradeCard.badgeClass, "put");
  assert.equal(formatted.tradeCard.entryPrice, 1.08620);
  assert.equal(formatted.tradeCard.secondsRemaining, 5); // 1727180060 - 1727180055 = 5s

  // 2. O opportunityCard deve refletir a próxima oportunidade estatística (CALL)
  assert.ok(formatted.opportunityCard, "Deve conter opportunityCard estruturado");
  assert.equal(formatted.opportunityCard.hasOpportunity, true);
  assert.equal(formatted.opportunityCard.phase, "PRE_SIGNAL");
  assert.equal(formatted.opportunityCard.direction, "CALL");
  assert.equal(formatted.opportunityCard.badgeClass, "call");
  assert.equal(formatted.opportunityCard.secondsRemaining, 5);

  // 3. Os dois blocos coexistem sem colisão de estado ou direção
  assert.notEqual(
    formatted.tradeCard.direction,
    formatted.opportunityCard.direction,
    "Direções opostas não devem se sobrescrever ou oscilar"
  );
});

test("Etapa 5: Estado sem operação ativa (NO_TRADE) e apenas escaneamento (SCANNING)", () => {
  const nowSec = 1727180020;
  const snapshot = {
    pair: "ARBITRIUM",
    tf: 60,
    current: {
      phase: "SCANNING",
      formingTs: 1727180000,
    },
    trade: null,
  };

  const formatted = formatLifecycleCard(snapshot, nowSec);

  assert.equal(formatted.tradeCard.hasTrade, false);
  assert.equal(formatted.tradeCard.phase, "NO_TRADE");
  assert.equal(formatted.tradeCard.badgeText, "SIN OPERACIÓN");

  assert.equal(formatted.opportunityCard.hasOpportunity, false);
  assert.equal(formatted.opportunityCard.phase, "SCANNING");
  assert.equal(formatted.opportunityCard.badgeText, "ESCANEANDO");
});
