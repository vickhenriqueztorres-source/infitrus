/**
 * lifecycle-card.js - Formatação Pura do Card de Ciclo de Vida do Sinal (T-06)
 * Oracle Quant Signals
 *
 * Responsabilidade:
 * - Formatar de forma pura, determinística e acessível o estado do card principal
 *   e da contagem regressiva em tempo real com base no snapshot do SignalLifecycle.
 * - Garantir UMA ÚNICA frase consistente por estado (sem contradições na tela).
 * - Clamp estrito em 0 (nenhum contador negativo).
 */

/**
 * Mapeia o resultado do trade em espanhol
 */
function formatResult(result) {
  if (result === "WIN") return "GANADA";
  if (result === "LOSS") return "PERDIDA";
  return "EMPATE";
}

/**
 * Mapeia o motivo de cancelamento em espanhol
 */
function formatCancelReason(reason) {
  if (reason === "ASSET_CHANGED") return "cambiaste de activo";
  return "datos inestables";
}

/**
 * Formata os dados visuais do card a partir do snapshot do lifecycle e do tempo atual.
 *
 * @param {Object} snapshot - Snapshot do SignalLifecycle ou item individual
 * @param {number} nowSec - Epoch atual em segundos (com offset do MarketClock)
 * @returns {Object} Dados formatados para o card
 */
