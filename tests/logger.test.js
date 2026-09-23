/**
 * logger.test.js - Testes do Gerenciador de Logs e Auditoria
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";
import { LogManager } from "../src/utils/logger.js";

test("LogManager: Ingestão de logs, tags e níveis semânticos", () => {
  const mgr = new LogManager({ maxLogs: 5 });

  const entry = mgr.add("FEED", "Tick EURUSD recebido", "info");
  assert.equal(entry.tag, "FEED");
  assert.equal(entry.message, "Tick EURUSD recebido");
  assert.equal(entry.level, "info");
  assert.ok(entry.time.length >= 8);
  assert.equal(mgr.getLogs().length, 1);

  mgr.success("SINAL", "COMPRA disparada");
  mgr.warn("WS", "Socket oscilando");
  mgr.error("ERRO", "Falha de rede");

  const logs = mgr.getLogs();
  assert.equal(logs.length, 4);
  assert.equal(logs[1].tag, "SINAL");
  assert.equal(logs[1].level, "success");
  assert.equal(logs[2].tag, "WS");
  assert.equal(logs[2].level, "warn");
  assert.equal(logs[3].tag, "ERRO");
  assert.equal(logs[3].level, "error");
});

test("LogManager: Limite do buffer circular (maxLogs)", () => {
  const mgr = new LogManager({ maxLogs: 3 });

  mgr.info("TAG", "Msg 1");
  mgr.info("TAG", "Msg 2");
  mgr.info("TAG", "Msg 3");
  assert.equal(mgr.getLogs().length, 3);
  assert.equal(mgr.getLogs()[0].message, "Msg 1");

  mgr.info("TAG", "Msg 4");
  const logs = mgr.getLogs();
  assert.equal(logs.length, 3);
  assert.equal(logs[0].message, "Msg 2");
  assert.equal(logs[2].message, "Msg 4");
});

test("LogManager: Assinatura reativa (subscribe) e limpeza (clear)", () => {
  const mgr = new LogManager({ maxLogs: 10 });
  const received = [];

  const unsubscribe = mgr.subscribe((entry, allLogs) => {
    if (entry) received.push(entry.message);
  });

  mgr.info("FEED", "Evento 1");
  mgr.info("FEED", "Evento 2");
  assert.deepEqual(received, ["Evento 1", "Evento 2"]);

  mgr.clear();
  assert.equal(mgr.getLogs().length, 0);

  unsubscribe();
  mgr.info("FEED", "Evento 3");
  assert.equal(received.length, 2); // Não deve ter recebido após unsubscribe
});
