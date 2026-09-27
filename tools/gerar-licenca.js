/**
 * GERADOR DE LICENÇAS CRIPTOGRÁFICAS ECDSA P-256 (USO EXCLUSIVO DO PROPRIETÁRIO)
 * ⚠️ NUNCA ENVIE A PASTA `tools/` PARA OS CLIENTES!
 * Use `node tools/empacotar-cliente.js` para gerar a pasta limpa do cliente.
 *
 * Uso via linha de comando:
 *   node tools/gerar-licenca.js --cliente "João Silva" --dias 30 --plano "PRO"
 *   node tools/gerar-licenca.js --cliente "Teste Lead" --dias 1 --plano "TRIAL"
 *   node tools/gerar-licenca.js --cliente "Cliente VIP" --dias 3650 --plano "VITALICIO"
 */

const PRIVATE_KEY_JWK = Object.freeze({
  key_ops: ['sign'],
  ext: true,
  kty: 'EC',
  x: '5GwRbpIj6fDE9wFoqzs8gWwc59aysCra8phIQklqkoc',
  y: 'WyzYGO10QITLCm5_zfcyrn3pWBYgqRDZ_VvOokredpE',
  crv: 'P-256',
  d: 'FJgJ917Oj5v6ddeFb85kLo1-O-Vbe1JsW5-2GxyP4SU'
});

const LICENSE_PREFIX = 'IFX-';
let _cachedPrivateKeyPromise = null;

function getSubtleCrypto() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('Web Crypto API (crypto.subtle) indisponível neste ambiente.');
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function getPrivateKey() {
  if (!_cachedPrivateKeyPromise) {
    const subtle = getSubtleCrypto();
    _cachedPrivateKeyPromise = subtle.importKey(
      'jwk',
      PRIVATE_KEY_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
  }
  return _cachedPrivateKeyPromise;
}

/**
 * Gera um código de licença assinado com ECDSA P-256 (`IFX-<payloadB64Url>.<sigB64Url>`).
 * @param {object} options
 * @param {string} [options.holder="Cliente VIP"] Nome ou identificador do cliente
 * @param {number} [options.durationDays=30] Quantidade de dias de validade (ex: 1, 7, 30, 3650)
 * @param {string} [options.plan="PRO"] Nome do plano (TRIAL, SEMANAL, MENSAL, PRO, VITALICIO)
 * @param {string} [options.licenseId] ID único opcional
 * @param {number} [options.nowMs] Timestamp base em ms (padrão: Date.now())
 * @param {number} [options.expMs] Timestamp exato de expiração em ms (opcional, sobrescreve durationDays)
 */
export async function generateSignedLicenseCode(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const durationDays = Number.isFinite(Number(options.durationDays)) ? Number(options.durationDays) : 30;
  const expMs = Number.isFinite(Number(options.expMs))
    ? Math.floor(Number(options.expMs))
    : Math.floor(nowMs + durationDays * 86_400_000);

  const holder = String(options.holder || 'Cliente').trim() || 'Cliente';
  const plan = String(options.plan || (durationDays <= 1 ? 'TRIAL' : durationDays >= 3650 ? 'VITALICIO' : 'PRO')).trim().toUpperCase();
  const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
  const licenseId = String(options.licenseId || `LIC-${ randomSuffix }`).trim();

  const payloadObj = {
    v: 1,
    id: licenseId,
    sub: holder,
    plan,
    iat: Math.floor(nowMs),
    exp: expMs
  };

  const payloadJson = JSON.stringify(payloadObj);
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const payloadB64 = bytesToBase64Url(payloadBytes);

  const subtle = getSubtleCrypto();
  const privateKey = await getPrivateKey();
  const signedPartBytes = new TextEncoder().encode(payloadB64);
  const signatureBuffer = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    signedPartBytes
  );

  const sigB64 = bytesToBase64Url(new Uint8Array(signatureBuffer));
  const code = `${ LICENSE_PREFIX }${ payloadB64 }.${ sigB64 }`;

  return {
    code,
    payload: payloadObj,
    expiresAtIso: new Date(expMs).toISOString(),
    durationDays
  };
}

// Execução via CLI se chamado diretamente no Node.js
const isMainModule = typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (process.argv[1].endsWith('gerar-licenca.js') || process.argv[1].endsWith('gerar-licenca'));

if (isMainModule) {
  const args = process.argv.slice(2);
  let holder = 'Cliente VIP';
  let durationDays = 30;
  let plan = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--cliente' || arg === '-c') && args[i + 1]) {
      holder = args[++i];
    } else if ((arg === '--dias' || arg === '-d') && args[i + 1]) {
      durationDays = Number(args[++i]);
    } else if ((arg === '--plano' || arg === '-p') && args[i + 1]) {
      plan = args[++i];
    }
  }

  generateSignedLicenseCode({ holder, durationDays, plan })
    .then((res) => {
      console.log('\n============================================================');
      console.log('🔐 GERADOR DE LICENÇAS OFICIAL - IMPÉRIO FX ORACLE');
      console.log('============================================================');
      console.log(`👤 Cliente:   ${ res.payload.sub }`);
      console.log(`🏷️  Plano:     ${ res.payload.plan } (${ res.durationDays } dia(s))`);
      console.log(`🆔 ID:        ${ res.payload.id }`);
      console.log(`📅 Expira em: ${ new Date(res.payload.exp).toLocaleString('pt-BR') }`);
      console.log('------------------------------------------------------------');
      console.log('📋 CÓDIGO DA LICENÇA (Envie este código para o cliente):');
      console.log(`\n${ res.code }\n`);
      console.log('============================================================\n');
    })
    .catch((err) => {
      console.error('Erro ao gerar licença:', err);
      process.exit(1);
    });
}
