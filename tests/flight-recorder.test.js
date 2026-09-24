/**
 * flight-recorder.test.js - Testes do Gravador de Voo Unificado
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  swIngestRecord,
  swGetRecords,
  swResetRecords,
  swBuildExportBundle,
  hashCandles,
  configureFlightRecorder,
  rec,
} from "../src/diagnostics/flight-recorder.js";

test("Flight Recorder: Ingestão de múltiplos contextos preserva numeração monotônica estrita seq", () => {
  swResetRecords();

  const contexts = ["main", "content", "sw"];
  const recordsAdded = [];

  // Emite 30 eventos alternando entre os 3 contextos
  for (let i = 0; i < 30; i++) {
    const ctx = contexts[i % 3];
    const raw = {
      tWall: Date.now() + i,
      tPerf: 100 + i,
      ctx,
      type: `EVENT_${ctx.toUpperCase()}_${i}`,
      payload: { index: i },
    };
    const ingested = swIngestRecord(raw);
    recordsAdded.push(ingested);
  }

  const allRecords = swGetRecords();
  assert.equal(allRecords.length, 30, "Deve conter todos os 30 registros");

  // Verifica que seq começa em 1 e é estritamente monotônico crescente
  for (let i = 0; i < allRecords.length; i++) {
    assert.equal(allRecords[i].seq, i + 1, `seq no índice ${i} deve ser ${i + 1}`);
  }
});

test("Flight Recorder: SW sobrepõe obrigatoriamente tabId e frameId a partir do sender real (zero confiança no payload)", () => {
  swResetRecords();

  // Registro tentando forjar tabId: 999 e frameId: 888
  const spoofedRecord = {
    tWall: Date.now(),
    tPerf: 120,
    ctx: "content",
    tabId: 999,
    frameId: 888,
    type: "TEST_SPOOF",
    payload: { malicious: true },
  };

  // Sender oficial fornecido pelo browser Chrome
  const realSender = {
    tab: { id: 42, windowId: 7 },
    frameId: 103,
  };

  const ingested = swIngestRecord(spoofedRecord, realSender);

  assert.equal(ingested.tabId, 42, "tabId DEVE ser sobrescrito pelo sender real");
  assert.equal(ingested.frameId, 103, "frameId DEVE ser sobrescrito pelo sender real");
  assert.equal(ingested.windowId, 7, "windowId DEVE ser extraído do sender");
  assert.notEqual(ingested.tabId, 999, "tabId forjado NUNCA pode ser aceito");
  assert.notEqual(ingested.frameId, 888, "frameId forjado NUNCA pode ser aceito");
});

test("Flight Recorder: Ring buffer descarta registros mais antigos ao atingir capacidade máxima", () => {
  swResetRecords();

  // Testando ring buffer com um volume de inserções
  // Para testar o descarte sem gastar tempo de CPU excessivo, simulamos o comportamento de buffer
  for (let i = 0; i < 20050; i++) {
    swIngestRecord({
      tWall: 1000 + i,
      tPerf: i,
      ctx: "sw",
      type: "TICK",
      payload: { i },
    });
  }

  const records = swGetRecords();
  assert.equal(records.length, 20000, "Capacidade máxima de 20.000 deve ser respeitada");
  assert.equal(records[0].seq, 51, "O primeiro registro deve ser seq 51 (os 50 primeiros foram descartados)");
  assert.equal(records[records.length - 1].seq, 20050, "O último registro deve ter seq 20050");
});

test("Flight Recorder: swBuildExportBundle compila bundle com manifest, tabs, storage filtrado ifx e records", async () => {
  swResetRecords();

  // Prepara registros no SW
  swIngestRecord({ tWall: Date.now(), tPerf: 1, ctx: "sw", type: "SW_BOOT", payload: {} });
  swIngestRecord({ tWall: Date.now(), tPerf: 2, ctx: "content", type: "ANALYZER_NEW", payload: { symbol: "EURUSD" } });

  const originalChrome = globalThis.chrome;
  try {
    globalThis.chrome = {
      runtime: {
        id: "test-flight-rec-ext-id",
        getManifest: () => ({ name: "Inflitrus Signals", version: "2.1.0", manifest_version: 3 }),
      },
      tabs: {
        query: async () => [
          { id: 101, windowId: 1, active: true, url: "https://chart.b2trading.io/", title: "Chart" },
          { id: 102, windowId: 2, active: true, url: "https://traderoom.b2trading.io/", title: "Traderoom" },
        ],
      },
      storage: {
        local: {
          get: async () => ({
            "ifx:tab:101:state": { symbol: "EURUSD" },
            "ifx:tab:102:state": { symbol: "ARBITRIUM_OTC" },
            "other_unrelated_key": "should_be_filtered_out",
          }),
        },
        session: {
          get: async () => ({
            "ifx:compute-owner:101": { frameId: 0 },
            "unrelated_session": "ignore",
          }),
        },
      },
    };

    const bundle = await swBuildExportBundle();

    assert.ok(bundle.exportedAt, "Deve conter exportedAt ISO timestamp");
    assert.equal(bundle.extension.id, "test-flight-rec-ext-id");
    assert.equal(bundle.extension.version, "2.1.0");
    assert.equal(bundle.tabs.length, 2, "Deve listar as 2 abas abertas");
    assert.equal(bundle.records.length, 2, "Deve conter os 2 registros ingeridos");

    // Verifica filtro seguro de storage: apenas chaves ifx:
    assert.ok(bundle.storage.local["ifx:tab:101:state"]);
    assert.ok(bundle.storage.local["ifx:tab:102:state"]);
    assert.equal(bundle.storage.local["other_unrelated_key"], undefined, "Chaves sem prefixo ifx devem ser filtradas");

    assert.ok(bundle.storage.session["ifx:compute-owner:101"]);
    assert.equal(bundle.storage.session["unrelated_session"], undefined);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("Flight Recorder: hashCandles gera checksum estável e sensível a mudanças", () => {
  const candlesA = [
    { timestamp: 100, open: 1.1, close: 1.2 },
    { timestamp: 160, open: 1.2, close: 1.3 },
  ];
  const candlesIdentical = [
    { timestamp: 100, open: 1.1, close: 1.2 },
    { timestamp: 160, open: 1.2, close: 1.3 },
  ];
  const candlesDifferent = [
    { timestamp: 100, open: 1.1, close: 1.2 },
    { timestamp: 160, open: 1.2, close: 1.30001 },
  ];

  const hashA = hashCandles(candlesA);
  const hashIdentical = hashCandles(candlesIdentical);
  const hashDifferent = hashCandles(candlesDifferent);

  assert.equal(hashA, hashIdentical, "Séries idênticas devem gerar exatamente o mesmo hash");
  assert.notEqual(hashA, hashDifferent, "Qualquer variação de preço deve alterar o hash");
  assert.equal(hashCandles([]), "empty");
});
