# PRD — 

**Versão:** 0.1.0  
**Data:** 22 de setembro de 2026  
**Status:** Proposta para MVP  
**Tipo:** Extensão Chrome para análise de gráficos e geração de sinais

## 1. Visão do produto

 será uma extensão Chrome que observa os dados do gráfico da plataforma B2Trading, normaliza candles históricos e em tempo real, aplica uma estratégia técnica local e exibe sinais de **COMPRA**, **VENDA** ou **AGUARDAR** diretamente no navegador.

A extensão será estritamente analítica. Ela não abrirá operações, não clicará em BUY/SELL, não preencherá valores e não enviará comandos de negociação para a plataforma.

## 2. Objetivo

Criar um sistema local, observável e tolerante a falhas que:

- capture os dados do gráfico sem depender da leitura de pixels;
    
- use o histórico disponibilizado pela plataforma;
    
- acompanhe as atualizações em tempo real;
    
- normalize diferentes formatos de dados em candles padronizados;
    
- valide sincronização, timestamps, gaps e qualidade dos dados;
    
- execute indicadores e estratégia somente sobre candles confirmados;
    
- mostre sinais e justificativas na interface;
    
- registre sinais e eventos para avaliação posterior.
    

## 3. Não objetivos

O MVP não irá:

- executar ordens;
    
- clicar em BUY ou SELL;
    
- preencher o campo de valor;
    
- enviar mensagens pelo WebSocket;
    
- contornar autenticação, CAPTCHA ou proteções;
    
- armazenar tokens, cookies ou credenciais;
    
- fazer chamadas diretas desnecessárias à API da corretora;
    
- prometer ou garantir rentabilidade;
    
- substituir validação estatística ou avaliação humana.
    

## 4. Contexto técnico conhecido

A plataforma principal é:

text

`https://traderoom.b2trading.io/`

O gráfico é carregado em iframe por:

text

`https://chart.b2trading.io/`

Foi identificado o WebSocket:

text

`wss://traderoom.b2trading.io/ws`

Foram identificados recursos relacionados a histórico e gráfico:

text

`https://restapi.b2trading.io/api/v1/market/history https://chart.b2trading.io/charting_library/history https://restapi.b2trading.io/api/v1/bars`

O gráfico utiliza uma arquitetura compatível com TradingView Charting Library, incluindo conceitos de `getBars` para histórico e `subscribeBars` para atualizações em tempo real.

O formato de mensagem observado é JSON em texto UTF-8:

json

`{   "event": "candle_update",  "symbol": "EURUSD",  "resolution": "1",  "data": {    "time": 1727010180000,    "open": 1.08520,    "high": 1.08565,    "low": 1.08510,    "close": 1.08542,    "volume": 142.5  } }`

## 5. Usuários

## Usuária principal

Pessoa que acompanha gráficos na B2Trading e deseja receber sinais técnicos visuais no navegador sem automatizar operações.

## Necessidades

- saber quando uma condição técnica foi confirmada;
    
- compreender o motivo do sinal;
    
- visualizar se os dados estão sincronizados;
    
- evitar sinais baseados em dados atrasados ou incompletos;
    
- revisar sinais anteriores;
    
- testar estratégias sem executar ordens.
    

## 6. Princípios do produto

1. **Somente leitura:** a extensão não modifica a operação da corretora.
    
2. **Dados antes da estratégia:** nenhum sinal antes da validação do feed.
    
3. **Candle fechado:** sinais somente com informação confirmada.
    
4. **Falhar com segurança:** em caso de dúvida, mostrar AGUARDAR.
    
5. **Observabilidade:** o estado da conexão e a qualidade do dado precisam ser visíveis.
    
6. **Privacidade:** nunca salvar tokens, cookies, senhas ou payloads sensíveis.
    
7. **Independência:** o motor de estratégia não deve depender de funções internas minificadas da plataforma.
    
8. **Rastreabilidade:** todo sinal deve ter timestamp, candle, estratégia e justificativas.
    

## 7. Arquitetura do produto

text

