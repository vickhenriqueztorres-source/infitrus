import { ES, translateEngineName, translateReason } from "../i18n/es.js";
import { icon, logoMarkup } from "../icons.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function percent(value, digits = 1) {
  return `${(Number(value || 0) * 100).toLocaleString("es-419", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

function metric(value, digits = 5) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "—";
}

function ringMarkup(vm, compact = false) {
  const radius = compact ? 13 : 30;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(1, Number(vm.countdown.progress || 0)));
  const offset = circumference * (1 - progress);
  const label = vm.signal?.phase === "live"
    ? `0:${String(vm.signal.validRemainingSec).padStart(2, "0")}`
    : vm.countdown.formatted;
  return `<div class="ifx-ring${compact ? " is-compact" : ""}${vm.countdown.urgent ? " is-urgent" : ""}" aria-label="${escapeHtml(label)}">
    <svg viewBox="0 0 ${compact ? 32 : 72} ${compact ? 32 : 72}" aria-hidden="true">
      <circle class="ifx-ring-track" cx="${compact ? 16 : 36}" cy="${compact ? 16 : 36}" r="${radius}"/>
      <circle class="ifx-ring-progress" cx="${compact ? 16 : 36}" cy="${compact ? 16 : 36}" r="${radius}" style="stroke-dasharray:${circumference};stroke-dashoffset:${offset}"/>
    </svg>
    <span>${label}</span>
  </div>`;
}

function settingsMarkup(prefs) {
  if (!prefs.settingsOpen) return "";
  return `<div class="ifx-settings" role="menu">
    <button type="button" data-action="toggle-sound" role="menuitem">${icon(prefs.soundEnabled ? "volume" : "volumeOff", 16)}<span>${ES.sound}</span><strong>${prefs.soundEnabled ? "Activo" : "Silenciado"}</strong></button>
    <button type="button" data-action="toggle-collapse" role="menuitem">${icon("minus", 16)}<span>${ES.mode}</span><strong>${prefs.collapsed ? ES.mini : ES.standard}</strong></button>
  </div>`;
}

function headerMarkup(vm, prefs) {
  return `<header class="ifx-header">
    ${logoMarkup()}
    <div class="ifx-asset"><span class="ifx-dot is-${vm.statusDot}"></span><strong>${escapeHtml(vm.asset)}</strong><span>·</span><span>${escapeHtml(vm.timeframe)}</span></div>
    <div class="ifx-header-actions">
      <button type="button" class="ifx-icon-button" data-action="toggle-settings" title="Configuración" aria-label="Configuración">${icon("gear", 18)}</button>
      <button type="button" class="ifx-icon-button" data-action="toggle-collapse" title="Minimizar" aria-label="Minimizar">${icon("minus", 18)}</button>
    </div>
    ${settingsMarkup(prefs)}
  </header>`;
}

function coreMarkup(vm) {
  const signal = vm.signal;
  const direction = signal ? `${signal.direction} ${signal.arrow}` : "";
  const calibration = vm.calibration
    ? `<div class="ifx-calibration"><div><span>${vm.calibration.have}/${vm.calibration.need}</span><span>velas sincronizadas</span></div><div class="ifx-progress"><span style="transform:scaleX(${vm.calibration.progress})"></span></div></div>`
    : "";
  const directionMarkup = signal
    ? `<div class="ifx-direction is-${signal.direction.toLowerCase()}${signal.phase === "expired" ? " is-expired" : ""}">${direction}</div><div class="ifx-validity">${signal.phase === "expired" ? ES.windowClosed : `${ES.validFor} <strong>0:${String(signal.validRemainingSec).padStart(2, "0")}</strong>`}</div>`
    : "";
  return `<section class="ifx-core${vm.visualState === "ESCANEANDO" ? " has-radar" : ""}">
    <div class="ifx-wave-wrap"><canvas class="ifx-wave" data-wave aria-label="Visualización de frecuencia"></canvas></div>
    <div class="ifx-core-grid">
      <div class="ifx-core-copy">
        <p class="ifx-whisper">${escapeHtml(vm.whisper)}</p>
        <h2>${escapeHtml(vm.title)}</h2>
        ${directionMarkup}
        ${calibration}
      </div>
      ${ringMarkup(vm)}
    </div>
  </section>`;
}

function checklistMarkup(vm) {
  return `<section class="ifx-checklist" aria-label="Condiciones">
    ${vm.checklist.map((item) => `<div class="ifx-condition is-${item.status}">${icon(item.status === "ok" ? "check" : item.status === "fail" ? "x" : "circle", 18)}<span>${escapeHtml(item.label)}</span></div>`).join("")}
    ${vm.checklistExtra ? `<button type="button" class="ifx-more" data-action="open-market">+${vm.checklistExtra} más</button>` : ""}
  </section>`;
}

function contextMarkup(vm) {
  const feedClass = vm.context.feed === ES.stable ? "teal" : vm.context.feed === ES.noData ? "steel" : "amber";
  return `<section class="ifx-context">
    <div><span>${ES.currentPrice}</span><strong>${escapeHtml(vm.context.price)}</strong></div>
    <button type="button" data-action="toggle-payout"><span>${ES.payout}</span><strong>${vm.context.payout}%</strong></button>
    <div><span>${ES.feed}</span><strong><i class="ifx-dot is-${feedClass}"></i>${escapeHtml(vm.context.feed)}</strong></div>
  </section>`;
}

function payoutMarkup(prefs, vm) {
  if (!prefs.payoutOpen) return "";
  return `<div class="ifx-payout-picker" aria-label="Payout">${[70, 80, 85, 90].map((value) => `<button type="button" data-action="set-payout" data-value="${value / 100}" class="${value === vm.context.payout ? "is-active" : ""}">${value}%</button>`).join("")}</div>`;
}

function recordContent(vm) {
  const rows = vm.registro.rows;
  return `<div class="ifx-tab-summary"><strong>${vm.registro.winRate.toLocaleString("es-419", { maximumFractionDigits: 1 })}%</strong><span>${vm.registro.wins} W · ${vm.registro.losses} L</span></div>
    ${rows.length ? `<div class="ifx-table-wrap"><table><thead><tr><th>HORA</th><th>DIR.</th><th>ESTRATEGIA</th><th>RESULTADO</th></tr></thead><tbody>${rows.map((row) => {
      const direction = row.direction === "PUT" ? "PUT ▼" : "CALL ▲";
      const result = row.status === "PENDING" ? ES.pending : row.result === "WIN" ? `WIN +${row.pnlUnits ?? row.payout ?? 0.8}` : row.result === "LOSS" ? "LOSS -1" : "DOJI 0";
      const resultClass = row.status === "PENDING" ? "pending" : String(row.result || "").toLowerCase();
      const strategy = translateEngineName(row.strategyName || "—");
      return `<tr><td>${escapeHtml(row.timeFormatted || "—")}</td><td class="${row.direction === "PUT" ? "put" : "call"}">${direction}</td><td title="${escapeHtml(strategy)}">${escapeHtml(strategy)}</td><td class="${resultClass}">${result}</td></tr>`;
    }).join("")}</tbody></table></div>` : `<p class="ifx-empty">${ES.noSignals}</p>`}`;
}

function marketContent(vm) {
  const market = vm.mercado;
  return `<div class="ifx-metric-grid">
    <div><span>EMA 9</span><strong>${metric(market.ema9)}</strong></div>
    <div><span>EMA 21</span><strong>${metric(market.ema21)}</strong></div>
    <div><span>RSI 14</span><strong>${metric(market.rsi14, 1)}</strong></div>
    <div><span>${ES.lastCandle}</span><strong>${escapeHtml(market.lastCandle)}</strong></div>
    <div><span>${ES.dataAge}</span><strong>${market.dataAge == null ? "—" : `${market.dataAge}s`}</strong></div>
    <div><span>${ES.regime}</span><strong>${escapeHtml(market.regime)}</strong></div>
  </div>
  <h4>${ES.quantitativeReading}</h4>
  <div class="ifx-quant-row"><span>${ES.probability}<strong>${percent(market.probability)}</strong></span><span>${ES.edge}<strong>${percent(market.edge)}</strong></span><span>${ES.quality}<strong>${percent(market.quality, 0)}</strong></span><span>${ES.breakEven}<strong>${percent(market.breakEven)}</strong></span></div>
  <div class="ifx-pressure"><span>${ES.tickPressure}</span><div><i style="transform:scaleX(${Math.min(1, Math.abs(market.pressure))})" class="${market.pressure < 0 ? "is-put" : ""}"></i></div><strong>${market.pressure.toFixed(2)}</strong></div>
  <h4>${ES.engines}</h4>
  <div class="ifx-engines">${market.strategies.length ? market.strategies.map((engine) => { const name = translateEngineName(engine.name); return `<div><span title="${escapeHtml(name)}">${escapeHtml(name)}</span><strong class="is-${String(engine.action || "wait").toLowerCase()}">${engine.action === "CALL" ? "CALL ▲" : engine.action === "PUT" ? "PUT ▼" : "NEUTRO"}</strong><small>${percent(engine.probUp)}</small></div>`; }).join("") : `<p class="ifx-empty">${ES.waitingHistory}</p>`}</div>`;
}

export function translateLogMessage(message) {
  return translateReason(message)
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/Analyzer ativo em/gi, "Analizador activo en")
    .replace(/janela principal/gi, "ventana principal")
    .replace(/iframe gráfico/gi, "iframe del gráfico")
    .replace(/Qualidade dos dados/gi, "Calidad de datos")
    .replace(/WebSocket conectado ao stream de mercado/gi, "WebSocket conectado al flujo de mercado")
    .replace(/Conexão WebSocket encerrada/gi, "Conexión WebSocket cerrada")
    .replace(/Esperando reconexão/gi, "Esperando reconexión")
    .replace(/candles carregados para/gi, "velas cargadas para")
    .replace(/candles/gi, "velas")
    .replace(/Ativo no feed/gi, "Activo del feed")
    .replace(/foco anterior/gi, "foco anterior")
    .replace(/Candle inválido rejeitado/gi, "Vela inválida rechazada")
    .replace(/Nova vela aberta em/gi, "Nueva vela abierta en")
    .replace(/Fechamento anterior/gi, "Cierre anterior")
    .replace(/Gap detectado em/gi, "Gap detectado en")
    .replace(/ até /gi, " hasta ")
    .replace(/Qualidade:/gi, "Calidad:")
    .replace(/(\d+)V\/(\d+)D/g, "$1W/$2L")
    .replace(/RESULTADO/gi, "RESULTADO")
    .replace(/Empate/gi, "Empate")
    .trim();
}

export function translateLogTag(tag) {
  const tags = { SINAL: "SEÑAL", HISTÓRICO: "HISTORIAL", ESTADO: "ESTADO", SISTEMA: "SISTEMA", INDICADOR: "INDICADOR" };
  return tags[tag] || tag || "SYS";
}

function systemContent(vm, logs) {
  return `<div class="ifx-system-grid">
    <span>${ES.websocket}<strong>${escapeHtml(vm.sistema.websocket)}</strong></span>
    <span>${ES.history}<strong>${vm.sistema.history} velas</strong></span>
    <span>${ES.gaps}<strong>${vm.sistema.gaps}</strong></span>
    <span>${ES.technicalState}<strong>${escapeHtml(vm.sistema.technicalState)}</strong></span>
  </div>
  ${vm.debug ? `<div class="ifx-debug"><span>Vista previa</span>${["CONECTANDO", "CALIBRANDO", "ESCANEANDO", "SENAL", "BLOQUEADO"].map((state) => `<button type="button" data-action="debug-state" data-value="${state}">${state === "SENAL" ? "SEÑAL" : state}</button>`).join("")}<button type="button" data-action="debug-state" data-value="">REAL</button></div>` : ""}
  <div class="ifx-log-head"><span>${ES.technicalRecords} (${logs.length})</span><div><button type="button" data-action="copy-logs">${icon("copy", 14)}${ES.copy}</button><button type="button" data-action="clear-logs">${icon("trash", 14)}${ES.clear}</button></div></div>
  <div class="ifx-logs" role="log" aria-live="polite">${logs.length ? logs.slice(-40).reverse().map((entry) => `<div class="is-${escapeHtml(entry.level || "info")}"><time>${escapeHtml(String(entry.time || "").split(".")[0])}</time><b>[${escapeHtml(translateLogTag(entry.tag))}]</b><span>${escapeHtml(translateLogMessage(entry.message || ""))}</span></div>`).join("") : `<p class="ifx-empty">${ES.waitingEvents}</p>`}</div>`;
}

function tabsMarkup(vm, prefs, logs) {
  const tabs = [
    ["record", ES.record, "document"],
    ["market", ES.market, "bars"],
    ["system", ES.system, "gear"],
  ];
  return `<section class="ifx-tabs">${tabs.map(([id, label, iconName]) => `<button type="button" class="ifx-tab ${prefs.openTab === id ? "is-open" : ""}" data-action="toggle-tab" data-value="${id}">${icon(iconName, 17)}<span>${label}</span>${icon("chevron", 15)}</button>`).join("")}
    ${prefs.openTab ? `<div class="ifx-tab-content">${prefs.openTab === "record" ? recordContent(vm) : prefs.openTab === "market" ? marketContent(vm) : systemContent(vm, logs)}</div>` : ""}
  </section>`;
}

export function expandedMarkup(vm, prefs, logs = []) {
  return `<article class="ifx-panel is-${vm.visualState.toLowerCase()}${vm.signal?.phase === "live" ? " has-live-signal" : ""}" aria-label="Inflitrus Signals">
    ${headerMarkup(vm, prefs)}
    <main class="ifx-main">${coreMarkup(vm)}${checklistMarkup(vm)}${contextMarkup(vm)}${payoutMarkup(prefs, vm)}</main>
    ${tabsMarkup(vm, prefs, logs)}
    <footer>${ES.footer}</footer>
  </article>`;
}

export function compactMarkup(vm) {
  const signal = vm.signal?.phase === "live" ? `<strong class="ifx-mini-signal is-${vm.signal.direction.toLowerCase()}">${vm.signal.direction} ${vm.signal.arrow}</strong>` : `<canvas class="ifx-mini-wave" data-wave aria-label="Frecuencia"></canvas>`;
  return `<button type="button" class="ifx-pill" data-action="toggle-collapse" aria-label="Expandir Inflitrus Signals">
    ${icon("pulse", 26, "ifx-logo-mark")}
    <span class="ifx-mini-asset"><strong>${escapeHtml(vm.asset)}</strong><small>· ${escapeHtml(vm.timeframe)}</small><i class="ifx-dot is-${vm.statusDot}"></i></span>
    ${signal}
    ${ringMarkup(vm, true)}
  </button>`;
}
