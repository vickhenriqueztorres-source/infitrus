/**
 * diagnostics-and-telemetry.test.js
 * Testes para Etapa 8: Logs por evento, métricas de desempenho, janela 45-57s e exportação
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LogManager } from "../src/utils/logger.js";
import { translateLogTag } from "../src/ui/components/layout.js";
import { MarketAnalyzer } from "../src/content/analyzer.js";
import { swBuildExportBundle, swIngestRecord, swResetRecords } from "../src/diagnostics/flight-recorder.js";

test("Etapa 8: LogManager prioriza contexto por evento e armazena metadados estruturados", () => {
  const logger = new LogManager({ maxLogs: 20 });
  logger.setContext({ symbol: "GLOBAL_CTX", tabId: 10 });

  // Evento 1: Sem símbolo explícito -> usa do contexto
  const e1 = logger.info("FEED", "Tick recebido");
  assert.equal(e1.symbol, "GLOBAL_CTX");
  assert.equal(e1.tabId, 10);

  // Evento 2: Com símbolo explícito de outro par -> prioriza o símbolo do evento
  const e2 = logger.info("SINAL", "Pré-sinal gerado", {
    symbol: "1000SATS_OTC",
    timeframe: 60,
    targetTs: 1727180000,
    seq: 42,
    latencyMs: 12.5,
  });
  assert.equal(e2.symbol, "1000SATS_OTC", "Deve priorizar símbolo do evento sobre o contexto global");
  assert.equal(e2.targetTs, 1727180000);
  assert.equal(e2.seq, 42);
  assert.equal(e2.latencyMs, 12.5);

  // Evento 3: Tag semântica ACCESSORY_ENDPOINT com flag isAccessory
  const e3 = logger.warn("ACCESSORY_ENDPOINT", "Falha HTTP 502 em /api/ranking", {
    isAccessory: true,
    symbol: "EURUSD",
  });
  assert.equal(e3.tag, "ACCESSORY_ENDPOINT");
  assert.equal(e3.isAccessory, true);
  assert.equal(translateLogTag(e3.tag), "REST ACCESORIO");
});

test("Etapa 8: translateLogTag traduz todas as novas tags semânticas da Etapa 8", () => {
  assert.equal(translateLogTag("FEED_HEALTH"), "SALUD FEED");
  assert.equal(translateLogTag("PLATFORM_ALERT"), "ALERTA BROKER");
  assert.equal(translateLogTag("ACCESSORY_ENDPOINT"), "REST ACCESORIO");
  assert.equal(translateLogTag("QUANT_EVAL"), "EVAL QUANT");
  assert.equal(translateLogTag("EXTENSION_ERROR"), "ERROR EXT");
  assert.equal(translateLogTag("PERF"), "RENDIMIENTO");
});

test("Etapa 8: MarketAnalyzer contabiliza avaliações na janela 45-57s e custo por ativo", () => {
  const analyzer = new MarketAnalyzer();

  // Simula avaliações dentro da janela 45-57s
  analyzer._recordEvalDuration(8.5, "EURUSD", true);
  analyzer._recordEvalDuration(12.0, "EURUSD", true);
  analyzer._recordEvalDuration(15.2, "ARBITRIUM", true);

  // Simula avaliação em candle fechado
  analyzer._recordEvalDuration(18.0, "EURUSD", false);

  assert.equal(analyzer._evalDurations.length, 4);
  assert.equal(analyzer._windowEvalsCount, 3, "Deve registrar 3 avaliações na janela 45-57s");
  assert.equal(analyzer._closedCandleEvalsCount, 1, "Deve registrar 1 avaliação em vela fechada");

  const eurCost = analyzer._costBySymbol.get("EURUSD");
  assert.ok(eurCost);
  assert.equal(eurCost.count, 3);
  assert.equal(eurCost.lastMs, 18.0);

  const arbCost = analyzer._costBySymbol.get("ARBITRIUM");
  assert.ok(arbCost);
  assert.equal(arbCost.count, 1);
  assert.equal(arbCost.lastMs, 15.2);

  // Ao emitir _logPerfMetrics, métricas são reportadas e contadores resetados
  analyzer._logPerfMetrics();
  assert.equal(analyzer._evalDurations.length, 0);
  assert.equal(analyzer._windowEvalsCount, 0);
  assert.equal(analyzer._closedCandleEvalsCount, 0);
  assert.equal(analyzer._costBySymbol.size, 0);
  analyzer.destroy();
});

test("Etapa 8: Desacoplamento de cronômetro vs escrita persistente (throttling inteligente)", () => {
  global.chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        if (cb) cb({ saved: true });
      },
    },
    storage: {
      session: {
        set: async () => {},
        get: async () => ({}),
      },
    },
  };

  const analyzer = new MarketAnalyzer();
  analyzer.tabId = 123;
  analyzer.currentSymbol = "EURUSD";

  const initialSeq = analyzer._writeSeq || 0;

  // Primeira escrita (estado inicial): deve persistir
  const stateObj = analyzer.buildPanelData();
  analyzer.saveMarketStateToStorage(stateObj, { immediate: false });
  const seqAfterFirst = analyzer._writeSeq;
  assert.ok(seqAfterFirst > initialSeq, "Primeira escrita de estado deve gravar");

  // Segunda chamada idêntica (apenas 1 segundo depois no cronômetro, sem mudança funcional): NÃO deve persistir
  analyzer.saveMarketStateToStorage(stateObj, { immediate: false });
  assert.equal(analyzer._writeSeq, seqAfterFirst, "Cronômetro sem mudança de fase não deve regravar no storage");

  // Mudança funcional com evento imediato (ex: transição para PRE_SIGNAL): deve persistir
  stateObj.lifecycle = {
    current: { phase: "PRE_SIGNAL", direction: "CALL", targetTs: 1727180060 }
  };
  analyzer.saveMarketStateToStorage(stateObj, { immediate: true });
  assert.ok(analyzer._writeSeq > seqAfterFirst, "Mudança de fase deve gravar imediatamente no storage");

  analyzer.destroy();
  delete global.chrome;
});

test("Etapa 8: swBuildExportBundle compila pacote diagnóstico com USER_MARK enriquecido", async () => {
  swResetRecords();

  // Ingestão de USER_MARK com contexto enriquecido
  const mark = {
    note: "Teste de conferência visual 00:08",
    timestamp: 1727180055000,
    symbol: "EURUSD",
    tabId: 55,
    tradeCard: { phase: "IN_TRADE", direction: "PUT" },
    opportunityCard: { phase: "PRE_SIGNAL", direction: "CALL" },
    writeSeq: 14,
  };
  swIngestRecord({ type: "USER_MARK", payload: mark });

  // Ingestão de sinal de teste
  swIngestRecord({
    type: "SW_SIGNAL_RECORDED",
    payload: { id: "EURUSD:60:1727180060", action: "CALL", seq: 1 },
  });

  const bundle = await swBuildExportBundle();
  assert.ok(bundle.exportedAt);
  assert.equal(bundle.extension.build, "2026.09.25-r8");
  assert.equal(bundle.userMarks.length, 1);
  assert.equal(bundle.userMarks[0].payload.note, "Teste de conferência visual 00:08");
  assert.equal(bundle.userMarks[0].payload.tradeCard.direction, "PUT");
  assert.equal(bundle.userMarks[0].payload.opportunityCard.direction, "CALL");
  assert.equal(bundle.signalRecords.length, 1);
});
