/**
 * market-core.test.js - Suíte de Testes Unitários do Core de Mercado
 * Oracle Quant Signals
 *
 * Executado via: node --test tests/market-core.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeWebSocketPayload,
  normalizeHistoryBars,
  normalizeTimestampToSeconds,
  alignTimestamp,
} from "../src/market/candle-normalizer.js";

import {
  isValidCandle,
  validateCandle,
} from "../src/market/candle-validator.js";

import { CandleStore } from "../src/market/candle-store.js";
import { DataQualityTracker, MarketState } from "../src/market/data-quality.js";

// ============================================================================
// 1. TESTES DE NORMALIZAÇÃO
// ============================================================================

test("1. Deve normalizar o JSON exato do tick WebSocket da B2Trading", () => {
  const rawWsPayload = {
    pair: "EURUSD",
    messages: [
      {
        name: "tick",
        data: {
          time: 1727010180000,
          open: 1.0852,
          high: 1.08565,
          low: 1.0851,
          close: 1.08542,
          volume: 142.5,
        },
      },
    ],
  };

  const candles = normalizeWebSocketPayload(rawWsPayload, 60);

  assert.equal(candles.length, 1);
  const c = candles[0];
  assert.equal(c.symbol, "EURUSD");
  assert.equal(c.timeframeSeconds, 60);
  assert.equal(c.timestamp, 1727010180); // Convertido de ms para segundos!
  assert.equal(c.open, 1.0852);
  assert.equal(c.high, 1.08565);
  assert.equal(c.low, 1.0851);
  assert.equal(c.close, 1.08542);
  assert.equal(c.volume, 142.5);
  assert.equal(c.source, "websocket");
  assert.equal(c.closed, false);
});

test("2. Deve normalizar array de barras históricas REST da B2Trading", () => {
  const rawHistoryResponse = {
    bars: [
      {
        time: 1727010120000,
        open: 1.085,
        high: 1.0855,
        low: 1.0849,
        close: 1.0852,
        volume: 98,
      },
      {
        time: 1727010180000,
        open: 1.0852,
        high: 1.0858,
        low: 1.0851,
        close: 1.0854,
        volume: 110,
      },
    ],
  };

  const candles = normalizeHistoryBars(rawHistoryResponse, "EURUSD", 60);

  assert.equal(candles.length, 2);
  assert.equal(candles[0].symbol, "EURUSD");
  assert.equal(candles[0].timestamp, 1727010120);
  assert.equal(candles[0].source, "history");
  assert.equal(candles[0].closed, true);

  assert.equal(candles[1].timestamp, 1727010180);
  assert.equal(candles[1].close, 1.0854);
  assert.equal(candles[1].closed, true);
});

test("2b. Um histórico com ?pair=AUDCAD nunca pode ser gravado como EURUSD", () => {
  const rawHistoryResponse = {
    bars: [
      {
        time: 1727010120000,
        open: 0.912,
        high: 0.915,
        low: 0.911,
        close: 0.914,
        volume: 50,
      },
    ],
  };

  // Par extraído da URL é AUDCAD, mesmo que o contexto padrão tentasse passar EURUSD
  const candles = normalizeHistoryBars(rawHistoryResponse, "AUDCAD", 60, { symbol: "EURUSD" });

  assert.equal(candles.length, 1);
  assert.equal(candles[0].symbol, "AUDCAD", "O par da URL deve prevalecer e nunca ser gravado como EURUSD");
  assert.notEqual(candles[0].symbol, "EURUSD");
});

test("3. Conversão obrigatória de milissegundos para segundos e alinhamento", () => {
  // Timestamp em milissegundos
  const msTimestamp = 1727010195123;
  const seconds = normalizeTimestampToSeconds(msTimestamp);
  assert.equal(seconds, 1727010195);

  // Alinhamento para vela de 60 segundos
  const alignedM1 = alignTimestamp(seconds, 60);
  assert.equal(alignedM1, 1727010180);

  // Timestamp já em segundos deve ser mantido
  assert.equal(normalizeTimestampToSeconds(1727010180), 1727010180);

  // Valores inválidos retornam NaN
  assert.ok(Number.isNaN(normalizeTimestampToSeconds(null)));
  assert.ok(Number.isNaN(normalizeTimestampToSeconds(-500)));
});

// ============================================================================
// 2. TESTES DE VALIDAÇÃO DE VELAS
// ============================================================================

test("4. Rejeição de candles matematicamente e financeiramente impossíveis", () => {
  const validBase = {
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: 1727010180,
    open: 1.085,
    high: 1.086,
    low: 1.084,
    close: 1.0855,
    volume: 10,
  };

  // Base é válida
  assert.equal(isValidCandle(validBase, { skipFutureCheck: true }), true);

  // Rejeição: low > high
  assert.equal(
    isValidCandle({ ...validBase, low: 1.087, high: 1.086 }, { skipFutureCheck: true }),
    false
  );

  // Rejeição: high < open
  assert.equal(
    isValidCandle({ ...validBase, high: 1.084, open: 1.085 }, { skipFutureCheck: true }),
    false
  );

  // Rejeição: low > close
  assert.equal(
    isValidCandle({ ...validBase, low: 1.0856, close: 1.0855 }, { skipFutureCheck: true }),
    false
  );

  // Rejeição: preço negativo ou zero
  assert.equal(isValidCandle({ ...validBase, close: -1.0 }, { skipFutureCheck: true }), false);
  assert.equal(isValidCandle({ ...validBase, open: 0 }, { skipFutureCheck: true }), false);

  // Rejeição: preço não numérico ou NaN
  assert.equal(isValidCandle({ ...validBase, high: NaN }, { skipFutureCheck: true }), false);
  assert.equal(isValidCandle({ ...validBase, low: "invalido" }, { skipFutureCheck: true }), false);

  // Rejeição: símbolo vazio
  assert.equal(isValidCandle({ ...validBase, symbol: "" }, { skipFutureCheck: true }), false);

  // Rejeição: timeframe inválido
  assert.equal(isValidCandle({ ...validBase, timeframeSeconds: 0 }, { skipFutureCheck: true }), false);
});

// ============================================================================
// 3. TESTES DO CANDLE STORE
// ============================================================================

test("5. Ciclo de vida do CandleStore: inicialização, atualização e fechamento contíguo", () => {
  const store = new CandleStore({ maxCandlesPerSeries: 100 });

  // 1. Inserção inicial
  const c1 = {
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: 1727010000,
    open: 1.085,
    high: 1.0855,
    low: 1.0848,
    close: 1.0852,
    source: "websocket",
    closed: false,
    receivedAt: 1000,
  };
  const r1 = store.ingest(c1);
  assert.equal(r1.status, "INITIALIZED");
  assert.equal(store.getLast("EURUSD", 60).close, 1.0852);

  // 2. Mesmo timestamp -> Atualização da vela aberta
  const c1Update = {
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: 1727010000,
    open: 1.085,
    high: 1.086, // Nova máxima
    low: 1.0848,
    close: 1.0858, // Novo fechamento
    source: "websocket",
    closed: false,
    receivedAt: 1500,
  };
  const r2 = store.ingest(c1Update);
  assert.equal(r2.status, "UPDATED");
  const current = store.getLast("EURUSD", 60);
  assert.equal(current.high, 1.086);
  assert.equal(current.close, 1.0858);
  assert.equal(current.closed, false);

  // 3. Próximo timestamp contíguo (1727010000 + 60 = 1727010060)
  const c2 = {
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: 1727010060,
    open: 1.0858,
    high: 1.0865,
    low: 1.0857,
    close: 1.0862,
    source: "websocket",
    closed: false,
    receivedAt: 2000,
  };
  const r3 = store.ingest(c2);
  assert.equal(r3.status, "NEW_CANDLE");
  assert.equal(r3.closedCandle.timestamp, 1727010000);
  assert.equal(r3.closedCandle.closed, true); // O candle anterior foi fechado com sucesso!
  assert.equal(r3.candle.closed, false); // O novo candle está aberto

  // Valida que getLastClosed retorna o candle fechado correto
  const lastClosed = store.getLastClosed("EURUSD", 60);
  assert.equal(lastClosed.timestamp, 1727010000);
  assert.equal(lastClosed.closed, true);

  // 4. Detecção de DATA_GAP (salto temporal de 120s em vez de 60s)
  const cGap = {
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: 1727010180, // Deveria ser 1727010120
    open: 1.0862,
    high: 1.087,
    low: 1.086,
    close: 1.0868,
    source: "websocket",
    closed: false,
    receivedAt: 3000,
  };
  const r4 = store.ingest(cGap);
  assert.equal(r4.status, "DATA_GAP");
  assert.equal(r4.gapFrom, 1727010120);

  // 5. Rejeição de dado fora de ordem (OUT_OF_ORDER)
  const cOld = {
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: 1727010060, // Já ultrapassado
    open: 1.0858,
    high: 1.0865,
    low: 1.0857,
    close: 1.086,
    source: "websocket",
    closed: false,
    receivedAt: 3500,
  };
  const r5 = store.ingest(cOld);
  assert.equal(r5.status, "OUT_OF_ORDER");
});

// ============================================================================
// 4. TESTES DA MÁQUINA DE ESTADOS DATA QUALITY
// ============================================================================

test("6. Transições da máquina de estados DataQuality sem falsas emissões", () => {
  const quality = new DataQualityTracker({ staleTimeoutMs: 10000, minHistoryBars: 5 });

  // Estado Inicial: BOOTING
  assert.equal(quality.getState("EURUSD", 60), MarketState.BOOTING);
  assert.equal(quality.isReady("EURUSD", 60), false);

  // 1. Inicia sincronização de histórico
  quality.onStartHistorySync("EURUSD", 60);
  assert.equal(quality.getState("EURUSD", 60), MarketState.SYNCING_HISTORY);
  assert.equal(quality.isReady("EURUSD", 60), false);

  // 2. Histórico insuficiente não libera tempo real
  quality.onHistoryLoaded("EURUSD", 60, 3);
  assert.equal(quality.getState("EURUSD", 60), MarketState.SYNCING_HISTORY);

  // 3. Histórico suficiente (>= 5) transita para SYNCING_REALTIME
  quality.onHistoryLoaded("EURUSD", 60, 20);
  assert.equal(quality.getState("EURUSD", 60), MarketState.SYNCING_REALTIME);
  assert.equal(quality.isReady("EURUSD", 60), false); // Ainda não pronto antes da conciliação!

  // 4. Primeira mensagem de tempo real reconcilia e transita para READY
  quality.onRealtimeUpdate("EURUSD", 60, { status: "UPDATED" }, 10000);
  assert.equal(quality.getState("EURUSD", 60), MarketState.READY);
  assert.equal(quality.isReady("EURUSD", 60), true);

  // 5. Inatividade maior que 10s transita para STALE
  quality.checkStale("EURUSD", 60, 25000); // 25s - 10s = 15s de inatividade (> 10s)
  assert.equal(quality.getState("EURUSD", 60), MarketState.STALE);
  assert.equal(quality.isReady("EURUSD", 60), false);

  // 6. Retomada de dado recupera para READY
  quality.onRealtimeUpdate("EURUSD", 60, { status: "UPDATED" }, 26000);
  assert.equal(quality.getState("EURUSD", 60), MarketState.READY);
  assert.equal(quality.isReady("EURUSD", 60), true);

  // 7. Ocorrência de GAP derruba imediatamente o estado READY para DATA_GAP
  quality.onRealtimeUpdate(
    "EURUSD",
    60,
    { status: "DATA_GAP", gapFrom: 1727010120, gapTo: 1727010180 },
    27000
  );
  assert.equal(quality.getState("EURUSD", 60), MarketState.DATA_GAP);
  assert.equal(quality.isReady("EURUSD", 60), false); // Impossibilita emissão de sinais em gap!

  // 8. Desconexão transita para RECONNECTING
  quality.onDisconnect("EURUSD", 60);
  assert.equal(quality.getState("EURUSD", 60), MarketState.RECONNECTING);
  assert.equal(quality.isReady("EURUSD", 60), false);

  // 9. Reconexão exige nova carga de histórico
  quality.onReconnect("EURUSD", 60);
  assert.equal(quality.getState("EURUSD", 60), MarketState.SYNCING_HISTORY);
  assert.equal(quality.isReady("EURUSD", 60), false);
});
