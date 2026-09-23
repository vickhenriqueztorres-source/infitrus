# AGENTES.md — Oracle Quant Signals

**Projeto:** Oracle Quant Signals  
**Versão:** 0.1.0  
**Data:** 22 de setembro de 2026  
**Idioma do projeto:** Português do Brasil  
**Status:** Documento de orientação para agentes de desenvolvimento

## 1. Propósito

Este documento orienta agentes de IA e desenvolvedores que trabalham no Oracle Quant Signals.

O projeto é uma extensão Chrome que observa dados de mercado exibidos pela plataforma B2Trading, normaliza candles, executa uma estratégia técnica local e exibe sinais de **COMPRA**, **VENDA** ou **AGUARDAR**.

A extensão é somente analítica.

## 2. Regra principal

> A extensão nunca executa ordens.

É proibido implementar qualquer funcionalidade que:

- clique em `#btnBuy`;
    
- clique em `#btnSell`;
    
- preencha `#amountInput`;
    
- chame `WebSocket.send()`;
    
- envie comandos para a corretora;
    
- repita requisições da plataforma;
    
- altere o comportamento da interface de negociação;
    
- contorne login, CAPTCHA, proteção ou autenticação.
    

A extensão apenas lê dados, processa informações localmente e exibe sinais.

## 3. Princípios obrigatórios

Todos os agentes devem seguir estes princípios:

1. Segurança em primeiro lugar.
    
2. Somente leitura.
    
3. Falhar com segurança.
    
4. Não gerar sinal com dados incompletos.
    
5. Processar sinais somente após o fechamento do candle.
    
6. Manter separação clara entre captura, dados, indicadores e interface.
    
7. Nunca armazenar credenciais.
    
8. Nunca confiar cegamente em dados da página.
    
9. Testar antes de alterar componentes críticos.
    
10. Preferir `AGUARDAR` ou `SEM DADOS` a um sinal inválido.
    

## 4. Domínios autorizados

A extensão deve funcionar somente nos domínios necessários:

text

`https://traderoom.b2trading.io/* https://chart.b2trading.io/* https://restapi.b2trading.io/*`

Não adicionar permissões para todos os sites.

Não adicionar domínios externos sem justificativa documentada.

## 5. Arquitetura obrigatória

text

`Página principal └── traderoom.b2trading.io     ├── painel de sinais    └── iframe chart.b2trading.io            │            ├── observador WebSocket            ├── observador Fetch/XHR            ├── histórico            └── atualizações em tempo real                    │                    ▼            normalizador de mensagens                    │                    ▼            validador de candles                    │                    ▼            CandleStore por ativo/timeframe                    │                    ▼            sincronizador                    │                    ▼            indicadores                    │                    ▼            estratégia                    │                    ▼            painel e notificações`

## 6. Responsabilidade dos contextos

## 6.1 MAIN world

O MAIN world observa objetos da aplicação da página.

Pode:

- observar WebSocket;
    
- observar Fetch;
    
- observar XMLHttpRequest;
    
- capturar mensagens recebidas;
    
- identificar candles e ticks;
    
- enviar eventos sanitizados.
    

Não pode:

- usar diretamente `chrome.storage`;
    
- acessar credenciais;
    
- chamar `socket.send()`;
    
- clicar em controles de negociação;
    
- fazer chamadas extras à plataforma;
    
- salvar payloads sensíveis.
    

## 6.2 Content script isolado

É o núcleo da análise por aba.

Responsável por:

- receber eventos do MAIN world;
    
- validar origem e schema;
    
- normalizar mensagens;
    
- manter o CandleStore;
    
- detectar gaps e atrasos;
    
- calcular indicadores;
    
- gerar sinais;
    
- atualizar o painel;
    
- controlar a máquina de estados.
    

O CandleStore e o motor de estratégia devem ficar no content script da aba ativa, não somente no service worker.

## 6.3 Service worker

O service worker deve ser leve e orientado a eventos.

Responsável por:

- notificações do Chrome;
    
- preferências;
    
- comunicação entre abas;
    
- persistência em lotes;
    
- exportação de histórico;
    
- eventos de instalação e atualização.
    

