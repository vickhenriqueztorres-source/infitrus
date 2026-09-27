/**
 * license-manager.js - Gerenciador de Segurança e Licenciamento Criptográfico (ECDSA P-256)
 * Inflitrus Signals — B2Trading
 *
 * Arquitetura de Segurança:
 * 1. Assinatura Digital Assimétrica (ECDSA P-256 + SHA-256 via Web Crypto API nativa):
 *    - A extensão contém APENAS a Chave Pública de verificação (PUBLIC_KEY_JWK).
 *    - É matematicamente impossível gerar ou falsificar um código de licença usando a Chave Pública.
 *    - A Chave Privada reside exclusivamente na ferramenta geradora local do administrador (tools/).
 * 2. Proteção Anti-Rollback de Relógio (Anti-Tamper Clock):
 *    - Compara a validade da licença contra max(Date.now(), marketClock.nowMs(), maxObservedTimeMs).
 *    - Se o usuário atrasar o relógio do Windows para tentar reutilizar uma licença vencida, o relógio
 *      observado do servidor da corretora bloqueia a tentativa imediatamente.
 * 3. Sincronização Reativa Multi-Contexto:
 *    - Side Panel, Popup, Content Script (analyzer.js) e Service Worker sincronizam o estado da licença
 *      instantaneamente via chrome.storage.local ("ifx:license:v1").
 */

export const LICENSE_STORAGE_KEY = "ifx:license:v1";
export const MAX_OBSERVED_TS_KEY = "ifx:security:max_ts_v1";

/**
 * Configuração centralizada do Telegram da extensão (fácil edição).
 */
export const TELEGRAM_CONFIG = Object.freeze({
  channelName: "Inflitrus Signals Oficial",
  channelHandle: "@inflitrus_signals",
  channelUrl: "https://t.me/inflitrus_signals",
  supportUrl: "https://t.me/inflitrus_signals",
  CHANNEL_URL: "https://t.me/inflitrus_signals",
  SUPPORT_URL: "https://t.me/inflitrus_signals",
  vipDescription:
    "Entre no canal oficial no Telegram para receber atualizações, suporte e renovar ou adquirir sua licença de acesso.",
});

/**
 * Chave Pública ECDSA P-256 (Apenas Verificação — key_ops: ["verify"]).
 */
export const PUBLIC_KEY_JWK = Object.freeze({
  kty: "EC",
  crv: "P-256",
  x: "5GwRbpIj6fDE9wFoqzs8gWwc59aysCra8phIQklqkoc",
  y: "WyzYGO10QITLCm5_zfcyrn3pWBYgqRDZ_VvOokredpE",
  ext: true,
  key_ops: ["verify"],
});

let cachedCryptoPubKey = null;

async function getVerifyPublicKey() {
  if (cachedCryptoPubKey) return cachedCryptoPubKey;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto API indisponível neste ambiente");
  }
  cachedCryptoPubKey = await subtle.importKey(
    "jwk",
    PUBLIC_KEY_JWK,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return cachedCryptoPubKey;
}

/**
 * Utilitários Base64URL (RFC 4648 §5) sem dependências externas.
 */
export function bytesToBase64Url(bytes) {
  let binary = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) {
    binary += String.fromCharCode(u8[i]);
  }
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(u8).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(b64Url) {
  if (typeof b64Url !== "string" || b64Url.length === 0) {
    throw new Error("Base64URL vazio ou inválido");
  }
  if (!/^[A-Za-z0-9\-_]+$/.test(b64Url)) {
    throw new Error("Caracteres inválidos no token Base64URL");
  }
  let b64 = b64Url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Decodifica o payload da licença (suporta JSON `{v:1, id, sub, plan, iat, exp}` ou pipe `"1|holder|expSec|plan|id"`).
 */
export function parseLicensePayload(payloadText) {
  if (typeof payloadText !== "string") return null;
  const trimmed = payloadText.trim();

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (!obj || obj.v !== 1) return null;
      const holder = String(obj.sub || obj.holder || "Cliente VIP").trim();
      const plan = String(obj.plan || "PRO").trim().toUpperCase();
      const licenseId = String(obj.id || obj.licenseId || "LIC-000").trim();
      const expMs = Number(obj.exp ?? obj.expiresAtMs);
      const iatMs = Number(obj.iat) || 0;
      if (!holder || !Number.isFinite(expMs) || expMs < 0 || !licenseId) {
        return null;
      }
      const isLifetime = expMs === 0 || expMs >= iatMs + 3650 * 86_400_000;
      return {
        v: 1,
        version: 1,
        id: licenseId,
        licenseId,
        sub: holder,
        holder,
        plan,
        iat: iatMs,
        exp: expMs,
        expSec: Math.floor(expMs / 1000),
        expiresAtMs: expMs,
        isLifetime,
      };
    } catch (_) {
      return null;
    }
  }

  const parts = trimmed.split("|");
  if (parts.length < 5 || parts[0] !== "1") return null;

  const holder = String(parts[1] || "CLIENTE").trim();
  const expSec = Number(parts[2]);
  const plan = String(parts[3] || "PRO").trim().toUpperCase();
  const licenseId = String(parts[4] || "").trim();

  if (!holder || !Number.isFinite(expSec) || expSec < 0 || !licenseId) {
    return null;
  }

  const expiresAtMs = expSec > 0 ? expSec * 1000 : 0;
  return {
    v: 1,
    version: 1,
    id: licenseId,
    licenseId,
    sub: holder,
    holder,
    exp: expiresAtMs,
    expSec,
    expiresAtMs,
    isLifetime: expSec === 0,
    plan,
  };
}

