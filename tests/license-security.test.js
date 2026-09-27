import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  verifyLicenseCode,
  LicenseManager,
  TELEGRAM_CONFIG,
} from "../src/security/license-manager.js";
import { generateSignedLicenseCode } from "../tools/gerar-licenca.js";
import { MarketAnalyzer } from "../src/content/analyzer.js";

test("Segurança Criptográfica ECDSA P-256: aprova licenças legítimas de 1 dia, 30 dias e vitalícia", async () => {
  const nowMs = 1_760_000_000_000;

  const trial = await generateSignedLicenseCode({
    holder: "Lead Teste",
    durationDays: 1,
    plan: "TRIAL",
    nowMs,
  });
  const resTrial = await verifyLicenseCode(trial.code, { nowMs: nowMs + 60_000 });
  assert.equal(resTrial.valid, true);
  assert.equal(resTrial.reason, "VALID");
  assert.equal(resTrial.payload.sub, "Lead Teste");
  assert.equal(resTrial.payload.plan, "TRIAL");
  assert.equal(resTrial.remainingDays, 1);

  const monthly = await generateSignedLicenseCode({
    holder: "Cliente Mensal",
    durationDays: 30,
    plan: "MENSAL",
    nowMs,
  });
  // Testa tolerância a espaços e quebras de linha ao colar do WhatsApp/Telegram
  const resMonthly = await verifyLicenseCode(`  \n ${monthly.code} \t `, { nowMs: nowMs + 3600_000 });
  assert.equal(resMonthly.valid, true);
  assert.equal(resMonthly.payload.sub, "Cliente Mensal");
  assert.equal(resMonthly.payload.plan, "MENSAL");
  assert.equal(resMonthly.remainingDays, 30);
});