Não colocar no service worker:

- CandleStore principal;
    
- parsing contínuo;
    
- indicadores em tempo real;
    
- dependência de estado que não possa ser reconstruído.
    

## 7. Comunicação entre contextos

Fluxo obrigatório:

text

`MAIN world     ↓ window.postMessage bridge.js     ↓ chrome.runtime.sendMessage analyzer.js     ↓ CandleStore     ↓ strategy-engine.js     ↓ signal-panel.js`

Todo evento deve conter:

javascript

`{   type,  sessionId,  origin,  receivedAt,  payload }`

## Validação obrigatória

Rejeitar o evento se:

- `event.source !== window` quando aplicável;
    
- `event.origin` não for autorizado;
    
- `sessionId` não corresponder à sessão ativa;
    
- o payload for maior que o limite;
    
- o schema for inválido;
    
- o timestamp for impossível;
    
- houver OHLC inválido.
    

Não confiar somente em um campo `source` enviado pela página.

## 8. Captura de dados

## 8.1 WebSocket

A extensão pode observar a conexão relacionada a:

text

`wss://traderoom.b2trading.io/ws`

Mas não deve assumir que essa URL será permanente.

Identificar o feed por:

- mensagens recebidas;
    
- frequência de frames;
    
- presença de símbolo;
    
- presença de preço ou OHLC;
    
- comportamento ao trocar o ativo;
    
- comportamento ao trocar o timeframe.
    

## 8.2 Tipos aceitos

O parser deve aceitar:

- string JSON;
    
- JSON UTF-8;
    
- `ArrayBuffer` para diagnóstico;
    
- `Blob` para diagnóstico;
    
- respostas Fetch JSON;
    
- respostas XHR JSON.
    

Mensagens binárias desconhecidas não devem gerar sinal.

## 8.3 Histórico

Observar as respostas utilizadas pelo gráfico para histórico, sem repetir chamadas.

Possíveis fontes:

text

`history bars candles ohlc getBars`

O agente deve preferir observar respostas reais a chamar funções internas da Charting Library.

Não depender de nomes minificados como:

text

`index-CbtYGiFI.js:107`

## 9. Sanitização obrigatória

Antes de qualquer log, armazenamento ou exportação, remover ou mascarar:

text

`token access_token refresh_token jwt Authorization Bearer Cookie Set-Cookie password secret email JWTs iniciados por eyJ`

Valores esperados:

text

`[REDACTED_TOKEN] [REDACTED_AUTH] [REDACTED_COOKIE] [REDACTED_SECRET] [REDACTED_EMAIL] [REDACTED_JWT]`

Nunca salvar:

- URL completa contendo token;
    
- cabeçalho Authorization;
    
- cookie de sessão;
    
- senha;
    
- payload sensível;
    
- conteúdo de login.
    

## 10. Modelo de Candle

Usar um modelo único interno:

typescript

`type Candle = {   symbol: string;  timeframeSeconds: number;  timestamp: number;  open: number;  high: number;  low: number;  close: number;  volume?: number;  source: "history" | "websocket" | "aggregated";  closed: boolean;  receivedAt: number; };`

## Regras

- timestamps internos devem estar em segundos;
    
- timestamps em milissegundos devem ser convertidos;
    
- símbolo e timeframe são obrigatórios;
    
- OHLC deve ser numérico;
    
- preço deve ser positivo;
    
- timestamp deve ser alinhado ao timeframe;
    
- candle aberto não pode gerar sinal.
    

## 11. Validação de OHLC

Um candle só é válido se:

text

`open > 0 high > 0 low > 0 close > 0 high >= max(open, close) low <= min(open, close)`

Também verificar:

- timestamp plausível;
    
- resolução conhecida;
    
- símbolo ativo;
    
- ausência de valores `NaN`;
    
- ausência de `Infinity`;
    
- volume válido, quando presente.
    

Se a validação falhar:

text

`state = INVALID_DATA signal = AGUARDAR`

## 12. CandleStore

A série deve ser separada por:

text

`symbol + timeframeSeconds`

Exemplo:

text

`AUDCHF_otc:60 EURUSD:60 EURUSD:300`

