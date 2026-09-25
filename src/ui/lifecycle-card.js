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
      tradeCard: { hasTrade: false, phase: "NO_TRADE", direction: null, primaryText: "Sin operación en curso", badgeText: "SIN OPERACIÓN", badgeClass: "wait" },
      opportunityCard: { hasOpportunity: false, phase: "SCANNING", direction: null, primaryText: "Escuchando mercado", badgeText: "ESCANEANDO", badgeClass: "wait" },
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

  const tradeCard = (trade && ["ENTRY_NOW", "IN_TRADE"].includes(trade.phase))
    ? {
        hasTrade: true,
        phase: trade.phase,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        pair: trade.pair || pair,
        targetTs: trade.targetTs,
        secondsRemaining: trade.phase === "ENTRY_NOW"
          ? Math.max(0, Math.ceil((trade.targetTs + 5) - nowSec))
          : Math.max(0, Math.ceil((trade.targetTs + 60) - nowSec)),
        badgeText: trade.phase === "ENTRY_NOW" ? `ENTRA AHORA · ${trade.direction}` : `EN OPERACIÓN · ${trade.direction}`,
        badgeClass: trade.direction === "CALL" ? "call" : "put",
        title: trade.phase === "ENTRY_NOW" ? `ENTRA AHORA — ${trade.direction === "CALL" ? "CALL ▲" : "PUT ▼"}` : `OPERACIÓN EN CURSO — ${trade.direction === "CALL" ? "CALL ▲" : "PUT ▼"}`,
        subTitle: Number.isFinite(trade.entryPrice) ? `Entrada: ${Number(trade.entryPrice).toFixed(5)}` : (trade.phase === "ENTRY_NOW" ? "Ejecute inmediatamente en el broker" : "Operación en curso en el broker"),
      }
    : (lastResult && lastResult.phase === "SETTLED" && (nowSec - (lastResult.settledAt || nowSec) <= 10)
        ? {
            hasTrade: true,
            phase: "SETTLED",
            direction: lastResult.direction,
            result: lastResult.result,
            pair,
            secondsRemaining: 0,
            badgeText: formatResult(lastResult.result),
            badgeClass: lastResult.result === "WIN" ? "call" : lastResult.result === "LOSS" ? "put" : "wait",
            title: `Resultado: ${formatResult(lastResult.result)}${lastResult.direction ? ` (${lastResult.direction})` : ""}`,
            subTitle: Number.isFinite(lastResult.entryPrice) && Number.isFinite(lastResult.closePrice)
              ? `Entrada: ${Number(lastResult.entryPrice).toFixed(5)} → Cierre: ${Number(lastResult.closePrice).toFixed(5)}`
              : "Operación finalizada",
          }
        : {
            hasTrade: false,
            phase: "NO_TRADE",
            direction: null,
            pair,
            secondsRemaining: 0,
            badgeText: "SIN OPERACIÓN",
            badgeClass: "wait",
            title: "Sin operación activa",
            subTitle: "Esperando próxima entrada",
          });

  const opportunityCard = (current && current.phase === "PRE_SIGNAL")
    ? {
        hasOpportunity: true,
        phase: "PRE_SIGNAL",
        direction: current.direction,
        pair: current.pair || pair,
        targetTs: current.targetTs,
        secondsRemaining: Math.max(0, Math.ceil((current.targetTs || (Math.floor(nowSec / tf) * tf + tf)) - nowSec)),
        badgeText: `PRE-SEÑAL · ${current.direction}`,
        badgeClass: current.direction === "CALL" ? "call" : "put",
        title: `PRE-SEÑAL ${current.direction === "CALL" ? "CALL ▲" : "PUT ▼"}`,
        subTitle: `Entrada al segundo :00 (vela ${current.targetTs ? new Date(current.targetTs * 1000).toTimeString().slice(0, 5) : "--:--"})`,
      }
    : (current && current.phase === "DECIDING"
        ? {
            hasOpportunity: true,
            phase: "DECIDING",
            direction: null,
            pair: current.pair || pair,
            secondsRemaining: Math.max(0, Math.ceil(((current.formingTs || Math.floor(nowSec / tf) * tf) + 58) - nowSec)),
            badgeText: "DECIDIENDO",
            badgeClass: "wait",
            title: "Analizando cierre",
            subTitle: "Decisión en instantes",
          }
        : {
            hasOpportunity: false,
            phase: current?.phase || "SCANNING",
            direction: null,
            pair,
            secondsRemaining: Math.max(0, Math.ceil(((current?.formingTs || Math.floor(nowSec / tf) * tf) + 45) - nowSec)),
            badgeText: "ESCANEANDO",
            badgeClass: "wait",
            title: `Escuchando ${pair}`,
            subTitle: "Buscando oportunidades estadísticas",
          });

  function wrap(res) {
    res.tradeCard = tradeCard;
    res.opportunityCard = opportunityCard;
    return res;
  }

  // 2. ENTRY_NOW (Prioridade máxima / Maior destaque da tela)
  if (trade && trade.phase === "ENTRY_NOW") {
    const dir = trade.direction || "CALL";
    const dirSymbol = dir === "CALL" ? "CALL ▲" : "PUT ▼";
    const targetTs = trade.targetTs != null ? trade.targetTs : Math.floor(nowSec / tf) * tf;
    const rem = Math.max(0, Math.ceil((targetTs + 5) - nowSec));
    const elapsed = nowSec - targetTs;
    const progressPct = Math.min(100, Math.max(0, (elapsed / 5) * 100));

    return wrap({
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
    });
  }

  // Linha secundária de operação em andamento (IN_TRADE)
  let inTradeSecondary = null;
  let inTradeProgress = null;
  if (trade && trade.phase === "IN_TRADE") {
    const dir = trade.direction || "CALL";
    const dirSymbol = dir === "CALL" ? "CALL ▲" : "PUT ▼";
    const targetTs = trade.targetTs != null ? trade.targetTs : Math.floor(nowSec / tf) * tf;
    const remTrade = Math.max(0, Math.ceil((targetTs + 60) - nowSec));
    inTradeSecondary = `En operación ${dir} · expira en ${remTrade}s`;
    inTradeProgress = Math.min(100, Math.max(0, ((60 - remTrade) / 60) * 100));

    // Se NÃO há PRE_SIGNAL ativo na vela atual, a operação em curso É O CARD PRINCIPAL!
    if (!current || current.phase !== "PRE_SIGNAL") {
      const entryText = Number.isFinite(trade.entryPrice)
        ? `Entrada: ${Number(trade.entryPrice).toFixed(5)}`
        : (inTradeSecondary || "Operación en curso en el broker");

      const isExpiring = remTrade <= 2 && remTrade > 0;
      const isExpired = remTrade <= 0;

      let primaryText;
      let badgeText;
      if (isExpired) {
        primaryText = `OPERACIÓN EXPIRADA · expira en 0s (esperando resultado)`;
        badgeText = `EXPIRADO · ${dir}`;
      } else if (isExpiring) {
        primaryText = `FINALIZANDO OPERACIÓN — ${dirSymbol} · expira en ${remTrade}s`;
        badgeText = `EXPIRANDO · ${dir}`;
      } else {
        primaryText = `OPERACIÓN EN CURSO — ${dirSymbol} · expira en ${remTrade}s`;
        badgeText = `EN OPERACIÓN · ${dir}`;
      }

      return wrap({
        primaryText,
        secondaryText: isExpired ? "Aguardando confirmación de vela cerrada..." : entryText,
        phase: "IN_TRADE",
        direction: dir,
        secondsRemaining: remTrade,
        progressPct: inTradeProgress,
        badgeText,
        badgeClass: dir === "CALL" ? "call" : "put",
        ariaLive: "polite",
        ariaLabel: `en operación ${dir}, expira en ${remTrade} segundos`,
      });
    }
  }

  // 3. SETTLED (Resultado mantido por até 10 s)
  if (lastResult && lastResult.phase === "SETTLED") {
    const settledAt = lastResult.settledAt || (lastResult.targetTs ? lastResult.targetTs + 60 : nowSec);
    const holdSec = 10;
    if (nowSec - settledAt <= holdSec || (!isComposite && snapshot.phase === "SETTLED")) {
      const resStr = formatResult(lastResult.result);
      const dir = lastResult.direction || null;
      const dirSymbol = dir ? (dir === "CALL" ? "CALL ▲" : "PUT ▼") : "";
      const priceText = Number.isFinite(lastResult.entryPrice) && Number.isFinite(lastResult.closePrice)
        ? `Entrada: ${Number(lastResult.entryPrice).toFixed(5)} → Cierre: ${Number(lastResult.closePrice).toFixed(5)}`
        : inTradeSecondary;
      return wrap({
        primaryText: `Resultado: ${resStr}${dirSymbol ? ` (${dirSymbol})` : ""}`,
        secondaryText: priceText,
        phase: "SETTLED",
        direction: dir,
        secondsRemaining: 0,
        progressPct: 100,
        badgeText: resStr,
        badgeClass: lastResult.result === "WIN" ? "call" : lastResult.result === "LOSS" ? "put" : "wait",
        ariaLive: "polite",
        ariaLabel: `resultado de operación: ${resStr.toLowerCase()}`,
      });
    }
  }

  // 4. PRE_SIGNAL (Alerta e contagem regressiva para a entrada)
  if (current && current.phase === "PRE_SIGNAL") {
    const dir = current.direction || "CALL";
    const dirSymbol = dir === "CALL" ? "CALL ▲" : "PUT ▼";
    const targetTs = current.targetTs != null ? current.targetTs : Math.floor(nowSec / tf) * tf + tf;
    const rem = Math.max(0, Math.ceil(targetTs - nowSec));
    // Janela de pré-sinal: de 45s a 60s (15s)
    const progressPct = Math.min(100, Math.max(0, ((15 - rem) / 15) * 100));

    const targetDate = new Date(targetTs * 1000);
    const targetTime = targetDate.toTimeString().slice(0, 5);
    const preSecondary = inTradeSecondary || `Entrada al segundo :00 (vela ${targetTime})`;

    return wrap({
      primaryText: `PRE-SEÑAL ${dirSymbol} · entra en ${rem}s`,
      secondaryText: preSecondary,
      phase: "PRE_SIGNAL",
      direction: dir,
      secondsRemaining: rem,
      progressPct,
      badgeText: `PRE-SEÑAL · ${dir}`,
      badgeClass: dir === "CALL" ? "call" : "put",
      ariaLive: "polite",
      ariaLabel: `pre-señal ${dir}, entra en ${rem} segundos`,
    });
  }

  // 5. CANCELLED
  if (current && current.phase === "CANCELLED") {
    const reasonText = formatCancelReason(current.reason);
    return wrap({
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
    });
  }

  // 6. NO_ENTRY
  if (current && current.phase === "NO_ENTRY") {
    return wrap({
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
    });
  }

  // 7. DECIDING
  if (current && current.phase === "DECIDING") {
    const formingTs = current.formingTs != null ? current.formingTs : Math.floor(nowSec / tf) * tf;
    const rem = Math.max(0, Math.ceil((formingTs + 58) - nowSec));
    const s = nowSec - formingTs;
    const progressPct = inTradeProgress ?? Math.min(100, Math.max(0, (s / 58) * 100));

    return wrap({
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
    });
  }

  // 8. SCANNING (Padrão)
  const formingTs = current?.formingTs != null ? current.formingTs : Math.floor(nowSec / tf) * tf;
  const rem = Math.max(0, Math.ceil((formingTs + 45) - nowSec));
  const s = nowSec - formingTs;
  const progressPct = inTradeProgress ?? Math.min(100, Math.max(0, (s / 45) * 100));

  let scanSecondary = inTradeSecondary;
  if (!scanSecondary && lastResult && lastResult.result) {
    const lastResStr = formatResult(lastResult.result);
    const lastDir = lastResult.direction ? ` ${lastResult.direction}` : "";
    scanSecondary = `Última operación: ${lastResStr}${lastDir}`;
  }

  return wrap({
    primaryText: `Escuchando ${pair} · decisión en ${rem}s`,
    secondaryText: scanSecondary,
    phase: "SCANNING",
    direction: null,
    secondsRemaining: rem,
    progressPct,
    badgeText: "ESCANEANDO",
    badgeClass: "wait",
    ariaLive: "polite",
    ariaLabel: `escuchando ${pair}, decisión en ${rem} segundos`,
  });
}