/**
 * Verifica criptograficamente um código de licença no formato:
 * IFX-<payloadBase64Url>.<signatureBase64Url>
 */
export async function verifyLicenseCode(rawCode, options = {}) {
  const cleaned = String(rawCode || "").trim().replace(/\s+/g, "");
  if (!cleaned) {
    return {
      valid: false,
      expired: false,
      reason: "MISSING_CODE",
      message: "Digite ou cole seu código de licença.",
      payload: null,
    };
  }

  if (!/^IFX-/i.test(cleaned)) {
    return {
      valid: false,
      expired: false,
      reason: "INVALID_FORMAT",
      message: "Formato inválido. O código deve começar com IFX-.",
      payload: null,
    };
  }

  const tokenPart = cleaned.slice(4);
  const dotIdx = tokenPart.indexOf(".");
  if (dotIdx <= 0 || dotIdx === tokenPart.length - 1 || tokenPart.indexOf(".", dotIdx + 1) !== -1) {
    return {
      valid: false,
      expired: false,
      reason: "INVALID_FORMAT",
      message: "Código de licença incompleto ou malformado.",
      payload: null,
    };
  }

  const payloadB64 = tokenPart.slice(0, dotIdx);
  const sigB64 = tokenPart.slice(dotIdx + 1);

  let payloadBytes;
  let sigBytes;
  try {
    payloadBytes = base64UrlToBytes(payloadB64);
    sigBytes = base64UrlToBytes(sigB64);
  } catch (_) {
    return {
      valid: false,
      expired: false,
      reason: "INVALID_FORMAT",
      message: "Código de licença corrompido.",
      payload: null,
    };
  }

  if (sigBytes.length !== 64) {
    return {
      valid: false,
      expired: false,
      reason: "INVALID_SIGNATURE",
      message: "Assinatura digital inválida ou adulterada.",
      payload: null,
    };
  }

  try {
    const pubKey = await getVerifyPublicKey();
    const signedData = new TextEncoder().encode(payloadB64);
    const isSigValid = await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      pubKey,
      sigBytes,
      signedData
    );

    if (!isSigValid) {
      return {
        valid: false,
        expired: false,
        reason: "INVALID_SIGNATURE",
        message: "Código de licença inválido ou adulterado.",
        payload: null,
      };
    }
  } catch (err) {
    return {
      valid: false,
      expired: false,
      reason: "CRYPTO_ERROR",
      message: `Erro ao validar assinatura: ${err?.message || String(err)}`,
      payload: null,
    };
  }

  const payloadText = new TextDecoder().decode(payloadBytes);
  const parsed = parseLicensePayload(payloadText);
  if (!parsed) {
    return {
      valid: false,
      expired: false,
      reason: "INVALID_PAYLOAD",
      message: "Dados internos da licença inválidos.",
      payload: null,
    };
  }

  // Referência temporal anti-fraude (usa o maior horário entre relógio local, corretora e histórico)
  const nowMs = Math.max(
    Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now(),
    Number(options.marketClockMs) || 0,
    Number(options.maxObservedTimeMs) || 0
  );

  if (parsed.expiresAtMs > 0 && parsed.expiresAtMs <= nowMs) {
    return {
      valid: false,
      expired: true,
      reason: "LICENSE_EXPIRED",
      message: "Esta licença expirou. Entre no nosso Telegram para renovar seu acesso.",
      payload: parsed,
      holder: parsed.holder,
      plan: parsed.plan,
      licenseId: parsed.licenseId,
      expiresAtMs: parsed.expiresAtMs,
      isLifetime: false,
      remainingDays: 0,
      remainingLabel: "Expirada",
    };
  }

  const remainingMs = parsed.expiresAtMs > 0 ? Math.max(0, parsed.expiresAtMs - nowMs) : Infinity;
  const remainingDays = Number.isFinite(remainingMs)
    ? Math.ceil(remainingMs / 86_400_000)
    : 3650;
  const remainingHours = Number.isFinite(remainingMs)
    ? Math.ceil(remainingMs / 3_600_000)
    : 99999;
  const remainingLabel = parsed.isLifetime
    ? "Vitalícia"
    : remainingDays > 1
      ? `${remainingDays} dias`
      : `${remainingHours}h`;

  return {
    valid: true,
    expired: false,
    reason: "VALID",
    message: parsed.isLifetime
      ? `Licença Vitalícia ativa (${parsed.holder})`
      : `Licença ativa · ${remainingDays} dia(s) restante(s)`,
    code: `IFX-${payloadB64}.${sigB64}`,
    payload: parsed,
    holder: parsed.holder,
    plan: parsed.plan,
    licenseId: parsed.licenseId,
    expiresAtMs: parsed.expiresAtMs,
    isLifetime: parsed.isLifetime,
    remainingDays,
    remainingLabel,
  };
}

