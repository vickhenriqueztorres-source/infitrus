A arquitetura mais robusta deve deixar o **processamento vivo dentro do content script da aba**, usar o `MAIN world` apenas para captura, e reservar o service worker para notificações, configurações e persistência. Assim, a extensão não depende da duração do service worker, não executa ordens e só gera sinais quando os candles estiverem sincronizados e validados.

## Arquitetura final

```
Chrome
└── traderoom.b2trading.io
    ├── página principal
    │   └── painel de sinais
    │
    └── iframe chart.b2trading.io
        ├── captura WebSocket/fetch
        ├── histórico getBars
        └── atualização subscribeBars
              │
              ▼
       Normalizador de mensagens
              │
              ▼
        Validador de dados
              │
              ▼
        CandleStore por ativo/timeframe
              │
              ▼
       Detector de sincronização
              │
              ▼
       Indicadores EMA/RSI/ATR
              │
              ▼
        Estratégia local
              │
              ▼
      BUY / SELL / WAIT / NO DATA
              │
              ├── painel visual
              ├── som/notificação
              └── histórico local
```

A Charting Library utiliza `getBars` para histórico e `subscribeBars` para atualizações em tempo real, mas a extensão deve observar as chamadas e os dados, sem depender diretamente dos nomes internos do bundle.[[tradingview](https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/)][[tradingview](https://www.tradingview.com/charting-library-docs/latest/tutorials/tutorials/implement_datafeed_tutorial/Streaming-Implementation/)]

## Divisão dos contextos

### Contexto MAIN

Executa dentro da página ou iframe do gráfico.

Responsável somente por:

- observar `WebSocket`;
- observar `fetch`;
- observar `XMLHttpRequest`;
- capturar mensagens recebidas;
- detectar mensagens `candle_update`;
- capturar respostas de histórico;
- enviar eventos sanitizados para o content script.

Não pode:

```
socket.send(...)
```

Não pode:

```
document.querySelector("#btnBuy").click()
document.querySelector("#btnSell").click()
```

Não pode:

- chamar APIs externas;
- armazenar tokens;
- salvar payloads brutos;
- acessar `chrome.storage`.

### Content script isolado

Executa na página principal e no iframe.

Responsável por:

- receber os eventos capturados;
- validar a origem;
- normalizar candles;
- manter o CandleStore;
- calcular indicadores;
- executar a estratégia;
- renderizar o painel;
- controlar estados de conexão;
- impedir sinais duplicados.

O processamento principal deve ficar aqui, não no service worker.

### Service worker

O service worker do Manifest V3 é acionado por eventos e pode ser descarregado quando fica inativo. Ele não deve manter o estado principal da análise.[[developer.chrome](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)][[developer.chrome](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers)]

Responsável somente por:

- notificações do Chrome;
- configurações;
- alarmes;
- comunicação entre abas;
- persistência eventual;
- exportação de sinais;
- telemetria local.

Ele não deve ser responsável por:

- CandleStore em tempo real;
- indicadores;
- parsing contínuo;
- detecção do fechamento;
- geração principal dos sinais.

## Manifesto recomendado

```
{
  "manifest_version": 3,
  "name": "Oracle Quant Signals",
  "version": "0.1.0",
  "description": "Análise local de candles e geração de sinais visuais.",
  "permissions": [
    "storage",
    "notifications"
  ],
  "host_permissions": [
    "https://traderoom.b2trading.io/*",
    "https://chart.b2trading.io/*",
    "https://restapi.b2trading.io/*"
  ],
  "background": {
    "service_worker": "src/background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": [
        "https://traderoom.b2trading.io/*",
        "https://chart.b2trading.io/*"
      ],
      "js": [
        "src/content/bridge.js",
        "src/content/analyzer.js"
      ],
      "css": [
        "src/content/panel.css"
      ],
      "all_frames": true,
      "run_at": "document_start"
    }
  ],
  "action": {
    "default_title": "Oracle Quant Signals",
    "default_popup": "src/popup/popup.html"
  },
  "options_page": "src/options/options.html"
}
```

A extensão deve verificar `location.origin` para diferenciar:

```
traderoom.b2trading.io
chart.b2trading.io
```

O `all_frames` é necessário para permitir a execução também nos frames compatíveis.[[developer.chrome](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)]

## Fluxo de captura

```
WebSocket/fetch no iframe
        │
        ▼
injected-main.js
        │
        │ window.postMessage()
        ▼
bridge.js isolado
        │
        │ valida origem e schema
        ▼
analyzer.js
        │
        ▼
normalizer.js
```

Evento interno:

```
{
  type: "MARKET_EVENT",
  sessionId: "random-session-id",
  origin: "https://chart.b2trading.io",
  receivedAt: 1727010185123,
  payload: {
    event: "candle_update",
    symbol: "EURUSD",
    resolution: "1",
    data: {
      time: 1727010180000,
      open: 1.0852,
      high: 1.08565,
      low: 1.0851,
      close: 1.08542,
      volume: 142.5
    }
  }
}
```

O evento deve ser rejeitado se:

- a origem não for autorizada;
- o `sessionId` não for reconhecido;
- o payload for maior que o limite;
- faltar `symbol`;
- faltar timestamp;
- o OHLC for inválido;
- o timestamp estiver fora da janela aceitável.

## Captura resiliente

A captura deve aceitar quatro tipos:

```
1. WebSocket string
2. WebSocket ArrayBuffer
3. Fetch JSON
4. XHR JSON
```

A extensão deve classificar as mensagens:

```
function classify(payload) {
  if (payload?.event === "candle_update") {
    return "CANDLE_UPDATE";
  }

  if (
    payload?.open !== undefined &&
    payload?.high !== undefined &&
    payload?.low !== undefined &&
    payload?.close !== undefined
  ) {
    return "CANDLE";
  }

  if (
    payload?.price !== undefined ||
    payload?.last !== undefined
  ) {
    return "TICK";
  }

  return "UNKNOWN";
}
```

Mensagens desconhecidas devem ser ignoradas, mas contabilizadas:

```
UNKNOWN_MESSAGE
```

Isso permite detectar mudança de protocolo sem gerar sinais incorretos.

## Camada de histórico

A extensão deve observar a resposta já utilizada pelo gráfico para:

```
getBars
history
bars
```

Não deve fazer chamadas adicionais por conta própria.

O adaptador deve aceitar:

```
[time, open, high, low, close, volume]
```

```
{
  time,
  open,
  high,
  low,
  close,
  volume
}
```

```
{
  t,
  o,
  h,
  l,
  c,
  v
}
```

Todos os formatos devem virar:

```
{
  symbol,
  timeframeSeconds,
  timestamp,
  open,
  high,
  low,
  close,
  volume,
  source: "history",
  closed: true
}
```

O histórico deve ser marcado como `closed: true`, exceto quando a plataforma indicar que o último item ainda está em formação.

## CandleStore robusto

A chave do armazenamento será:

```
symbol + timeframeSeconds
```

Exemplo:

```
Map {
  "EURUSD:60" => {
    candles: [...],
    lastReceivedAt: 1727010185123,
    lastServerTimestamp: 1727010180,
    status: "READY"
  }
}
```

Regra de atualização:

```
function ingest(candle) {
  const series = getSeries(candle.symbol, candle.timeframeSeconds);
  const last = series.last();

  if (!isValidCandle(candle)) {
    return "INVALID_DATA";
  }

  if (!last) {
    series.insert(candle);
    return "INITIALIZED";
  }

  if (candle.timestamp === last.timestamp) {
    if (candle.receivedAt >= last.receivedAt) {
      series.replaceLast(candle);
      return "UPDATED";
    }

    return "OUT_OF_ORDER";
  }

  if (candle.timestamp === last.timestamp + candle.timeframeSeconds) {
    last.closed = true;
    candle.closed = false;
    series.insert(candle);
    return "NEW_CANDLE";
  }

  if (candle.timestamp > last.timestamp) {
    series.markGap(last.timestamp, candle.timestamp);
    series.insert(candle);
    return "DATA_GAP";
  }

  return "OUT_OF_ORDER";
}
```

### Regra importante

Não basta comparar o timestamp. A extensão deve confirmar:

```
novo timestamp
+ intervalo esperado
+ dados históricos carregados
+ nenhuma lacuna
+ atraso aceitável
```

Só então o estado pode ser:

```
READY
```

## Validação dos candles

Cada candle deve passar por:

```
function isValidCandle(c) {
  return (
    Number.isFinite(c.timestamp) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    c.open > 0 &&
    c.high > 0 &&
    c.low > 0 &&
    c.close > 0 &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close)
  );
}
```

Também validar:

- timestamp em segundos;
- timestamp alinhado ao timeframe;
- símbolo ativo;
- resolução esperada;
- distância entre candles;
- preço congelado;
- duplicidade;
- atraso da mensagem.

## Máquina de estados

A extensão deve usar uma máquina de estados por ativo/timeframe:

```
BOOTING
  ↓
WAITING_FOR_FRAME
  ↓
CONNECTING
  ↓
SYNCING_HISTORY
  ↓
SYNCING_REALTIME
  ↓
READY
  ↓
CANDLE_UPDATING
  ↓
CANDLE_CLOSED
```

Estados de falha:

```
NO_DATA
STALE
DATA_GAP
INVALID_DATA
FORMAT_CHANGED
RECONNECTING
ERROR
```

### Permissão para sinal

A estratégia só pode executar quando:

```
state == READY
```

ou quando estiver processando:

```
CANDLE_CLOSED
```

Nunca gerar BUY/SELL em:

```
NO_DATA
STALE
DATA_GAP
INVALID_DATA
FORMAT_CHANGED
RECONNECTING
ERROR
```

## Sincronização histórico + tempo real

O sistema deve seguir esta sequência:

```
1. Detectar ativo e timeframe
2. Identificar conexão do gráfico
3. Receber histórico
4. Normalizar histórico
5. Carregar CandleStore
6. Verificar continuidade
7. Receber WebSocket
8. Encontrar o candle correspondente
9. Comparar valores
10. Confirmar sincronização
11. Liberar estratégia
```

O estado só passa para `READY` quando:

- existe histórico suficiente;
- o último candle histórico corresponde ao stream;
- não há gap;
- o timestamp está alinhado;
- o atraso está dentro do limite;
- o ativo não mudou;
- o timeframe não mudou.

## Indicadores

O motor de indicadores recebe somente:

```
closedCandles
```

Nunca deve receber o candle aberto para gerar o sinal.

Indicadores:

```
EMA 9
EMA 21
RSI 14
ATR 14 opcional
```

O resultado deve incluir metadados:

```
{
  candleTimestamp: 1727010180,
  emaFast: 1.08531,
  emaSlow: 1.08524,
  rsi: 56.8,
  atr: 0.00031,
  calculatedFromClosedCandles: true,
  candleCount: 120,
  strategyVersion: "ema-rsi-v1"
}
```

## Estratégia

Regra inicial:

```
BUY:
- EMA 9 anterior <= EMA 21 anterior
- EMA 9 atual > EMA 21 atual
- RSI atual > 50
- candle fechado
- estado READY
- nenhum gap
- dados não atrasados

SELL:
- EMA 9 anterior >= EMA 21 anterior
- EMA 9 atual < EMA 21 atual
- RSI atual < 50
- candle fechado
- estado READY
- nenhum gap
- dados não atrasados

WAIT:
- qualquer outra situação
```

Sinal:

```
{
  id: "uuid",
  action: "BUY",
  symbol: "EURUSD",
  timeframeSeconds: 60,
  candleTimestamp: 1727010180,
  price: 1.08542,
  strategy: "EMA9_EMA21_RSI14",
  strategyVersion: "1.0.0",
  reasons: [
    "EMA 9 cruzou acima da EMA 21",
    "RSI acima de 50",
    "Candle confirmado"
  ],
  dataStatus: "READY",
  latencyMs: 420,
  createdAt: 1727010185123
}
```

## Deduplicação

Chave:

```
const signalKey = [
  symbol,
  timeframeSeconds,
  candleTimestamp,
  strategyVersion
].join(":");
```

Antes de emitir:

```
if (emittedSignals.has(signalKey)) {
  return "DUPLICATE";
}
```

A chave deve ser persistida para evitar repetição depois de:

- reconexão;
- reload;
- reentrada no iframe;
- reprocessamento do histórico;
- reinício do navegador.

## Painel visual

O painel será criado somente na página principal:

```
┌─────────────────────────┐
│ ORACLE QUANT             │
│ AUDCHF_otc · 1m         │
│                         │
│        AGUARDAR         │
│ EMA9: —                 │
│ EMA21: —                │
│ RSI: —                  │
│ Dados: SINCRONIZANDO    │
│ Último dado: 0s         │
└─────────────────────────┘
```

O painel deve mostrar:

- ativo;
- timeframe;
- expiração configurada separadamente;
- estado;
- sinal;
- preço;
- EMA;
- RSI;
- timestamp do candle;
- idade do último dado;
- quantidade de candles;
- motivo;
- versão da estratégia.

### Regras do painel

- usar Shadow DOM;
- não alterar elementos da corretora;
- não se posicionar sobre BUY/SELL;
- ser arrastável;
- poder ser minimizado;
- recriar-se via `MutationObserver`;
- mudar para `STALE` quando os dados envelhecerem;
- esconder BUY/SELL se a qualidade não for suficiente.

## Persistência

### Memória

Manter em memória:

- candles recentes;
- indicadores;
- estado de conexão;
- sessão do iframe;
- sinais já emitidos na sessão.

### IndexedDB

Usar IndexedDB para:

```
candles fechados
signals
data_quality_events
connection_events
strategy_versions
```

### `chrome.storage.local`

Usar apenas para:

```
configurações
ativo selecionado
timeframe
estratégia
parâmetros
som habilitado
preferência do painel
```

O service worker pode ser encerrado quando fica inativo, portanto não deve conter o único estado da análise.[[developer.chrome](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)][[developer.chrome](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers)]

## Controle de sessões e abas

Cada aba deve ter:

```
{
  tabId,
  frameId,
  sessionId,
  symbol,
  timeframeSeconds,
  createdAt
}
```

Isso evita misturar:

```
AUDCHF_otc da aba 1
com
EURUSD da aba 2
```

A chave completa deve ser:

```
tabId + frameId + symbol + timeframeSeconds
```

Ao trocar o ativo:

```
1. invalidar sessão anterior
2. limpar listeners antigos
3. limpar timers
4. limpar subscription local
5. criar nova sessão
6. carregar histórico
7. sincronizar stream
8. liberar sinais
```

## Tratamento de reconexão

Ao perder o WebSocket:

```
CONNECTED
  ↓
STALE
  ↓
RECONNECTING
  ↓
SYNCING_HISTORY
  ↓
SYNCING_REALTIME
  ↓
READY
```

Durante `STALE` ou `RECONNECTING`:

```
não gerar BUY
não gerar SELL
não considerar o último preço como atual
```

Após reconectar:

- recarregar histórico pela página;
- verificar o último timestamp;
- reconciliar o candle atual;
- procurar gaps;
- recalcular indicadores;
- não repetir sinais antigos.

## Observabilidade

O painel técnico deve conter:

```
WebSocket: CONNECTED
Última mensagem: 420 ms atrás
Histórico: 120 candles
Candle atual: 10:52
Gaps: 0
Formato: candle_update/v1
Parser: ativo
Estratégia: ema-rsi-v1
Sinais emitidos: 14
Sinais duplicados: 3
```

Logs internos sem dados sensíveis:

```
{
  event: "DATA_GAP",
  symbol: "EURUSD",
  timeframeSeconds: 60,
  from: 1727010000,
  to: 1727010240,
  source: "websocket"
}
```

Nunca registrar:

```
token
JWT
Authorization
Cookie
URL completa com credenciais
payloads brutos em produção
```

## Estrutura final do projeto

```
oracle-quant/
├── manifest.json
├── src/
│   ├── main/
│   │   ├── websocket-observer.js
│   │   ├── http-observer.js
│   │   ├── frame-detector.js
│   │   └── sanitizer.js
│   ├── content/
│   │   ├── bridge.js
│   │   ├── analyzer.js
│   │   ├── session-manager.js
│   │   ├── signal-panel.js
│   │   └── panel.css
│   ├── market/
│   │   ├── message-classifier.js
│   │   ├── candle-normalizer.js
│   │   ├── candle-validator.js
│   │   ├── candle-store.js
│   │   ├── synchronizer.js
│   │   └── data-quality.js
│   ├── indicators/
│   │   ├── ema.js
│   │   ├── rsi.js
│   │   ├── atr.js
│   │   └── indicator-engine.js
│   ├── strategy/
│   │   ├── strategy-engine.js
│   │   ├── ema-rsi-strategy.js
│   │   └── signal-deduplicator.js
│   ├── storage/
│   │   ├── indexed-db.js
│   │   └── settings-store.js
│   ├── background/
│   │   ├── service-worker.js
│   │   └── notifications.js
│   └── popup/
│       ├── popup.html
│       ├── popup.js
│       └── popup.css
└── tests/
    ├── candle-normalizer.test.js
    ├── candle-store.test.js
    ├── synchronization.test.js
    ├── indicators.test.js
    ├── strategy.test.js
    └── deduplication.test.js
```

## Contratos internos

### Candle

```
type Candle = {
  symbol: string;
  timeframeSeconds: number;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  source: "history" | "websocket" | "aggregated";
  closed: boolean;
  receivedAt: number;
  serverTime?: number;
};
```

### Estado

```
type DataState =
  | "BOOTING"
  | "WAITING_FOR_FRAME"
  | "CONNECTING"
  | "SYNCING_HISTORY"
  | "SYNCING_REALTIME"
  | "READY"
  | "STALE"
  | "DATA_GAP"
  | "INVALID_DATA"
  | "FORMAT_CHANGED"
  | "RECONNECTING"
  | "ERROR";
```

### Sinal

```
type Signal = {
  id: string;
  action: "BUY" | "SELL" | "WAIT";
  symbol: string;
  timeframeSeconds: number;
  expirationSeconds?: number;
  candleTimestamp: number;
  price: number;
  strategy: string;
  strategyVersion: string;
  reasons: string[];
  dataState: DataState;
  latencyMs: number;
  createdAt: number;
};
```

## Ordem de implementação

### Fase 1: captura

- Manifest;
- injeção no frame;
- WebSocket observer;
- Fetch/XHR observer;
- sanitização;
- painel técnico;
- nenhuma estratégia.

### Fase 2: normalização

- parser de `candle_update`;
- parser de arrays OHLC;
- parser de objetos OHLC;
- validação;
- CandleStore;
- testes com mensagens gravadas.

### Fase 3: sincronização

- histórico;
- tempo real;
- detecção de gaps;
- reconexão;
- troca de ativo;
- troca de timeframe;
- estados `READY`, `STALE`, `DATA_GAP`.

### Fase 4: indicadores

- EMA 9;
- EMA 21;
- RSI 14;
- testes com sequência conhecida;
- validação somente em candles fechados.

### Fase 5: sinais

- estratégia EMA/RSI;
- deduplicação;
- painel BUY/SELL/WAIT;
- justificativas;
- registro de sinais.

### Fase 6: confiabilidade

- múltiplas abas;
- iframe recriado;
- WebSocket binário;
- mudança de bundle;
- navegador em segundo plano;
- reconexão;
- formato alterado;
- persistência.

### Fase 7: avaliação

- replay;
- métricas;
- latência;
- gaps;
- comparação OTC/não OTC;
- análise de sinais inválidos.

## Regra operacional central

A extensão deve obedecer a esta regra:

```
Sem histórico validado → sem sinal
Sem WebSocket ativo → sem sinal
Com atraso excessivo → sem sinal
Com gap → sem sinal
Com formato desconhecido → sem sinal
Com candle aberto → sem sinal
Com indicador insuficiente → sem sinal
```

O resultado correto nesses casos não é uma previsão forçada. É:

```
AGUARDAR
```

Essa arquitetura resolve os principais pontos frágeis porque:

- não depende de uma URL fixa;
- não depende apenas de um bundle;
- não mantém o estado no service worker;
- não calcula sobre candle aberto;
- não mistura ativos ou abas;
- não gera sinais durante reconexão;
- não salva credenciais;
- não executa ordens;
- não depende de `getBars` como função interna;
- trata histórico e tempo real como fontes diferentes;
- valida a sincronização antes de liberar a estratégia.