## Comportamento

Mesmo timestamp:

text

`atualizar o candle existente`

Timestamp maior e contínuo:

text

`fechar o candle anterior e inserir o novo`

Timestamp menor:

text

`registrar OUT_OF_ORDER e não sobrescrever dados atuais`

Timestamp maior com lacuna:

text

`registrar DATA_GAP suspender sinais`

Não usar simplesmente:

javascript

`candles.push(candle)`

sem deduplicação por timestamp.

## 13. Sincronização

A extensão deve iniciar no estado:

text

`BOOTING`

Fluxo normal:

text

`BOOTING → WAITING_FOR_FRAME → CONNECTING → SYNCING_HISTORY → SYNCING_REALTIME → READY`

Fluxo de atualização:

text

`READY → CANDLE_UPDATING → CANDLE_CLOSED → READY`

Fluxo de erro:

text

`STALE DATA_GAP INVALID_DATA FORMAT_CHANGED RECONNECTING ERROR`

## Condições para READY

Só usar `READY` quando:

- histórico suficiente estiver carregado;
    
- ativo estiver identificado;
    
- timeframe estiver identificado;
    
- timestamp estiver alinhado;
    
- último candle histórico corresponder ao stream;
    
- não houver gap;
    
- atraso estiver dentro do limite;
    
- parser estiver reconhecendo mensagens.
    

## 14. Estados que bloqueiam sinais

Nunca gerar BUY ou SELL em:

text

`BOOTING WAITING_FOR_FRAME CONNECTING SYNCING_HISTORY SYNCING_REALTIME STALE DATA_GAP INVALID_DATA FORMAT_CHANGED RECONNECTING ERROR`

Resultado nesses estados:

text

`AGUARDAR`

ou:

text

`SEM DADOS`

## 15. Indicadores

Indicadores do MVP:

text

`EMA 9 EMA 21 RSI 14`

ATR 14 é opcional e não deve bloquear o MVP.

## Regras

- calcular apenas com candles fechados;
    
- exigir histórico mínimo;
    
- documentar o método matemático;
    
- manter indicadores por ativo/timeframe;
    
- incluir timestamp do candle usado;
    
- não misturar candle atual com série fechada.
    

## 16. Estratégia inicial

Nome:

text

`EMA9_EMA21_RSI14`

## Compra

Gerar `BUY` somente quando:

- EMA 9 anterior <= EMA 21 anterior;
    
- EMA 9 atual > EMA 21 atual;
    
- RSI atual > 50;
    
- candle fechado;
    
- estado `READY` ou `CANDLE_CLOSED`;
    
- sem gap;
    
- dados não estiverem atrasados;
    
- não houver sinal duplicado.
    

## Venda

Gerar `SELL` somente quando:

- EMA 9 anterior >= EMA 21 anterior;
    
- EMA 9 atual < EMA 21 atual;
    
- RSI atual < 50;
    
- candle fechado;
    
- estado `READY` ou `CANDLE_CLOSED`;
    
- sem gap;
    
- dados não estiverem atrasados;
    
- não houver sinal duplicado.
    

## Outros casos

text

`WAIT`

## 17. Sinais

Modelo:

typescript

`type Signal = {   id: string;  action: "BUY" | "SELL" | "WAIT";  symbol: string;  timeframeSeconds: number;  expirationSeconds?: number;  candleTimestamp: number;  price: number;  strategy: string;  strategyVersion: string;  reasons: string[];  dataState: string;  latencyMs: number;  createdAt: number; };`

Todo sinal deve conter:

- ativo;
    
- timeframe;
    
- timestamp;
    
- preço;
    
- estratégia;
    
- versão da estratégia;
    
- motivos;
    
- estado dos dados;
    
- latência;
    
- identificador único.
    

## 18. Deduplicação

Usar:

javascript

`const signalKey = [   symbol,  timeframeSeconds,  candleTimestamp,  strategyVersion ].join(":");`

Um mesmo `signalKey` só pode ser emitido uma vez.

A deduplicação deve sobreviver a:

- reconexão;
    
- reload;
    
- reentrada no iframe;
    
- reprocessamento do histórico;
    
- reinício do Chrome.
    

