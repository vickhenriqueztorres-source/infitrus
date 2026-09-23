/**
 * integration.test.js - Testes de Integração e Resiliência da Extensão
 * Oracle Quant Signals
 *
 * Cobre:
 * - Envelope real do WebSocket e histórico real
 * - Mensagens malformadas (sem pair, sem messages, sem data)
 * - Validações de timestamp e OHLC
 * - Troca de ativo e de timeframe
 * - Mensagens duplicadas, fora de ordem e lacunas (gaps)
 * - Reconexões da rede/socket
 * - Segurança da Bridge: origem inválida e sessionId inválido
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeWebSocketPayload,
  normalizeHistoryBars,
} from "../src/market/candle-normalizer.js";

import { isValidCandle, validateCandle } from "../src/market/candle-validator.js";
import { CandleStore } from "../src/market/candle-store.js";
import { DataQualityTracker, MarketState } from "../src/market/data-quality.js";
import { validateBridgeMessage } from "../src/content/bridge.js";
import { sanitizeText, sanitizeUrl } from "../src/main/sanitizer.js";

// ============================================================================
// 1. CASOS DE ENVELOPE E PAYLOADS MALFORMADOS
// ============================================================================

test("Integração: Envelope real e mensagens malformadas", () => {
  // 1. Envelope real da B2Trading
  const validWs = {
    pair: "EURUSD",
    messages: [
      {
        name: "tick",
        data: {
          time: 1727010180000,
          open: 1.0852,
          high: 1.0856,
          low: 1.085,
          close: 1.0854,
          volume: 50,
        },
      },
    ],
  };
  const c1 = normalizeWebSocketPayload(validWs, 60);
  assert.equal(c1.length, 1);
  assert.equal(c1[0].symbol, "EURUSD");
  assert.equal(c1[0].timestamp, 1727010180);

  // 2. Mensagem sem pair (deve usar fallback ou vazio)
  const noPair = {
    messages: [{ name: "tick", data: { time: 1727010180000, open: 1, high: 2, low: 0.5, close: 1.5 } }],
  };
  const cNoPair = normalizeWebSocketPayload(noPair, 60, { symbol: "DEFAULT_PAIR" });
  assert.equal(cNoPair.length, 1);
  assert.equal(cNoPair[0].symbol, "DEFAULT_PAIR");

  // 3. Mensagem sem messages (array ausente)
  const noMessages = { pair: "EURUSD" };
  const cNoMessages = normalizeWebSocketPayload(noMessages, 60);
  assert.equal(cNoMessages.length, 0);

  // 4. Mensagem sem data dentro de messages
  const noData = {
    pair: "EURUSD",
    messages: [{ name: "tick" }],
  };
  const cNoData = normalizeWebSocketPayload(noData, 60);
  assert.equal(cNoData.length, 0);
});

// ============================================================================
// 2. VALIDAÇÃO DE ANOMALIAS: TIMESTAMP E OHLC
// ============================================================================

test("Integração: Rejeição de timestamp e OHLC inválidos", () => {
  const base = {
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: 1727010180,
    open: 1.085,
    high: 1.086,
    low: 1.084,
    close: 1.0855,
  };

  // Timestamp inválido (zero ou negativo)
  assert.equal(isValidCandle({ ...base, timestamp: 0 }), false);
  assert.equal(isValidCandle({ ...base, timestamp: -100 }), false);
  assert.equal(isValidCandle({ ...base, timestamp: "abc" }), false);

  // OHLC inválido: low > high
  assert.equal(isValidCandle({ ...base, low: 1.087, high: 1.086 }), false);

  // OHLC inválido: high < open
  assert.equal(isValidCandle({ ...base, high: 1.084, open: 1.085 }), false);

  // OHLC inválido: preços negativos
  assert.equal(isValidCandle({ ...base, open: -1.0 }), false);
});

// ============================================================================
// 3. TROCA DE ATIVO E TROCA DE TIMEFRAME
// ============================================================================

test("Integração: Troca de ativo e timeframe no CandleStore", () => {
  const store = new CandleStore();

  // Ingestão no par EURUSD M1 (60s)
  store.ingest({
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: 1727010000,
    open: 1.085,
    high: 1.086,
    low: 1.084,
    close: 1.0855,
    closed: false,
    source: "websocket",
    receivedAt: 1000,
  });

  // Troca de ativo para BTCUSD
  store.ingest({
    symbol: "BTCUSD",
    timeframeSeconds: 60,
    timestamp: 1727010000,
    open: 65000,
    high: 65100,
    low: 64900,
    close: 65050,
    closed: false,
    source: "websocket",
    receivedAt: 1050,
  });

  // Troca de timeframe para EURUSD M5 (300s)
  store.ingest({
    symbol: "EURUSD",
    timeframeSeconds: 300,
    timestamp: 1727010000,
    open: 1.085,
    high: 1.088,
    low: 1.083,
    close: 1.087,
    closed: false,
    source: "websocket",
    receivedAt: 1100,
  });

  // As 3 séries devem estar completamente isoladas
  assert.equal(store.getLast("EURUSD", 60).close, 1.0855);
  assert.equal(store.getLast("BTCUSD", 60).close, 65050);
  assert.equal(store.getLast("EURUSD", 300).close, 1.087);
});

// ============================================================================
// 4. MENSAGEM DUPLICADA, FORA DE ORDEM E DATA GAP
// ============================================================================

test("Integração: Tratamento de atualização concorrente, gap e out of order", () => {
  const store = new CandleStore();

  const c1 = {
    symbol: "EURUSD",
    timeframeSeconds: 60,
    timestamp: 1727010000,
    open: 1.085,
    high: 1.0855,
    low: 1.0848,
    close: 1.085,
    closed: false,
    source: "websocket",
    receivedAt: 1000,
  };
  assert.equal(store.ingest(c1).status, "INITIALIZED");

  // Mensagem no mesmo timestamp (tick seguinte no mesmo candle)
  const c1Tick = {
    ...c1,
    high: 1.0862, // expansão de máxima
    close: 1.086,
    receivedAt: 1500,
  };
  const rUpdate = store.ingest(c1Tick);
  assert.equal(rUpdate.status, "UPDATED");
  assert.equal(store.getLast("EURUSD", 60).high, 1.0862);

  // Mensagem com gap (pula de 1727010000 para 1727010180)
  const cGap = {
    ...c1,
    timestamp: 1727010180,
    receivedAt: 2000,
  };
  const rGap = store.ingest(cGap);
  assert.equal(rGap.status, "DATA_GAP");
  assert.equal(rGap.gapFrom, 1727010060);

  // Mensagem fora de ordem (timestamp antigo)
  const cOld = {
    ...c1,
    timestamp: 1727010060,
    receivedAt: 2500,
  };
  const rOld = store.ingest(cOld);
  assert.equal(rOld.status, "OUT_OF_ORDER");
});

// ============================================================================
// 5. RECONEXÃO E ESTADO DATA QUALITY
// ============================================================================

test("Integração: Ciclo de desconexão e reconexão", () => {
  const quality = new DataQualityTracker();

  // Inicializa e coloca em READY
  quality.onHistoryLoaded("EURUSD", 60, 50);
  quality.onRealtimeUpdate("EURUSD", 60, { status: "UPDATED" }, 1000);
  assert.equal(quality.isReady("EURUSD", 60), true);

  // Queda de socket
  quality.onDisconnect("EURUSD", 60);
  assert.equal(quality.getState("EURUSD", 60), MarketState.RECONNECTING);
  assert.equal(quality.isReady("EURUSD", 60), false);

  // Reconexão: exige novo sync de histórico
  quality.onReconnect("EURUSD", 60);
  assert.equal(quality.getState("EURUSD", 60), MarketState.SYNCING_HISTORY);
  assert.equal(quality.isReady("EURUSD", 60), false);

  // Nova carga de histórico e tempo real reconciliado
  quality.onHistoryLoaded("EURUSD", 60, 50);
  quality.onRealtimeUpdate("EURUSD", 60, { status: "NEW_CANDLE" }, 2000);
  assert.equal(quality.getState("EURUSD", 60), MarketState.READY);
  assert.equal(quality.isReady("EURUSD", 60), true);
});

// ============================================================================
// 6. SEGURANÇA DA BRIDGE: ORIGEM E SESSION ID INVÁLIDOS
// ============================================================================

test("Segurança da Bridge: Rejeição de mensagens maliciosas e forjadas", () => {
  const validEvent = {
    source: null,
    origin: "https://chart.b2trading.io",
    data: {
      type: "ORACLE_MAIN_MARKET_EVENT",
      sessionId: "sess_valid123_456",
      payload: { pair: "EURUSD" },
    },
  };

  // Evento válido
  const rValid = validateBridgeMessage(validEvent, "sess_valid123_456");
  assert.equal(rValid.valid, true);

  // Rejeição: Origem externa não autorizada
  const rBadOrigin = validateBridgeMessage({
    ...validEvent,
    origin: "https://attacker-domain.com",
  });
  assert.equal(rBadOrigin.valid, false);
  assert.match(rBadOrigin.reason, /não autorizado/);

  // Rejeição: SessionId inválido ou ausente
  const rNoSession = validateBridgeMessage({
    ...validEvent,
    data: { ...validEvent.data, sessionId: "" },
  });
  assert.equal(rNoSession.valid, false);
  assert.match(rNoSession.reason, /sessionId inválido/);

  // Rejeição: SessionId divergente do esperado
  const rWrongSession = validateBridgeMessage(validEvent, "sess_outro_id");
  assert.equal(rWrongSession.valid, false);
  assert.match(rWrongSession.reason, /não corresponde/);

  // Rejeição: Tipo de evento desconhecido
  const rUnknownType = validateBridgeMessage({
    ...validEvent,
    data: { ...validEvent.data, type: "UNKNOWN_MALICIOUS_EVENT" },
  });
  assert.equal(rUnknownType.valid, false);
  assert.match(rUnknownType.reason, /desconhecido/);
});

// ============================================================================
// 7. MOTOR DE SANITIZAÇÃO
// ============================================================================

test("Sanitização: Mascaramento preventivo de credenciais", () => {
  const dirtyUrl = "wss://ws.b2trading.io/ws?token=SECRET_AUTH_TOKEN_999&access_token=ABC123XYZ";
  const cleanUrl = sanitizeUrl(dirtyUrl);
  assert.equal(cleanUrl.includes("SECRET_AUTH_TOKEN_999"), false);
  assert.equal(cleanUrl.includes("ABC123XYZ"), false);
  assert.equal(cleanUrl.includes("[TOKEN_REDACTED]"), true);

  const dirtyPayload = JSON.stringify({
    user: "trader@b2trading.io",
    password: "Password123!",
    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakMe",
    pair: "EURUSD",
  });
  const { sanitized, redactions } = sanitizeText(dirtyPayload);
  assert.equal(sanitized.includes("Password123!"), false);
  assert.equal(sanitized.includes("doNotLeakMe"), false);
  assert.equal(sanitized.includes("[PASSWORD_REDACTED]"), true);
  assert.equal(sanitized.includes("[JWT_REDACTED]"), true);
  assert.equal(sanitized.includes("EURUSD"), true); // Dados de mercado intactos
  assert.ok(redactions.includes("password"));
  assert.ok(redactions.includes("jwt"));
});

// ============================================================================
// 8. SUPORTE A SOCKET.IO, ARRAYS E FALLBACK DE TIMESTAMP
// ============================================================================

test("Integração: Suporte a formato Socket.IO e fallback de timestamp", () => {
  // 1. Array formato Socket.IO ["tick", { pair, open, high, low, close }]
  const socketIoPayload = [
    "tick",
    {
      pair: "EURUSD",
      time: 1727010180000,
      open: 1.085,
      high: 1.086,
      low: 1.084,
      close: 1.0855,
      volume: 45,
    },
  ];
  const candlesIo = normalizeWebSocketPayload(socketIoPayload, 60);
  assert.equal(candlesIo.length, 1);
  assert.equal(candlesIo[0].symbol, "EURUSD");
  assert.equal(candlesIo[0].close, 1.0855);
  assert.equal(candlesIo[0].timestamp, 1727010180);

  // 2. Tick em tempo real sem timestamp explícito (deve usar receivedAt)
  const receivedMs = 1727010300000;
  const tickNoTime = {
    pair: "EURUSD",
    price: 1.0859,
  };
  const candlesNoTime = normalizeWebSocketPayload(tickNoTime, 60, { receivedAt: receivedMs });
  assert.equal(candlesNoTime.length, 1);
  assert.equal(candlesNoTime[0].close, 1.0859);
  assert.equal(candlesNoTime[0].timestamp, 1727010300);

  // 3. Tick com campo alternativo 'rate'
  const tickRate = {
    symbol: "BTCUSD",
    rate: 65200.5,
  };
  const candlesRate = normalizeWebSocketPayload(tickRate, 60, { receivedAt: receivedMs });
  assert.equal(candlesRate.length, 1);
  assert.equal(candlesRate[0].symbol, "BTCUSD");
  assert.equal(candlesRate[0].close, 65200.5);
  assert.equal(candlesRate[0].open, 65200.5);
});

