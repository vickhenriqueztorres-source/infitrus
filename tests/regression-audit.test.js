/**
 * regression-audit.test.js - Testes de Regressão da Auditoria de Sinais (I-xx, R-xx, T-xx, A-xx, P-xx)
 * Oracle Quant Signals
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CandleTimer } from "../src/utils/candle-timer.js";
import { marketClock } from "../src/utils/market-clock.js";
import { SignalAuditor } from "../src/strategy/signal-auditor.js";
import { RegimeChangeDetector } from "../src/strategy/adaptation/regime-change-detector.js";
import { QuantPortfolio } from "../src/strategy/quant-portfolio.js";
import { generateCandles } from "./mock-data-helper.js";

// Caso 1 (ETAPA 02) — T-01: sincronizar o CandleTimer com o horário de abertura da vela não pode deixar o cronômetro em remaining=60.
// Use um relógio falso: agora = abertura + 29,3 s → remainingSeconds tem de ser 31.
test(
  "Caso 1 (ETAPA 02) — T-01: sincronização do CandleTimer com abertura não trava em remaining=60",
  () => {
    const timer = new CandleTimer({ timeframeSeconds: 60 });
    const candleOpen = 1727010000; // Segundos (abertura da vela)
    const fakeNowMs = candleOpen * 1000 + 29300; // 29.3s após abertura

    // Simula Date.now() congelado em fakeNowMs
    const origNow = Date.now;
    try {
      Date.now = () => fakeNowMs;
      marketClock.offsetMs = 0;
      marketClock.samples = 0;
      marketClock.observeCandleOpen(candleOpen, candleOpen * 1000);
      const state = timer.computeCurrentState();
      assert.equal(state.remainingSeconds, 31, `Esperava 31s restantes, obtido: ${state.remainingSeconds}`);
    } finally {
      Date.now = origNow;
    }
  }
);

// Caso 2 (ETAPA 04) — A-01: o SignalAuditor não pode liquidar um sinal usando uma vela com closed=false.
// Registre um CALL na vela T, faça ingest do 1º tick de T+60 (closed=false) e verifique que o sinal continua PENDING.
test(
  "Caso 2 (ETAPA 04) — A-01: SignalAuditor não pode liquidar sinal com vela não fechada (closed=false)",
  { skip: "desbloqueado na ETAPA 04" },
  () => {
    const auditor = new SignalAuditor();
    const t = 1727010000;

    auditor.recordSignal({
      action: "CALL",
      label: "CALL EURUSD",
      symbol: "EURUSD",
      timeframeSeconds: 60,
      candleTimestamp: t,
      entryPrice: 1.0850,
      probability: 0.65,
      payout: 0.80,
    });

    // 1º tick da vela seguinte (T+60) com closed=false
    const formingCandles = [
      {
        timestamp: t + 60,
        open: 1.0850,
        high: 1.0855,
        low: 1.0849,
        close: 1.0853,
        symbol: "EURUSD",
        closed: false,
      },
    ];

    const settled = auditor.auditPendingSignals(formingCandles);
    assert.equal(settled.length, 0, "Nenhum sinal pode ser liquidado por vela em formação (closed=false)");

    const sig = auditor.signals.find((s) => s.symbol === "EURUSD" && s.timestamp === t);
    assert.equal(sig.status, "PENDING", "Sinal deve permanecer PENDING até vela fechar formalmente");
  }
);

// Caso 3 (ETAPA 03) — R-04: 30 chamadas de RegimeChangeDetector.evaluate() com as MESMAS velas e features
// → 0 change points e marketStability igual ao valor inicial.
test(
  "Caso 3 (ETAPA 03) — R-04: 30 chamadas de evaluate() com dados idênticos não disparam falsos Change Points",
  { skip: "desbloqueado na ETAPA 03" },
  () => {
    const detector = new RegimeChangeDetector();
    const candles = generateCandles(30, 1.0850, "FLAT");
    const rawFeatures = { r1: 0.0002, sigma5: 0.0001, vr3_20: 1.0, persistence: 0.1 };

    const initialStability = detector.marketStability;
    let changePointsTriggered = 0;

    for (let i = 0; i < 30; i++) {
      const res = detector.evaluate(candles, rawFeatures);
      if (res.isChangePoint) {
        changePointsTriggered++;
      }
    }

    assert.equal(changePointsTriggered, 0, `Não deveria disparar Change Point para dados estáticos, disparou: ${changePointsTriggered}`);
    assert.equal(detector.marketStability, initialStability, "Estabilidade não pode degradar por chamadas repetidas na mesma vela");
  }
);

// Caso 4 (ETAPA 04) — R-01/R-03: simule a virada da vela. A decisão devolve CALL aos 50 s da vela T.
// Troque a decisão para PUT e mande ticks de T+60 até T+63. A direção exibida continua CALL e existe exatamente 1 evento de sinal novo.
test(
  "Caso 4 (ETAPA 04) — R-01/R-03: virada da vela não inverte sinal de CALL para PUT nos primeiros segundos",
  { skip: "desbloqueado na ETAPA 04" },
  () => {
    const portfolio = new QuantPortfolio({ payout: 0.80 });
    const t = 1727010000;

    // Vela T aos 50s (bull)
    const candlesT = generateCandles(30, 1.0800, "UP");
    candlesT[candlesT.length - 1].timestamp = t;

    const rep50s = portfolio.evaluate({
      symbol: "EURUSD",
      timeframeSeconds: 60,
      candles: candlesT,
      isReady: true,
    });

    // Confirma sinal CALL
    assert.equal(rep50s.action, "CALL");
    assert.equal(rep50s.isNewSignal, true);

    // Agora simula virada de vela T+60 com queda abrupta (que daria PUT se não estivesse protegido)
    const candlesT60 = [...candlesT];
    candlesT60.push({
      timestamp: t + 60,
      open: candlesT[candlesT.length - 1].close,
      high: candlesT[candlesT.length - 1].close,
      low: candlesT[candlesT.length - 1].close - 0.0010,
      close: candlesT[candlesT.length - 1].close - 0.0008,
      symbol: "EURUSD",
    });

    // Ticks de T+60 até T+63
    let newSignalCount = 0;
    for (let sec = 0; sec <= 3; sec++) {
      const rep = portfolio.evaluate({
        symbol: "EURUSD",
        timeframeSeconds: 60,
        candles: candlesT60,
        isReady: true,
      });

      // O sinal em execução na abertura da nova vela DEVE preservar o CALL qualificado
      assert.equal(rep.action, "CALL", `No segundo ${sec} da nova vela, sinal inverteu para ${rep.action}`);
      if (rep.isNewSignal) newSignalCount++;
    }

    assert.equal(newSignalCount, 0, "Não deve disparar novos sinais durante a transição da vela");
  }
);

// Caso 5 (ETAPA 06) — I-01/I-02: duas abas (tabId 1 com AUDCAD e tabId 2 com EURUSD) gravam estado e sinal.
// A função de seleção do Side Panel com boundTabId=2 não pode devolver nenhum dado da aba 1.
test(
  "Caso 5 (ETAPA 06) — I-01/I-02: isolamento multi-abas no seletor de visualização do Side Panel",
  { skip: "desbloqueado na ETAPA 06" },
  async () => {
    const { selectTabView } = await import("../src/ui/tab-view-selector.js");

    const storageSnapshot = {
      tabs: {
        1: {
          symbol: "AUDCAD",
          action: "CALL",
          probability: 0.68,
          label: "CALL AUDCAD",
        },
        2: {
          symbol: "EURUSD",
          action: "PUT",
          probability: 0.62,
          label: "PUT EURUSD",
        },
      },
    };

    const view = selectTabView(storageSnapshot, 2);
    assert.equal(view.symbol, "EURUSD");
    assert.equal(view.action, "PUT");
    assert.equal(view.tabId, 2);
    assert.notEqual(view.symbol, "AUDCAD", "Aba 2 não pode receber dados da Aba 1");
  }
);