## 19. Ativos, abas e sessões

Nunca misturar dados entre abas ou frames.

A sessão deve conter:

javascript

`{   tabId,  frameId,  sessionId,  symbol,  timeframeSeconds,  createdAt }`

Chave completa:

text

`tabId + frameId + symbol + timeframeSeconds`

Ao trocar ativo ou timeframe:

1. invalidar sessão anterior;
    
2. remover listeners;
    
3. limpar timers;
    
4. limpar dados incompatíveis;
    
5. criar nova sessão;
    
6. carregar histórico;
    
7. sincronizar tempo real;
    
8. liberar sinais somente após `READY`.
    

## 20. Interface

O painel deve ser criado na página principal.

Requisitos:

- usar Shadow DOM;
    
- não modificar elementos da corretora;
    
- não cobrir BUY/SELL;
    
- permitir arrastar;
    
- permitir minimizar;
    
- usar `MutationObserver`;
    
- apresentar estado de dados;
    
- apresentar idade do último evento;
    
- apresentar motivo do sinal;
    
- apresentar ativo e timeframe;
    
- separar timeframe de expiração.
    

Estados visuais:

text

`BUY       verde SELL      vermelho WAIT      amarelo ou cinza STALE     laranja ERROR     vermelho escuro SYNCING   azul`

## 21. Notificações

Notificações são opcionais.

Canais permitidos:

- painel visual;
    
- som local;
    
- notificação Chrome.
    

Não enviar sinais para serviços externos no MVP.

Cada sinal pode gerar no máximo uma notificação por canal.

O áudio deve ter ativação explícita do usuário.

## 22. Persistência

## chrome.storage.local

Usar para:

- configuração;
    
- estratégia;
    
- parâmetros;
    
- timeframe;
    
- ativo selecionado;
    
- preferência de som;
    
- posição do painel.
    

## IndexedDB

Usar para:

- candles fechados;
    
- sinais;
    
- eventos de qualidade;
    
- eventos de conexão;
    
- versões de estratégia.
    

Não salvar cada tick bruto em `chrome.storage.local`.

## 23. Observabilidade

O painel técnico deve apresentar:

text

`WebSocket: CONNECTED Histórico: 120 candles Última mensagem: 420 ms Último candle: 10:52 Gaps: 0 Formato: candle_update/v1 Parser: ativo Estratégia: ema-rsi-v1 Sinais emitidos: 14 Duplicados bloqueados: 3`

Eventos internos:

javascript

`{   type: "DATA_GAP",  symbol: "EURUSD",  timeframeSeconds: 60,  from: 1727010000,  to: 1727010240 }`

## 24. Tratamento de reconexão

Ao perder conexão:

text

`READY → STALE → RECONNECTING → SYNCING_HISTORY → SYNCING_REALTIME → READY`

Durante a reconexão:

- suspender sinais;
    
- não confiar no último preço;
    
- não duplicar sinais antigos;
    
- reconciliar o último candle;
    
- verificar gaps;
    
- recalcular indicadores.
    

## 25. Desempenho

Regras:

- descartar heartbeat;
    
- não salvar payload bruto em produção;
    
- limitar candles em memória;
    
- atualizar o painel com throttle;
    
- calcular indicadores no fechamento;
    
- evitar recalcular todo histórico em cada tick;
    
- liberar listeners ao trocar de ativo;
    
- limpar timers e subscriptions.
    

## 26. Estrutura de diretórios

text

`oracle-quant/ ├── manifest.json ├── src/ │   ├── main/ │   │   ├── websocket-observer.js │   │   ├── http-observer.js │   │   ├── frame-detector.js │   │   └── sanitizer.js │   ├── content/ │   │   ├── bridge.js │   │   ├── analyzer.js │   │   ├── session-manager.js │   │   ├── signal-panel.js │   │   └── panel.css │   ├── market/ │   │   ├── message-classifier.js │   │   ├── candle-normalizer.js │   │   ├── candle-validator.js │   │   ├── candle-store.js │   │   ├── synchronizer.js │   │   └── data-quality.js │   ├── indicators/ │   │   ├── ema.js │   │   ├── rsi.js │   │   ├── atr.js │   │   └── indicator-engine.js │   ├── strategy/ │   │   ├── strategy-engine.js │   │   ├── ema-rsi-strategy.js │   │   └── signal-deduplicator.js │   ├── storage/ │   │   ├── indexed-db.js │   │   └── settings-store.js │   ├── background/ │   │   ├── service-worker.js │   │   └── notifications.js │   └── popup/ │       ├── popup.html │       ├── popup.js │       └── popup.css └── tests/     ├── candle-normalizer.test.js    ├── candle-store.test.js    ├── synchronization.test.js    ├── indicators.test.js    ├── strategy.test.js    └── deduplication.test.js`

