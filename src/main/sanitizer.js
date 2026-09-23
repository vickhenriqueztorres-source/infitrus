/**
 * sanitizer.js - Motor de Sanitização do MAIN world e Bridge
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Mascarar tokens em query strings (?token=..., &access_token=...).
 * - Mascarar JWTs que iniciam com "eyJ...".
 * - Mascarar cabeçalhos Authorization: Bearer.
 * - Mascarar campos de Cookie e Set-Cookie.
 * - Mascarar senhas e credenciais em textos e objetos JSON.
 * - Mascarar e-mails por ventura expostos.
 */

const RE_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const RE_BEARER = /\b(bearer\s+)([A-Za-z0-9_\-.~]{10,})\b/gi;
const RE_URL_TOKEN_PARAM = /([?&](?:token|access_token|refresh_token|jwt|auth|api_key|apikey|session|sessionId)=)([^&\s#]+)/gi;
const RE_JSON_TOKEN = /(["']?(?:token|access_token|refresh_token|auth_token|authToken)["']?\s*[:=]\s*["'])(?!\[)([^"']*)(["'])/gi;
const RE_PASSWORD = /(["']?(?:password|passwd|pwd|secret|client_secret)["']?\s*[:=]\s*["'])(?!\[)([^"']*)(["'])/gi;
const RE_COOKIE = /(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["'])(?!\[)([^"']*)(["'])/gi;
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Sanitiza qualquer string de texto ou JSON removendo credenciais e dados sensíveis.
 *
 * @param {string} text
 * @returns {{ sanitized: string, redactions: string[] }}
 */
export function sanitizeText(text) {
  if (!text || typeof text !== "string") {
    return { sanitized: "", redactions: [] };
  }

  const redactions = [];
  let result = text;

  const applyRedaction = (regex, replacement, tag) => {
    regex.lastIndex = 0;
    if (regex.test(result)) {
      regex.lastIndex = 0;
      result = result.replace(regex, replacement);
      redactions.push(tag);
    }
  };

  applyRedaction(RE_JWT, "[JWT_REDACTED]", "jwt");
  applyRedaction(RE_BEARER, "$1[TOKEN_REDACTED]", "bearer_token");
  applyRedaction(RE_URL_TOKEN_PARAM, "$1[TOKEN_REDACTED]", "query_token");
  applyRedaction(RE_JSON_TOKEN, "$1[TOKEN_REDACTED]$3", "json_token");
  applyRedaction(RE_PASSWORD, "$1[PASSWORD_REDACTED]$3", "password");
  applyRedaction(RE_COOKIE, "$1[COOKIE_REDACTED]$3", "cookie");
  applyRedaction(RE_EMAIL, "[EMAIL_REDACTED]", "email");

  return { sanitized: result, redactions };
}

/**
 * Sanitiza especificamente URLs (incluindo parâmetros de busca).
 *
 * @param {string} url
 * @returns {string} URL limpa e segura
 */
export function sanitizeUrl(url) {
  if (!url || typeof url !== "string") return "";
  return sanitizeText(url).sanitized;
}

// Suporte universal a navegadores sem bundler
if (typeof globalThis !== "undefined") {
  globalThis.__OracleSanitizer = { sanitizeText, sanitizeUrl };
}