`Chrome └── traderoom.b2trading.io     ├── página principal    │   └── painel de sinais    │    └── iframe chart.b2trading.io        ├── observador WebSocket        ├── observador Fetch/XHR        ├── histórico getBars        └── atualizações subscribeBars              │              ▼       Normalizador de mensagens              │              ▼        Validador de dados              │              ▼        CandleStore por ativo/timeframe              │              ▼       Sincronizador histórico/tempo real              │              ▼       Indicadores EMA/RSI/ATR              │              ▼        Motor de estratégia              │              ▼      BUY / SELL / WAIT / NO DATA              │              ├── painel visual              ├── som/notificação              └── histórico local`

## 7.1 Contexto MAIN

Responsabilidades:

- observar WebSocket;
    
- observar Fetch/XHR;
    
- capturar dados do documento da plataforma;
    
- identificar candles e ticks;
    
- sanitizar dados;
    
- enviar eventos para o content script.
    

Restrições:

- não chamar `WebSocket.send()`;
    
- não clicar na interface da corretora;
    
- não acessar APIs da extensão;
    
- não armazenar credenciais;
    
- não enviar requisições adicionais.
    

## 7.2 Content script isolado

Responsabilidades:

- validar eventos recebidos;
    
- normalizar dados;
    
- manter o estado de análise da aba;
    
- manter CandleStore;
    
- calcular indicadores;
    
- gerar sinais;
    
- renderizar o painel;
    
- controlar a máquina de estados.
    

## 7.3 Service worker

Responsabilidades:

- enviar notificações do Chrome;
    
- manter configurações;
    
- coordenar comunicação entre abas;
    
- persistir dados em lotes;
    
- iniciar exportações.
    

O service worker não será responsável pelo processamento contínuo dos candles, pois pode ser encerrado pelo navegador.

## 8. Funcionalidades do MVP

## F-001 — Captura passiva de WebSocket

A extensão deverá observar conexões WebSocket usadas pela plataforma.

Critérios de aceite:

- identifica conexões no documento principal e no iframe;
    
- registra abertura, fechamento, erro e mensagens recebidas;
    
- suporta mensagens de texto;
    
- não envia nenhum frame;
    
- remove tokens da URL antes de qualquer log;
    
- indica quando a conexão está ativa, inativa ou sem dados.
    

## F-002 — Captura passiva de histórico

A extensão deverá observar respostas de histórico e barras usadas pelo gráfico.

Critérios de aceite:

- identifica respostas relacionadas a `history`, `bars`, `candle`, `ohlc` ou `getBars`;
    
- aceita arrays OHLC;
    
- aceita objetos OHLC;
    
- não faz chamadas extras para buscar os dados;
    
- registra formato e fonte da resposta;
    
- não salva cabeçalhos ou credenciais.
    

## F-003 — Normalização de candles

Todos os dados externos deverão ser convertidos para um modelo interno único.

Modelo:

typescript

`type Candle = {   symbol: string;  timeframeSeconds: number;  timestamp: number;  open: number;  high: number;  low: number;  close: number;  volume?: number;  source: "history" | "websocket" | "aggregated";  closed: boolean;  receivedAt: number; };`

Critérios de aceite:

- converte timestamps em milissegundos para segundos;
    
- reconhece resolução `"1"` como 60 segundos;
    
- valida OHLC;
    
- rejeita dados incompletos;
    
- marca a origem do candle;
    
- registra mensagens desconhecidas sem gerar sinal.
    

## F-004 — CandleStore

O sistema deverá manter séries separadas por ativo e timeframe.

Critérios de aceite:

- não duplica o mesmo timestamp;
    
- atualiza o candle aberto;
    
- insere um novo candle quando o timestamp muda;
    
- detecta mensagens fora de ordem;
    
- detecta gaps;
    
- limita a memória utilizada;
    
- permite recuperar os últimos candles fechados.
    

## F-005 — Sincronização

O sistema deverá sincronizar histórico e tempo real antes de liberar sinais.

Critérios de aceite:

- carrega histórico suficiente;
    
- identifica o último candle histórico;
    
- compara histórico e WebSocket;
    
- detecta diferença de timestamp ou preço;
    
- suspende sinais durante sincronização;
    