## 27. Ordem de implementação

## Fase 1 — Captura

- Manifest;
    
- injeção na página e iframe;
    
- observador WebSocket;
    
- observador HTTP;
    
- sanitização;
    
- painel técnico;
    
- nenhuma estratégia.
    

## Fase 2 — Dados

- parser `candle_update`;
    
- parser do histórico;
    
- normalizador;
    
- validação;
    
- CandleStore;
    
- gaps;
    
- timestamps.
    

## Fase 3 — Sincronização

- histórico mais tempo real;
    
- reconexão;
    
- troca de ativo;
    
- troca de timeframe;
    
- estados de qualidade.
    

## Fase 4 — Indicadores

- EMA 9;
    
- EMA 21;
    
- RSI 14;
    
- testes numéricos;
    
- cálculo em candles fechados.
    

## Fase 5 — Sinais

- estratégia EMA/RSI;
    
- BUY/SELL/WAIT;
    
- deduplicação;
    
- justificativas;
    
- painel final.
    

## Fase 6 — Confiabilidade

- múltiplas abas;
    
- iframe recriado;
    
- alteração de formato;
    
- aba em segundo plano;
    
- service worker reiniciado;
    
- bundle atualizado.
    

## Fase 7 — Avaliação

- replay;
    
- métricas;
    
- latência;
    
- gaps;
    
- separação OTC/não OTC;
    
- análise sem execução.
    

## 28. Testes obrigatórios

Testar:

- reload da página;
    
- login manual;
    
- iframe recriado;
    
- troca de ativo;
    
- troca de timeframe;
    
- WebSocket ausente;
    
- WebSocket sem mensagens;
    
- reconexão;
    
- mensagem duplicada;
    
- mensagem fora de ordem;
    
- candle inválido;
    
- gap;
    
- histórico insuficiente;
    
- dados atrasados;
    
- aba em segundo plano;
    
- múltiplas abas;
    
- mudança de estratégia;
    
- atualização do bundle;
    
- token na URL;
    
- notificação duplicada;
    
- tentativa acidental de clique em BUY/SELL.
    

## 29. Critérios de pronto

Uma entrega só pode ser considerada pronta quando:

- não executa ordens;
    
- não chama `WebSocket.send()`;
    
- não clica em BUY/SELL;
    
- não salva credenciais;
    
- identifica o frame correto;
    
- captura histórico e tempo real;
    
- valida candles;
    
- detecta gaps;
    
- bloqueia sinais quando os dados estão inválidos;
    
- calcula somente após candle fechado;
    
- não duplica sinais;
    
- suporta reconexão;
    
- separa ativos, timeframes, abas e sessões;
    
- mostra o motivo de cada sinal;
    
- registra erros de maneira sanitizada.
    

## 30. Regra final para agentes

Antes de implementar qualquer mudança, o agente deve responder:

1. Esta mudança lê ou altera a plataforma?
    
2. Ela pode enviar uma ordem ou comando?
    
3. Ela pode expor credenciais?
    
4. Ela pode gerar sinal com dados incompletos?
    
5. Ela pode misturar ativo, timeframe, aba ou sessão?
    
6. Existe um teste para o caso alterado?
    
7. O comportamento em caso de erro será `AGUARDAR`?
    

Se qualquer resposta indicar risco, interromper a implementação e propor uma alternativa somente leitura.

O produto deve sempre preferir:

text

`SEM DADOS`

ou:

text

`AGUARDAR`

em vez de emitir um sinal não confiável.