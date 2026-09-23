/**
 * active-channel.test.js - Testes do Rastreamento Estrito de Canal e Ativo (I-03, I-04, I-10)
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ActiveChannel } from "../src/market/active-channel.js";

test("ActiveChannel: Início sem dados retorna null", () => {
  const channel = new ActiveChannel();
  assert.equal(channel.get(), null);
});

test("ActiveChannel: Subscribe torna o ativo atual", () => {
  const channel = new ActiveChannel();
  let changeCount = 0;
  let lastChange = null;

  channel.onChange((next, prev) => {
    changeCount++;
    lastChange = { next, prev };
  });

  channel.onChannel({ action: "subscribe", pair: "EURUSD", tf: 60, at: 1000 });

  assert.deepEqual(channel.get(), { pair: "EURUSD", tf: 60 });
  assert.equal(changeCount, 1);
  assert.deepEqual(lastChange.next, { pair: "EURUSD", tf: 60 });
  assert.equal(lastChange.prev, null);
});

test("ActiveChannel: Unsubscribe remove o ativo correspondente", () => {
  const channel = new ActiveChannel();
  channel.onChannel({ action: "subscribe", pair: "EURUSD", tf: 60, at: 1000 });
  assert.deepEqual(channel.get(), { pair: "EURUSD", tf: 60 });

  channel.onChannel({ action: "unsubscribe", pair: "EURUSD", tf: 60, at: 1050 });
  assert.equal(channel.get(), null);
});

test("ActiveChannel: Troca rápida A -> B -> A", () => {
  const channel = new ActiveChannel();
  const history = [];

  channel.onChange((next) => {
    history.push(next ? next.pair : null);
  });

  // 1. Assina AUDCAD
  channel.onChannel({ action: "subscribe", pair: "AUDCAD", tf: 60, at: 1000 });
  assert.equal(channel.get()?.pair, "AUDCAD");

  // 2. Desinscreve AUDCAD e assina EURUSD
  channel.onChannel({ action: "unsubscribe", pair: "AUDCAD", tf: 60, at: 1010 });
  channel.onChannel({ action: "subscribe", pair: "EURUSD", tf: 60, at: 1015 });
  assert.equal(channel.get()?.pair, "EURUSD");

  // 3. Desinscreve EURUSD e assina novamente AUDCAD
  channel.onChannel({ action: "unsubscribe", pair: "EURUSD", tf: 60, at: 1020 });
  channel.onChannel({ action: "subscribe", pair: "AUDCAD", tf: 60, at: 1025 });
  assert.equal(channel.get()?.pair, "AUDCAD");

  // Histórico de transições
  assert.deepEqual(history, ["AUDCAD", null, "EURUSD", null, "AUDCAD"]);
});

test("ActiveChannel: Fallback por histórico quando não há subscribes", () => {
  const channel = new ActiveChannel();

  channel.onHistory("BTCUSD", 60);
  assert.deepEqual(channel.get(), { pair: "BTCUSD", tf: 60 });

  // Se depois houver subscribe, subscribe tem precedência
  channel.onChannel({ action: "subscribe", pair: "ETHUSD", tf: 60, at: 2000 });
  assert.deepEqual(channel.get(), { pair: "ETHUSD", tf: 60 });

  // Se ETHUSD for cancelado, volta ao último histórico (BTCUSD)
  channel.onChannel({ action: "unsubscribe", pair: "ETHUSD", tf: 60, at: 2050 });
  assert.deepEqual(channel.get(), { pair: "BTCUSD", tf: 60 });
});

test("ActiveChannel: Empate de timestamp entre subscribes favorece o último histórico", () => {
  const channel = new ActiveChannel();

  channel.onHistory("AUDCAD", 60);

  // Dois subscribes com mesmo timestamp
  channel.onChannel({ action: "subscribe", pair: "EURUSD", tf: 60, at: 5000 });
  channel.onChannel({ action: "subscribe", pair: "AUDCAD", tf: 60, at: 5000 });

  // AUDCAD desempata por causa do histórico
  assert.deepEqual(channel.get(), { pair: "AUDCAD", tf: 60 });
});