- libera o estado `READY` somente após validação.
    

## F-006 — Indicadores

O MVP deverá calcular:

- EMA 9;
    
- EMA 21;
    
- RSI 14.
    

ATR 14 será opcional após a primeira validação.

Critérios de aceite:

- indicadores usam apenas candles fechados;
    
- existe quantidade mínima de dados;
    
- o método de cálculo é documentado;
    
- valores ficam associados ao timestamp do candle;
    
- indicadores não são calculados em estado inválido.
    

## F-007 — Estratégia inicial

Estratégia: `EMA9_EMA21_RSI14`.

Compra quando:

- EMA 9 anterior é menor ou igual à EMA 21 anterior;
    
- EMA 9 atual é maior que EMA 21 atual;
    
- RSI atual é maior que 50;
    
- o candle está fechado;
    
- o estado é `READY` ou `CANDLE_CLOSED`;
    
- não existe gap;
    
- o sinal ainda não foi emitido para aquele candle.
    

Venda quando:

- EMA 9 anterior é maior ou igual à EMA 21 anterior;
    
- EMA 9 atual é menor que EMA 21 atual;
    
- RSI atual é menor que 50;
    
- o candle está fechado;
    
- o estado é `READY` ou `CANDLE_CLOSED`;
    
- não existe gap;
    
- o sinal ainda não foi emitido para aquele candle.
    

Nos demais casos, o resultado será `WAIT`.

## F-008 — Deduplicação

A chave do sinal será:

text

`symbol + timeframeSeconds + candleTimestamp + strategyVersion`

Critérios de aceite:

- o mesmo candle nunca produz dois sinais iguais;
    
- reconexões não repetem sinais antigos;
    
- reload não repete sinais persistidos;
    
- troca de ativo cria uma nova sessão;
    
- mudança de estratégia cria uma nova versão.
    

## F-009 — Painel de sinais

O painel deverá aparecer na página principal, sem cobrir os controles de ordem.

Exemplo:

text

`┌─────────────────────────┐ │ ORACLE QUANT             │ │ AUDCHF_otc · 1m         │ │                         │ │        AGUARDAR         │ │ EMA9: —                 │ │ EMA21: —                │ │ RSI: —                  │ │ Dados: SINCRONIZANDO    │ │ Último dado: 0s         │ └─────────────────────────┘`

Critérios de aceite:

- mostra ativo;
    
- mostra timeframe;
    
- mostra sinal;
    
- mostra preço;
    
- mostra timestamp;
    
- mostra justificativas;
    
- mostra estado da conexão;
    
- mostra idade do último dado;
    
- pode ser minimizado;
    
- pode ser arrastado;
    
- é recriado caso a página remova o elemento;
    
- não altera elementos da corretora.
    

## F-010 — Notificações

O sistema poderá emitir:

- som local;
    
- notificação do Chrome;
    
- destaque visual.
    

Critérios de aceite:

- notificações podem ser desativadas;
    
- um sinal gera no máximo uma notificação por canal;
    
- sinais atrasados não geram alerta;
    
- há fallback visual caso o áudio seja bloqueado.
    

## F-011 — Persistência

Salvar em `chrome.storage.local`:

- configuração da estratégia;
    
- ativo selecionado;
    
- timeframe;
    
- expiração de referência;
    
- preferência de som;
    
- posição do painel.
    

Salvar em IndexedDB:

- candles fechados;
    
- sinais;
    
- eventos de qualidade;
    
- eventos de conexão.
    

Não salvar:

- tokens;
    
- JWTs;
    
- cookies;
    
- Authorization;
    
- senhas;
    
- payloads brutos em produção.
    

## 9. Estados do sistema

text

`BOOTING WAITING_FOR_FRAME CONNECTING SYNCING_HISTORY SYNCING_REALTIME READY CANDLE_UPDATING CANDLE_CLOSED STALE DATA_GAP INVALID_DATA FORMAT_CHANGED RECONNECTING ERROR`

Sinais BUY/SELL só poderão ser gerados em:

text

`READY CANDLE_CLOSED`

Nunca gerar sinais em:

text