/**
 * Classe singleton que gerencia o estado da licença em tempo de execução,
 * persistência em chrome.storage.local e proteção contra manipulação de relógio.
 */
export class LicenseManager {
  constructor(options = {}) {
    // Em produção na extensão Chrome (chrome.runtime.id presente), enforceMode é SEMPRE true.
    const isExtensionRuntime = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
    this.enforceMode = options.enforceMode !== undefined ? Boolean(options.enforceMode) : isExtensionRuntime;
    this.maxObservedTimeMs = 0;
    this._cachedStatus = {
      valid: false,
      expired: false,
      checkedAt: 0,
      payload: null,
      holder: null,
      plan: null,
      licenseId: null,
      expiresAtMs: null,
      isLifetime: false,
      remainingDays: 0,
      remainingLabel: "0m",
      message: "Licença não ativada.",
    };
    this._listeners = new Set();
    this._initStorageListeners();
  }

  _initStorageListeners() {
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[MAX_OBSERVED_TS_KEY]?.newValue) {
          const ts = Number(changes[MAX_OBSERVED_TS_KEY].newValue);
          if (Number.isFinite(ts) && ts > this.maxObservedTimeMs) {
            this.maxObservedTimeMs = ts;
          }
        }
        if (changes[LICENSE_STORAGE_KEY]) {
          this.refreshFromStorage().catch(() => {});
        }
      });
    }
  }

  setEnforceMode(enabled) {
    this.enforceMode = Boolean(enabled);
  }

  /**
   * Registra um horário real vindo do servidor da corretora (anti-rollback do relógio do Windows).
   */
  observeRealTimeMs(serverTimeMs) {
    const t = Number(serverTimeMs);
    if (!Number.isFinite(t) || t < 1_700_000_000_000) return;

    if (t > this.maxObservedTimeMs) {
      const prevSaved = this.maxObservedTimeMs;
      this.maxObservedTimeMs = t;

      // Verifica se a licença atual venceu com base no novo horário real
      if (
        this._cachedStatus.valid &&
        this._cachedStatus.expiresAtMs > 0 &&
        this._cachedStatus.expiresAtMs <= t
      ) {
        this._cachedStatus = {
          ...this._cachedStatus,
          valid: false,
          expired: true,
          reason: "LICENSE_EXPIRED",
          remainingDays: 0,
          remainingLabel: "Expirada",
          message: "Sua licença expirou. Renove no Telegram.",
        };
        this._notifyListeners();
      }

      // Persiste a cada 60 segundos de avanço para evitar escritas excessivas
      if (t - prevSaved >= 60_000 && typeof chrome !== "undefined" && chrome.storage?.local?.set) {
        try {
          chrome.storage.local.set({ [MAX_OBSERVED_TS_KEY]: t });
        } catch (_) {}
      }
    }
  }

  /**
   * Verifica de forma síncrona (em alta frequência nos ticks) se a execução está autorizada.
   */
  isAuthorizedSync(nowMs = Date.now()) {
    if (!this.enforceMode) return true;
    if (!this._cachedStatus.valid) return false;

    const refNow = Math.max(Number(nowMs) || Date.now(), this.maxObservedTimeMs);
    if (this._cachedStatus.expiresAtMs > 0 && this._cachedStatus.expiresAtMs <= refNow) {
      this._cachedStatus.valid = false;
      this._cachedStatus.expired = true;
      this._cachedStatus.reason = "LICENSE_EXPIRED";
      this._cachedStatus.remainingDays = 0;
      this._cachedStatus.remainingLabel = "Expirada";
      this._cachedStatus.message = "Sua licença expirou. Renove no Telegram.";
      this._notifyListeners();
      return false;
    }
    return true;
  }

  getCachedStatus() {
    return { ...this._cachedStatus };
  }

  getSnapshot() {
    return { ...this._cachedStatus };
  }

  onChange(callback) {
    if (typeof callback === "function") {
      this._listeners.add(callback);
    }
    return () => this._listeners.delete(callback);
  }

  subscribe(callback) {
    return this.onChange(callback);
  }

  _notifyListeners() {
    const snap = this.getCachedStatus();
    for (const cb of this._listeners) {
      try {
        cb(snap);
      } catch (_) {}
    }
  }

  /**
   * Lê a licença salva no chrome.storage.local e revalida sua assinatura digital ECDSA.
   */
  async refreshFromStorage(customStorage = null) {
    const store = customStorage || (typeof chrome !== "undefined" ? chrome.storage?.local : null);
    if (!store?.get) {
      return this.getCachedStatus();
    }

    let data = {};
    try {
      data = await new Promise((resolve) => {
        const res = store.get([LICENSE_STORAGE_KEY, MAX_OBSERVED_TS_KEY], (items) => resolve(items || {}));
        if (res instanceof Promise) {
          res.then((items) => resolve(items || {})).catch(() => resolve({}));
        }
      });
    } catch (_) {}

    const savedMaxTs = Number(data[MAX_OBSERVED_TS_KEY] || 0);
    if (Number.isFinite(savedMaxTs) && savedMaxTs > this.maxObservedTimeMs) {
      this.maxObservedTimeMs = savedMaxTs;
    }

    const savedRecord = data[LICENSE_STORAGE_KEY];
    const savedCode = typeof savedRecord === "string" ? savedRecord : savedRecord?.code;

    if (!savedCode) {
      this._cachedStatus = {
        valid: false,
        expired: false,
        checkedAt: Date.now(),
        payload: null,
        holder: null,
        plan: null,
        licenseId: null,
        expiresAtMs: null,
        isLifetime: false,
        remainingDays: 0,
        remainingLabel: "0m",
        reason: "NO_LICENSE",
        message: "Insira seu código de licença para desbloquear a extensão.",
      };
      this._notifyListeners();
      return this.getCachedStatus();
    }

    const verified = await verifyLicenseCode(savedCode, {
      maxObservedTimeMs: this.maxObservedTimeMs,
    });

    this._cachedStatus = {
      ...verified,
      checkedAt: Date.now(),
    };
    this._notifyListeners();
    return this.getCachedStatus();
  }

  /**
   * Ativa um novo código de licença após validar a assinatura ECDSA P-256.
   */
  async activateCode(rawCode, options = {}) {
    const customStorage = options?.get || options?.set ? options : options?.customStorage || null;
    const nowMs = Number.isFinite(Number(options?.nowMs)) ? Number(options.nowMs) : Date.now();

    const verified = await verifyLicenseCode(rawCode, {
      nowMs,
      maxObservedTimeMs: this.maxObservedTimeMs,
    });

    if (!verified.valid) {
      return verified;
    }

    const store = customStorage || (typeof chrome !== "undefined" ? chrome.storage?.local : null);
    if (store?.set) {
      await new Promise((resolve) => {
        const payload = {
          [LICENSE_STORAGE_KEY]: {
            code: verified.code,
            holder: verified.holder,
            plan: verified.plan,
            licenseId: verified.licenseId,
            expiresAtMs: verified.expiresAtMs,
            isLifetime: verified.isLifetime,
            activatedAtMs: nowMs,
          },
        };
        const res = store.set(payload, () => resolve());
        if (res instanceof Promise) {
          res.then(() => resolve()).catch(() => resolve());
        }
      });
    }

    this._cachedStatus = {
      ...verified,
      checkedAt: nowMs,
    };
    this._notifyListeners();
    return this.getCachedStatus();
  }

  async activateLicense(rawCode, options = {}) {
    return this.activateCode(rawCode, options);
  }

  /**
   * Remove a licença ativa (Logout / Trocar código).
   */
  async clearLicense(customStorage = null) {
    const store = customStorage || (typeof chrome !== "undefined" ? chrome.storage?.local : null);
    if (store?.remove) {
      await new Promise((resolve) => {
        const res = store.remove([LICENSE_STORAGE_KEY], () => resolve());
        if (res instanceof Promise) {
          res.then(() => resolve()).catch(() => resolve());
        }
      });
    }
    this._cachedStatus = {
      valid: false,
      expired: false,
      checkedAt: Date.now(),
      payload: null,
      holder: null,
      plan: null,
      licenseId: null,
      expiresAtMs: null,
      isLifetime: false,
      remainingDays: 0,
      remainingLabel: "0m",
      reason: "LOGGED_OUT",
      message: "Licença desconectada. Insira um código válido.",
    };
    this._notifyListeners();
    return this.getCachedStatus();
  }
}

export const licenseManager = new LicenseManager();