export function formatLifecycleCard(snapshot = {}, nowSec = 0) {
  if (!snapshot || typeof snapshot !== "object") {
    return {
      primaryText: "Escuchando mercado · decisión en 45s",
      secondaryText: null,
      phase: "SCANNING",
      direction: null,
      secondsRemaining: 45,
      progressPct: 0,
      badgeText: "ESCANEANDO",
      badgeClass: "wait",
      ariaLive: "polite",
      ariaLabel: "escuchando mercado, decisión en 45 segundos",
    };
  }

  // 1. Timeframe não suportado
  if (snapshot.status === "TF_NOT_SUPPORTED" || snapshot.phase === "TF_NOT_SUPPORTED") {
    return {
      primaryText: "Timeframe no soportado · usa M1",
      secondaryText: null,
      phase: "TF_NOT_SUPPORTED",
      direction: null,
      secondsRemaining: 0,
      progressPct: 0,
      badgeText: "TF NO SOPORTADO",
      badgeClass: "wait",
      ariaLive: "polite",
      ariaLabel: "timeframe no soportado, usa M1",
    };
  }

  // Identifica elementos do snapshot
  const isComposite = Boolean(snapshot.current || snapshot.trade || snapshot.lastResult);
  const current = isComposite ? snapshot.current : snapshot;
  const trade = isComposite ? snapshot.trade : (snapshot.phase === "ENTRY_NOW" || snapshot.phase === "IN_TRADE" ? snapshot : null);
  const lastResult = isComposite ? snapshot.lastResult : (snapshot.phase === "SETTLED" ? snapshot : null);
  const pair = current?.pair || trade?.pair || snapshot.pair || snapshot.symbol || "Mercado";
  const tf = current?.tf || trade?.tf || snapshot.tf || snapshot.timeframeSeconds || 60;

  // 2. ENTRY_NOW (Prioridade máxima / Maior destaque da tela)
  if (trade && trade.phase === "ENTRY_NOW") {
    const dir = trade.direction || "CALL";
    const dirSymbol = dir === "CALL" ? "CALL ▲" : "PUT ▼";
    const targetTs = trade.targetTs != null ? trade.targetTs : Math.floor(nowSec / tf) * tf;
    const rem = Math.max(0, Math.ceil((targetTs + 5) - nowSec));
    const elapsed = nowSec - targetTs;
    const progressPct = Math.min(100, Math.max(0, (elapsed / 5) * 100));

    return {
      primaryText: `ENTRA AHORA — ${dirSymbol} · quedan ${rem}s`,
      secondaryText: null,
      phase: "ENTRY_NOW",
      direction: dir,
      secondsRemaining: rem,
      progressPct,
      badgeText: `ENTRA AHORA · ${dir}`,
      badgeClass: dir === "CALL" ? "call" : "put",
      ariaLive: "assertive",
      ariaLabel: `entra ahora en ${dir}, quedan ${rem} segundos`,
    };
  }

  // Linha secundária de operação em andamento (IN_TRADE)
  let inTradeSecondary = null;
  let inTradeProgress = null;
  if (trade && trade.phase === "IN_TRADE") {
    const dir = trade.direction || "CALL";
    const targetTs = trade.targetTs != null ? trade.targetTs : Math.floor(nowSec / tf) * tf;
    const remTrade = Math.max(0, Math.ceil((targetTs + 60) - nowSec));
    inTradeSecondary = `En operación ${dir} · expira en ${remTrade}s`;
    inTradeProgress = Math.min(100, Math.max(0, ((60 - remTrade) / 60) * 100));

    // Se o snapshot passado foi puramente o objeto IN_TRADE (não composite)
    if (!isComposite && snapshot.phase === "IN_TRADE") {
      return {
        primaryText: inTradeSecondary,
        secondaryText: null,
        phase: "IN_TRADE",
        direction: dir,
        secondsRemaining: remTrade,
        progressPct: inTradeProgress,
        badgeText: `EN OPERACIÓN · ${dir}`,
        badgeClass: dir === "CALL" ? "call" : "put",
        ariaLive: "polite",
        ariaLabel: `en operación ${dir}, expira en ${remTrade} segundos`,
      };
    }
  }

  // 3. SETTLED (Resultado mantido por até 8 s)
  if (lastResult && lastResult.phase === "SETTLED") {
    const settledAt = lastResult.settledAt || (lastResult.targetTs ? lastResult.targetTs + 60 : nowSec);
    const holdSec = 8;
    if (nowSec - settledAt <= holdSec || (!isComposite && snapshot.phase === "SETTLED")) {
      const resStr = formatResult(lastResult.result);
      const dir = lastResult.direction || null;
      return {
        primaryText: `Resultado: ${resStr}`,
        secondaryText: inTradeSecondary,
        phase: "SETTLED",
        direction: dir,
        secondsRemaining: 0,
        progressPct: 100,
        badgeText: resStr,
        badgeClass: lastResult.result === "WIN" ? "call" : lastResult.result === "LOSS" ? "put" : "wait",
        ariaLive: "polite",
        ariaLabel: `resultado de operación: ${resStr.toLowerCase()}`,
      };
    }
  }

  // 4. PRE_SIGNAL (Alerta e contagem regressiva para a entrada)
  if (current && current.phase === "PRE_SIGNAL") {
    const dir = current.direction || "CALL";
    const dirSymbol = dir === "CALL" ? "CALL ▲" : "PUT ▼";
    const targetTs = current.targetTs != null ? current.targetTs : Math.floor(nowSec / tf) * tf + tf;
    const rem = Math.max(0, Math.ceil(targetTs - nowSec));
    // Janela de pré-sinal: de 52s a 60s (8s)
    const progressPct = Math.min(100, Math.max(0, ((8 - rem) / 8) * 100));

    return {
      primaryText: `PRE-SEÑAL ${dirSymbol} · entra en ${rem}s`,
      secondaryText: inTradeSecondary,
      phase: "PRE_SIGNAL",
      direction: dir,
      secondsRemaining: rem,
      progressPct,
      badgeText: `PRE-SEÑAL · ${dir}`,
      badgeClass: dir === "CALL" ? "call" : "put",
      ariaLive: "polite",
      ariaLabel: `pre-señal ${dir}, entra en ${rem} segundos`,
    };
  }

  // 5. CANCELLED
  if (current && current.phase === "CANCELLED") {
    const reasonText = formatCancelReason(current.reason);
    return {
      primaryText: `Señal cancelada · ${reasonText}`,
      secondaryText: inTradeSecondary,
      phase: "CANCELLED",
      direction: null,
      secondsRemaining: 0,
      progressPct: 0,
      badgeText: "CANCELADA",
      badgeClass: "wait",
      ariaLive: "polite",
      ariaLabel: `señal cancelada por ${reasonText}`,
    };
  }

  // 6. NO_ENTRY
  if (current && current.phase === "NO_ENTRY") {
    return {
      primaryText: "Sin entrada en esta vela",
      secondaryText: inTradeSecondary,
      phase: "NO_ENTRY",
      direction: null,
      secondsRemaining: 0,
      progressPct: inTradeProgress ?? 100,
      badgeText: "SIN ENTRADA",
      badgeClass: "wait",
      ariaLive: "polite",
      ariaLabel: "sin entrada en esta vela",
    };
  }

  // 7. DECIDING
  if (current && current.phase === "DECIDING") {
    const formingTs = current.formingTs != null ? current.formingTs : Math.floor(nowSec / tf) * tf;
    const rem = Math.max(0, Math.ceil((formingTs + 58) - nowSec));
    const s = nowSec - formingTs;
    const progressPct = inTradeProgress ?? Math.min(100, Math.max(0, (s / 58) * 100));

    return {
      primaryText: `Analizando cierre · decide en ${rem}s`,
      secondaryText: inTradeSecondary,
      phase: "DECIDING",
      direction: null,
      secondsRemaining: rem,
      progressPct,
      badgeText: "DECIDIENDO",
      badgeClass: "wait",
      ariaLive: "polite",
      ariaLabel: `analizando cierre, decisión en ${rem} segundos`,
    };
  }

  // 8. SCANNING (Padrão)
  const formingTs = current?.formingTs != null ? current.formingTs : Math.floor(nowSec / tf) * tf;
  const rem = Math.max(0, Math.ceil((formingTs + 45) - nowSec));
  const s = nowSec - formingTs;
  const progressPct = inTradeProgress ?? Math.min(100, Math.max(0, (s / 45) * 100));

  return {
    primaryText: `Escuchando ${pair} · decisión en ${rem}s`,
    secondaryText: inTradeSecondary,
    phase: "SCANNING",
    direction: null,
    secondsRemaining: rem,
    progressPct,
    badgeText: "ESCANEANDO",
    badgeClass: "wait",
    ariaLive: "polite",
    ariaLabel: `escuchando ${pair}, decisión en ${rem} segundos`,
  };
}