`STALE DATA_GAP INVALID_DATA FORMAT_CHANGED RECONNECTING ERROR`

## 10. Modelo de sinal

typescript

`type Signal = {   id: string;  action: "BUY" | "SELL" | "WAIT";  symbol: string;  timeframeSeconds: number;  expirationSeconds?: number;  candleTimestamp: number;  price: number;  strategy: string;  strategyVersion: string;  reasons: string[];  dataState: string;  latencyMs: number;  createdAt: number; };`

Exemplo:

json

`{   "id": "signal-uuid",  "action": "BUY",  "symbol": "AUDCHF_otc",  "timeframeSeconds": 60,  "candleTimestamp": 1727010180,  "price": 1.08542,  "strategy": "EMA9_EMA21_RSI14",  "strategyVersion": "1.0.0",  "reasons": [    "EMA 9 cruzou acima da EMA 21",    "RSI acima de 50",    "Candle confirmado"  ],  "dataState": "READY",  "latencyMs": 420 }`

## 11. Máquina de sincronização

text

`BOOTING   ↓ WAITING_FOR_FRAME   ↓ CONNECTING   ↓ SYNCING_HISTORY   ↓ SYNCING_REALTIME   ↓ READY   ↓ CANDLE_UPDATING   ↓ CANDLE_CLOSED`

Em caso de falha:

text

`STALE DATA_GAP INVALID_DATA FORMAT_CHANGED RECONNECTING ERROR`

Ao reconectar:

1. suspender sinais;
    
2. recarregar ou observar novo histórico;
    
3. reconciliar o último candle;
    
4. detectar gaps;
    
5. recalcular indicadores;
    
6. liberar novamente o estado `READY`.
    

## 12. Segurança e privacidade

A extensão deverá:

- solicitar apenas permissões dos domínios necessários;
    
- mascarar tokens antes de logs;
    
- validar `event.origin`;
    
- validar schema dos eventos;
    
- usar identificador de sessão aleatório;
    
- limitar tamanho de mensagens;
    
- rejeitar eventos falsificados;
    
- não usar proxy externo;
    
- não executar comandos de negociação;
    
- não contornar autenticação.
    

A extensão deverá verificar os termos de uso da plataforma antes de distribuição ou uso continuado.

## 13. Estrutura do projeto

text

`oracle-quant/ ├── manifest.json ├── src/ │   ├── main/ │   │   ├── websocket-observer.js │   │   ├── http-observer.js │   │   ├── frame-detector.js │   │   └── sanitizer.js │   ├── content/ │   │   ├── bridge.js │   │   ├── analyzer.js │   │   ├── session-manager.js │   │   ├── signal-panel.js │   │   └── panel.css │   ├── market/ │   │   ├── message-classifier.js │   │   ├── candle-normalizer.js │   │   ├── candle-validator.js │   │   ├── candle-store.js │   │   ├── synchronizer.js │   │   └── data-quality.js │   ├── indicators/ │   │   ├── ema.js │   │   ├── rsi.js │   │   ├── atr.js │   │   └── indicator-engine.js │   ├── strategy/ │   │   ├── strategy-engine.js │   │   ├── ema-rsi-strategy.js │   │   └── signal-deduplicator.js │   ├── storage/ │   │   ├── indexed-db.js │   │   └── settings-store.js │   ├── background/ │   │   ├── service-worker.js │   │   └── notifications.js │   └── popup/ │       ├── popup.html │       ├── popup.js │       └── popup.css └── tests/     ├── candle-normalizer.test.js    ├── candle-store.test.js    ├── synchronization.test.js    ├── indicators.test.js    ├── strategy.test.js    └── deduplication.test.js`

## 14. Fases de desenvolvimento

## Fase 1 — Observabilidade

Entregas:

- Manifest V3;
    
- injeção na página e iframe;
    
- captura WebSocket;
    
- captura Fetch/XHR;
    
- sanitização;
    
- painel técnico;
    
- nenhuma estratégia.
    

Pronto quando:

- a conexão aparece;
    
- mensagens são identificadas;
    
- tokens não aparecem nos logs;
    
- o ativo e timeframe são detectados.
    

