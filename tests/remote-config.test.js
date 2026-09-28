import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteConfigManager,
  DEFAULT_FALLBACK_CONFIG,
} from "../src/security/remote-config-manager.js";

test("RemoteConfigManager: inicializa com configurações padrão seguras", () => {
  const mgr = new RemoteConfigManager();
  const cfg = mgr.getConfig();

  assert.equal(mgr.isKillSwitchActive(), false);
  assert.equal(mgr.getMinEdge(), 0.025);
  assert.equal(mgr.getMinPayout(), 0.78);
  assert.equal(mgr.isPairAllowed("EURUSD_OTC"), true);
  assert.equal(mgr.isPairBlocked("EURUSD_OTC"), false);
  assert.equal(cfg.version, "1.0.0");
});

test("RemoteConfigManager: bloqueio e permissão de pares dinâmico", async () => {
  const mgr = new RemoteConfigManager();

  const mockData = {
    version: "1.0.1",
    market: {
      allowedPairs: ["EURUSD_OTC", "GBPUSD_OTC"],
      blockedPairs: ["BTCUSD_OTC"],
    },
  };

  const mockFetch = async () => ({
    ok: true,
    json: async () => mockData,
  });

  await mgr.refreshFromNetwork(mockFetch);

  assert.equal(mgr.isPairAllowed("EURUSD_OTC"), true);
  assert.equal(mgr.isPairAllowed("GBPUSD_OTC"), true);
  assert.equal(mgr.isPairAllowed("BTCUSD_OTC"), false);
  assert.equal(mgr.isPairBlocked("BTCUSD_OTC"), true);
  assert.equal(mgr.isPairAllowed("DESCONHECIDO_OTC"), false);
});

test("RemoteConfigManager: Kill-Switch em tempo real pausa sinais e expõe motivo", async () => {
  const mgr = new RemoteConfigManager();
  let updatedEventCount = 0;

  mgr.onUpdate((cfg) => {
    updatedEventCount++;
  });

  const emergencyData = {
    version: "1.0.2",
    system: {
      killSwitch: true,
      killSwitchReason: "ALERTA: Notícia de Payroll em 5 minutos. Sistema pausado.",
      announcement: "Manutenção preventiva de volatilidade.",
    },
    parameters: {
      minEdge: 0.045,
    },
  };

  const mockFetch = async () => ({
    ok: true,
    json: async () => emergencyData,
  });

  await mgr.refreshFromNetwork(mockFetch);

  assert.equal(mgr.isKillSwitchActive(), true);
  assert.equal(mgr.getKillSwitchReason(), "ALERTA: Notícia de Payroll em 5 minutos. Sistema pausado.");
  assert.equal(mgr.getAnnouncement(), "Manutenção preventiva de volatilidade.");
  assert.equal(mgr.getMinEdge(), 0.045);
  assert.equal(updatedEventCount, 1);
});

test("RemoteConfigManager: tolerância a falhas offline e sanitização contra payload inválido", async () => {
  const mgr = new RemoteConfigManager();

  // Simula erro de conexão (servidor offline / sem internet)
  const failingFetch = async () => {
    throw new Error("Network unreachable");
  };

  await mgr.refreshFromNetwork(failingFetch);

  // Mantém os parâmetros seguros anteriores sem travar
  assert.equal(mgr.isKillSwitchActive(), false);
  assert.equal(mgr.getMinEdge(), 0.025);

  // Simula payload com campos corrompidos/nulos
  const garbageFetch = async () => ({
    ok: true,
    json: async () => ({
      parameters: { minEdge: "INVALIDO", minPayout: null },
      system: null,
      market: { allowedPairs: null },
    }),
  });

  await mgr.refreshFromNetwork(garbageFetch);
  assert.equal(mgr.getMinEdge(), 0.025);
  assert.equal(mgr.getMinPayout(), 0.78);
  assert.equal(mgr.isKillSwitchActive(), false);
});

test("MarketAnalyzer + RemoteConfigManager: ativação do Kill-Switch bloqueia emissão de sinais e exibe PAUSA TÉCNICA", async () => {
  const { MarketAnalyzer } = await import("../src/content/analyzer.js");
  const customRemote = new RemoteConfigManager();
  const analyzer = new MarketAnalyzer({
    remoteConfigManager: customRemote,
    enforceLicense: false,
  });

  try {
    const nowSec = 1727000052;
    const bars = [];
    for (let i = 30; i >= 1; i--) {
      const ts = Math.floor(nowSec / 60) * 60 - i * 60;
      bars.push({
        symbol: "EURUSD_OTC",
        timeframe: 60,
        timestamp: ts,
        open: 1.08 + i * 0.0001,
        high: 1.081 + i * 0.0001,
        low: 1.079 + i * 0.0001,
        close: 1.0805 + i * 0.0001,
        volume: 10,
        closed: true,
      });
    }
    analyzer.handleChannelEvent({ action: "subscribe", pair: "EURUSD_OTC", tf: 60 });
    analyzer.processHistoryPayload(bars, { pair: "EURUSD_OTC", tf: 60 });

    // 1. Estado normal: sem Kill-Switch
    assert.equal(analyzer.isKillSwitchActive(), false);
    const normalLifecycle = analyzer.tickLifecycle({ nowSec });
    assert.notEqual(normalLifecycle.status, "KILL_SWITCH_ACTIVE");

    // 2. Aciona o Kill-Switch remotamente
    await customRemote.refreshFromNetwork(async () => ({
      ok: true,
      json: async () => ({
        system: {
          killSwitch: true,
          killSwitchReason: "Alta volatilidade detectada.",
          announcement: "Pausa técnica de emergência.",
        },
      }),
    }));

    assert.equal(analyzer.isKillSwitchActive(), true);

    // 3. O ciclo do lifecycle retorna KILL_SWITCH_ACTIVE
    const pausedLifecycle = analyzer.tickLifecycle({ nowSec });
    assert.equal(pausedLifecycle.status, "KILL_SWITCH_ACTIVE");
    assert.equal(pausedLifecycle.reason, "Alta volatilidade detectada.");

    // 4. O painel compõe com PAUSA TÉCNICA
    const panel = analyzer.buildPanelData();
    assert.equal(panel.isKillSwitchActive, true);
    assert.equal(panel.symbols["EURUSD_OTC"].action, "WAIT");
    assert.equal(panel.symbols["EURUSD_OTC"].state, "KILL_SWITCH_ACTIVE");
    assert.equal(panel.symbols["EURUSD_OTC"].reasons[0], "Alta volatilidade detectada.");
  } finally {
    analyzer.destroy("TEST_END");
  }
});