test("Segurança Criptográfica ECDSA P-256: rejeita adulteração de payload ou assinatura falsificada", async () => {
  const nowMs = 1_760_000_000_000;
  const generated = await generateSignedLicenseCode({
    holder: "Usuario Comum",
    durationDays: 1,
    plan: "TRIAL",
    nowMs,
  });

  const [prefixAndPayload, sigB64] = generated.code.split(".");
  assert.ok(prefixAndPayload.startsWith("IFX-"));

  // Tentativa de hacker: alterar o payload JSON para 9999 dias mantendo a assinatura original
  const forgedPayload = Buffer.from(
    JSON.stringify({
      v: 1,
      id: "LIC-HACK",
      sub: "Hacker",
      plan: "VITALICIO",
      iat: nowMs,
      exp: nowMs + 9999 * 86_400_000,
    })
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const forgedCode = `IFX-${forgedPayload}.${sigB64}`;
  const resForged = await verifyLicenseCode(forgedCode, { nowMs });
  assert.equal(resForged.valid, false);
  assert.equal(resForged.reason, "INVALID_SIGNATURE");

  // Tentativa de adulterar 1 caractere da assinatura
  const flippedChar = sigB64[0] === "A" ? "B" : "A";
  const corruptedSigCode = `${prefixAndPayload}.${flippedChar}${sigB64.slice(1)}`;
  const resCorruptedSig = await verifyLicenseCode(corruptedSigCode, { nowMs });
  assert.equal(resCorruptedSig.valid, false);
  assert.equal(resCorruptedSig.reason, "INVALID_SIGNATURE");

  // Formatos inválidos ou vazios
  const resEmpty = await verifyLicenseCode("", { nowMs });
  assert.equal(resEmpty.valid, false);
  assert.equal(resEmpty.reason, "MISSING_CODE");

  const resGarbage = await verifyLicenseCode("CODIGO-ALEATORIO-12345", { nowMs });
  assert.equal(resGarbage.valid, false);
  assert.equal(resGarbage.reason, "INVALID_FORMAT");
});

test("Expiração e Proteção Anti-Rollback de Relógio: bloqueia código vencido mesmo se atrasar relógio do Windows", async () => {
  const startMs = 1_760_000_000_000;
  const oneDayLicense = await generateSignedLicenseCode({
    holder: "Lead 24h",
    durationDays: 1,
    plan: "TRIAL",
    nowMs: startMs,
  });

  const mgr = new LicenseManager({ enforceMode: true });
  const actRes = await mgr.activateCode(oneDayLicense.code, { nowMs: startMs + 1000 });
  assert.equal(actRes.valid, true);
  assert.equal(mgr.isAuthorizedSync(startMs + 1000), true);

  // Passaram-se 25 horas (licença de 24h expirou)
  const after25HoursMs = startMs + 25 * 3600_000;
  assert.equal(mgr.isAuthorizedSync(after25HoursMs), false);

  // O stream de mercado observou o timestamp real de 25h depois
  mgr.observeRealTimeMs(after25HoursMs);

  // Usuário tenta atrasar o relógio do Windows de volta para startMs + 2 horas
  const rolledBackClockMs = startMs + 2 * 3600_000;
  assert.equal(
    mgr.isAuthorizedSync(rolledBackClockMs),
    false,
    "Mesmo atrasando o relógio do sistema, o relógio monotônico do mercado deve manter a licença expirada bloqueada"
  );
});

test("Bloqueio no Motor MarketAnalyzer: sem licença ativa não calcula nem emite sinais; desbloqueia ao ativar", async () => {
  const nowSec = Math.floor(Date.now() / 60000) * 60 + 45; // segundo 45 da vela atual
  const nowMs = nowSec * 1000;
  const customLicenseMgr = new LicenseManager({ enforceMode: true });

  const analyzer = new MarketAnalyzer({
    licenseManager: customLicenseMgr,
    enforceLicense: true,
  });

  try {
    // Carrega histórico válido para EURUSD_OTC
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

    // 1. Sem licença: deve estar bloqueado no motor
    assert.equal(analyzer.isLicenseAuthorized(nowMs), false);
    const lockedLifecycle = analyzer.tickLifecycle({ nowSec });
    assert.equal(lockedLifecycle.status, "LICENSE_LOCKED");

    const lockedPanel = analyzer.buildPanelData();
    assert.equal(lockedPanel.status, "LICENSE_LOCKED");
    assert.equal(lockedPanel.action, "WAIT");
    assert.equal(lockedPanel.signalLabel, "LICENÇA BLOQUEADA");

    // 2. Ativa uma licença válida de 7 dias
    const validLicense = await generateSignedLicenseCode({
      holder: "Trader Autorizado",
      durationDays: 7,
      plan: "SEMANAL",
      nowMs,
    });
    const activation = await customLicenseMgr.activateCode(validLicense.code, { nowMs });
    assert.equal(activation.valid, true);

    assert.equal(analyzer.isLicenseAuthorized(nowMs), true);
    const unlockedLifecycle = analyzer.tickLifecycle({ nowSec });
    assert.notEqual(unlockedLifecycle.status, "LICENSE_LOCKED");

    const unlockedPanel = analyzer.buildPanelData();
    assert.notEqual(unlockedPanel.status, "LICENSE_LOCKED");
    assert.equal(unlockedPanel.licenseStatus.valid, true);
    assert.equal(unlockedPanel.licenseStatus.payload.sub, "Trader Autorizado");

    // 3. Faz logout da licença -> volta a bloquear imediatamente
    await customLicenseMgr.clearLicense();
    assert.equal(analyzer.isLicenseAuthorized(nowMs), false);
    assert.equal(analyzer.buildPanelData().status, "LICENSE_LOCKED");
  } finally {
    analyzer.destroy("TEST_END");
  }
});

test("Integridade da Interface e Isolamento da Chave Privada: aba Telegram presente e chave privada ausente de src/", () => {
  const sidepanelHtml = fs.readFileSync(
    path.resolve("src/sidepanel/sidepanel.html"),
    "utf8"
  );
  assert.ok(sidepanelHtml.includes('id="license-gate-overlay"'), "Deve conter painel de login de licença");
  assert.ok(sidepanelHtml.includes('id="license-code-input"'), "Deve conter campo de código de licença");
  assert.ok(sidepanelHtml.includes('id="tab-btn-telegram"'), "Deve conter botão da aba Telegram");
  assert.ok(sidepanelHtml.includes('id="view-telegram"'), "Deve conter view da aba Telegram");
  assert.ok(sidepanelHtml.includes('id="btn-open-telegram"'), "Deve conter CTA para abrir o Telegram");
  assert.ok(TELEGRAM_CONFIG.CHANNEL_URL.startsWith("https://t.me/"), "TELEGRAM_CONFIG deve apontar para link do Telegram");

  // Garante que a chave privada 'd' NUNCA apareça dentro de src/
  const privateScalarD = "FJgJ917Oj5v6ddeFb85kLo1-O-Vbe1JsW5-2GxyP4SU";
  const checkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        checkDir(fullPath);
      } else if (entry.name.endsWith(".js") || entry.name.endsWith(".html") || entry.name.endsWith(".json")) {
        const content = fs.readFileSync(fullPath, "utf8");
        assert.equal(
          content.includes(privateScalarD),
          false,
          `A chave privada JAMAIS deve existir em arquivos do cliente (${fullPath})`
        );
      }
    }
  };
  checkDir(path.resolve("src"));
});