## Fase 2 — Dados de mercado

Entregas:

- parser `candle_update`;
    
- parser de histórico;
    
- normalizador;
    
- CandleStore;
    
- validação OHLC;
    
- detecção de gaps.
    

Pronto quando:

- histórico e tempo real são conciliados;
    
- o último candle é atualizado sem duplicação;
    
- candle fechado é identificado corretamente.
    

## Fase 3 — Indicadores

Entregas:

- EMA 9;
    
- EMA 21;
    
- RSI 14;
    
- testes numéricos;
    
- aquecimento mínimo.
    

Pronto quando:

- os indicadores são calculados somente em candles fechados;
    
- resultados são reproduzíveis;
    
- não há cálculo em estado inválido.
    

## Fase 4 — Sinais

Entregas:

- estratégia EMA/RSI;
    
- BUY/SELL/WAIT;
    
- deduplicação;
    
- justificativas;
    
- painel final.
    

Pronto quando:

- um candle produz no máximo um sinal;
    
- reconexão não duplica sinais;
    
- sinais inválidos são bloqueados.
    

## Fase 5 — Confiabilidade

Entregas:

- reconexão;
    
- troca de ativo;
    
- troca de timeframe;
    
- iframe recriado;
    
- múltiplas abas;
    
- formato alterado;
    
- aba em segundo plano;
    
- persistência.
    

## Fase 6 — Avaliação

Entregas:

- replay local;
    
- histórico de sinais;
    
- métricas;
    
- análise de latência;
    
- separação OTC/não OTC;
    
- avaliação sem execução de ordens.
    

## 15. Critérios de aceitação do MVP

O MVP será considerado aprovado quando:

- abrir na página correta;
    
- funcionar com login manual;
    
- detectar o iframe do gráfico;
    
- capturar candles sem chamar `send()`;
    
- normalizar histórico e tempo real;
    
- validar OHLC;
    
- detectar candle fechado;
    
- bloquear sinais durante `STALE`, `DATA_GAP` e `RECONNECTING`;
    
- calcular EMA 9, EMA 21 e RSI 14;
    
- exibir BUY, SELL ou WAIT com justificativa;
    
- não repetir sinal no mesmo candle;
    
- sobreviver a uma reconexão;
    
- sobreviver à troca de ativo;
    
- não clicar ou alterar BUY/SELL;
    
- não salvar tokens ou cookies;
    
- registrar eventos de erro de forma sanitizada.
    

## 16. Testes obrigatórios

- página recarregada;
    
- iframe recriado;
    
- ativo alterado;
    
- timeframe alterado;
    
- conexão perdida;
    
- conexão recuperada;
    
- frame duplicado;
    
- frame fora de ordem;
    
- candle inválido;
    
- gap de candles;
    
- histórico insuficiente;
    
- aba em segundo plano;
    
- múltiplas abas;
    
- mudança de estratégia;
    
- atualização do bundle;
    
- WebSocket sem dados;
    
- mensagem binária inesperada;
    
- token presente na URL;
    
- notificação duplicada.
    

## 17. Riscos residuais

Mesmo com essa arquitetura, permanecem riscos:

- a plataforma pode alterar o protocolo;
    
- o feed pode ficar indisponível;
    
- o ativo OTC pode ter comportamento próprio da corretora;
    
- o preço do sinal pode divergir do preço observado no momento de uma operação manual;
    
- indicadores podem produzir sinais falsos;
    
- uma extensão pode ser restringida pelos termos da plataforma;
    
- desempenho passado não garante resultado futuro.
    

O comportamento seguro diante de qualquer incerteza será mostrar:

text

`AGUARDAR`

ou:

text

`SEM DADOS`

## 18. Próximo passo técnico

Implementar a Fase 1 com quatro entregas mínimas:

1. `manifest.json` com os dois domínios;
    
2. observador passivo de WebSocket no iframe;
    
3. bridge com validação de origem e sanitização;
    
4. painel técnico exibindo conexão, ativo, timeframe e último evento.
    

Ainda não implementar indicadores ou sinais até confirmar que o histórico, o WebSocket e o fechamento dos candles estão sincronizados.