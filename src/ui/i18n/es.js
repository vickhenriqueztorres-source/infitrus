export const ES = Object.freeze({
  brand: "INFLITRUS",
  descriptor: "SIGNALS",
  footer: "Inflitrus detecta. Tú decides.",
  connecting: "INFILTRÁNDOSE",
  calibrating: "CALIBRANDO",
  scanning: "ESCANEANDO",
  intercepted: "SEÑAL INTERCEPTADA",
  blocked: "SEÑAL BLOQUEADA",
  searchingTransmission: "Buscando la transmisión…",
  marketNoise: "Ruido de mercado. Sin señal.",
  transmissionIntercepted: "Transmisión interceptada.",
  patternDetected: "Patrón detectado. Validando…",
  windowClosed: "Ventana cerrada.",
  validFor: "Válida por",
  currentPrice: "PRECIO ACTUAL",
  payout: "PAYOUT",
  feed: "FEED",
  stable: "Estable",
  unstable: "Inestable",
  noData: "Sin datos",
  record: "Registro",
  market: "Mercado",
  system: "Logs",
  sound: "Sonido",
  mode: "Modo",
  standard: "Estándar",
  mini: "Mini",
  copy: "Copiar",
  copied: "Copiado",
  clear: "Limpiar",
  technicalRecords: "Logs en tiempo real",
  technicalState: "Estado técnico",
  history: "Histórico",
  gaps: "Gaps",
  websocket: "WebSocket",
  engines: "Estrategias (5)",
  tickPressure: "Presión de ticks",
  regime: "Régimen",
  lastCandle: "Última vela",
  dataAge: "Edad del dato",
  quantitativeReading: "Lectura cuantitativa",
  probability: "Prob.",
  edge: "Edge",
  quality: "Calidad",
  breakEven: "Break-even",
  noSignals: "Aún no hay señales interceptadas.",
  waitingHistory: "Esperando historial M1…",
  waitingEvents: "Esperando eventos del sistema…",
  pending: "Pendiente",
  onboarding1: "Abre un gráfico en B2Trading.",
  onboarding2: "Inflitrus se conecta y calibra.",
  onboarding3: "Espera la señal. Tú decides.",
  understood: "Entendido",
  legal: "Inflitrus Signals es una herramienta de análisis técnico. No ejecuta operaciones ni garantiza resultados. Operar implica riesgo de pérdida. Tú decides.",
});

const EXACT_REASON_MAP = new Map([
  ["EMA 9 cruzou acima da EMA 21", "EMA 9 cruzó EMA 21"],
  ["EMA 9 cruzou abaixo da EMA 21", "EMA 9 cruzó bajo EMA 21"],
  ["RSI acima de 50", "RSI > 50"],
  ["RSI abaixo de 50", "RSI < 50"],
  ["Candle confirmado", "Vela confirmada"],
  ["Regressão Logística", "Regresión logística"],
  ["Aguardando convergência de indicadores", "Esperando convergencia de indicadores"],
  ["Dados insuficientes no ensemble", "Datos insuficientes en el conjunto"],
  ["Sem cruzamento confirmado no último candle", "Sin cruce confirmado en la última vela"],
  ["Inicializando portfólio quantitativo...", "Inicializando lectura cuantitativa…"],
  ["Inicializando observador quant", "Inicializando observador técnico"],
  ["Ensemble M1", "Conjunto M1"],
  ["Bayes Hierárquico", "Bayes jerárquico"],
  ["KNN Adaptativo", "KNN adaptativo"],
  ["Dinâmica Temporal", "Dinámica temporal"],
  ["Microestrutura Probabilística", "Microestructura probabilística"],
  ["Continuação / Momentum", "Continuación / Momentum"],
  ["Reversão / Exaustão", "Reversión / Agotamiento"],
  ["Microestrutura / Fluxo", "Microestructura / Flujo"],
  ["Expansão de Volatilidade", "Expansión de Volatilidad"],
  ["Analogia Histórica", "Analogía Histórica (KNN)"],
]);

export function translateReason(value, { debug = false } = {}) {
  const original = String(value ?? "").trim();
  if (!original) return "Condición técnica pendiente.";
  if (EXACT_REASON_MAP.has(original)) return EXACT_REASON_MAP.get(original);

  let translated = original
    .replace(/EMA 9 \(([^)]+)\) cruzou acima da EMA 21 \(([^)]+)\)/gi, "EMA 9 ($1) cruzó EMA 21 ($2)")
    .replace(/EMA 9 \(([^)]+)\) cruzou abaixo da EMA 21 \(([^)]+)\)/gi, "EMA 9 ($1) cruzó bajo EMA 21 ($2)")
    .replace(/RSI 14 em ([\d.,]+) \(acima de 50\)/gi, "RSI 14 en $1 (> 50)")
    .replace(/RSI 14 em ([\d.,]+) \(abaixo de 50\)/gi, "RSI 14 en $1 (< 50)")
    .replace(/Vela confirmada em/gi, "Vela confirmada en")
    .replace(/Candle confirmado em/gi, "Vela confirmada en")
    .replace(/Coletando dados M1 \((\d+)\/(\d+) velas necessárias\)/gi, "Calibrando M1 ($1/$2 velas)")
    .replace(/Aquecendo indicadores: (\d+)\/(\d+) velas necessárias/gi, "Calibrando indicadores: $1/$2 velas")
    .replace(/Edge presente/gi, "Edge presente")
    .replace(/mas qualidade insuficiente/gi, "pero calidad insuficiente")
    .replace(/Edge insuficiente contra payout de/gi, "Edge insuficiente para un payout de")
    .replace(/BE necessário/gi, "BE necesario")
    .replace(/Vantagem estatística confirmada/gi, "Ventaja estadística confirmada")
    .replace(/Qualidade:/gi, "Calidad:")
    .replace(/Incerteza entre modelos/gi, "Incertidumbre entre modelos")
    .replace(/Veto: Feed de dados congelado/gi, "Veto: Feed de datos congelado")
    .replace(/Veto: Lacunas anormais de dados/gi, "Veto: Gaps anormales de datos")
    .replace(/Veto: Dados corrompidos/gi, "Veto: Datos dañados")
    .replace(/Confluência/gi, "Confluencia")
    .replace(/Aguardando/gi, "Esperando")
    .replace(/histórico/gi, "historial")
    .replace(/dados/gi, "datos")
    .replace(/qualidade/gi, "calidad")
    .replace(/insuficiente/gi, "insuficiente")
    .replace(/Tendência:/gi, "Tendencia:")
    .replace(/Alta/gi, "Alcista")
    .replace(/Baixa/gi, "Bajista")
    .replace(/Lateral/gi, "Lateral");

  if (translated === original && debug) {
    console.warn(`[inflitrus] i18n faltando: ${original}`);
  }
  return translated;
}

export function translateRegime(value) {
  const regime = String(value || "---").toUpperCase();
  const map = {
    STABLE: "Estable",
    TRENDING: "Tendencial",
    RANGING: "Lateral",
    VOLATILE: "Volátil",
    EXPANSION: "Expansión",
    COMPRESSION: "Compresión",
    UNKNOWN: "Sin datos",
  };
  return map[regime] || value || "Sin datos";
}

export function translateEngineName(value) {
  return EXACT_REASON_MAP.get(String(value || "")) || translateReason(value);
}
