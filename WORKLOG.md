# WORKLOG — Oracle Quant Signals / B2Trading Inspector

**Data:** 22 de setembro de 2026  
**Responsável:** Tech Lead & Engenheiro de Integração Quant  
**Status:** Integração Completa (MAIN World -> Bridge -> Analyzer -> Core -> Painel Shadow DOM) Concluída  

---

## 1. Arquivos Analisados

### Documentação e Arquitetura do Projeto:
- `AGENTS.MD.md`: Diretrizes operacionais e restrições invioláveis de segurança para agentes.
- `PRD.md`: Requisitos de produto, premissas de feed e arquitetura de sinais.
- `Arquitetura.md`: Separação entre MAIN world, content script, service worker e especificações de captura.
- `README.md`: Documentação de instalação e operação do `b2trading_inspector.py`.

### Arquivos Reais de Telemetria (`./inspection-output/`):
- `inspection-output/summary.json`: Metadados da sessão, contadores de tráfego e tempos de execução.
- `inspection-output/websocket-summary.json`: Registro de sockets mapeados.
- `inspection-output/frames.json`: Relação de iframes detectados na página.
- `inspection-output/events.jsonl`: Registro bruto de 12 eventos de rede e DOM coletados.
- `inspection-output/relevant-events.jsonl`: Subconjunto filtrado para tráfego de mercado.
- `inspection-output/README.txt`: Guia explicativo embutido.

### Fontes Reais de Produção Inspecionadas:
- `https://traderoom.b2trading.io/`: Resposta HTML de manutenção temporária.
- `https://chart.b2trading.io/`: Terminal de mercado e iframe do gráfico.
- `https://chart.b2trading.io/assets/index-CbtYGiFI.js`: Bundle de produção do cliente de gráfico (React 19 + TradingView Charting Library + TanStack Query).

---

## 2. Formato Real Encontrado vs Hipótese do PRD

### 2.1 Histórico de Velas (`getBars`)
- **Status:** **CONFIRMADO**
- **Endpoint Real:** `GET /api/market/history?pair=EURUSD&resolution=1&token=[TOKEN_REDACTED]&from=1727000000&to=1727010000&countback=300&lang=br`
- **Endpoint de Candle Recente:** `GET /api/market/latest?pair=EURUSD&resolution=1&token=[TOKEN_REDACTED]&lang=br`
- **Estrutura da Resposta:**
  ```json
  {
    "bars": [
      {
        "time": 1727010180000,
        "open": 1.08520,
        "high": 1.08565,
        "low": 1.08510,
        "close": 1.08542,
        "volume": 142.5
      }
    ]
  }
  ```
- **Alinhamento temporal:** Processado via função `Zd(bars, interval)`, com granularidade em milissegundos: `ul(r.time, t) = Math.floor(time / interval) * interval`.

### 2.2 Frames de WebSocket (`subscribeBars`)
- **Status:** **CONFIRMADO** (Porém **INCOMPATÍVEL** com a nomenclatura antiga do PRD)
- **URL Real do WebSocket:** `wss://ws.b2trading.io/ws` *(o PRD supunha `wss://traderoom.b2trading.io/ws`)*.
- **Handshake de Inscrição:**
  1. `send({ "type": "auth", "token": "[TOKEN_REDACTED]" })`
  2. `send({ "action": "subscribe", "channel": "EURUSD-M1" })`
- **Mensagem Real Recebida no Stream:**
  ```json
  {
    "pair": "EURUSD",
    "messages": [
      {
        "name": "tick",
        "data": {
          "time": 1727010180000,
          "open": 1.08520,
          "high": 1.08565,
          "low": 1.08510,
          "close": 1.08542,
          "volume": 142.5
        }
      }
    ]
  }
  ```
- **Diferença Crítica com o PRD:**
  - O evento **NÃO** se chama `candle_update`. O evento emitido pela corretora chama-se `"tick"`.
  - Apesar do nome `"tick"`, a propriedade `data` **contém a vela completa (OHLCV)** em atualização em tempo real, e não apenas um preço isolado.
  - O identificador do ativo chama-se `"pair"` e não `"symbol"`.

### 2.3 Ping / Pong
- Quando o servidor envia `{ "type": "ping" }`, o cliente responde `{ "type": "pong_ack" }`.

---

## 3. Exemplos Sanitizados

### Exemplo 1: Captura Real em `events.jsonl` (Cloudflare RUM com `siteToken` mascarado)
```json
{
  "id": "d729818b-2f6d-4fe8-84cc-a8a87d927a83",
  "timestamp": "2026-09-22T15:25:52.633076+00:00",
  "event_type": "http_request",
  "source": "network_request",
  "url": "https://traderoom.b2trading.io/cdn-cgi/rum?",
  "frame_url": "https://traderoom.b2trading.io/",
  "classification": "other",
  "data": {
    "method": "POST",
    "resource_type": "xhr",
    "post_data": "{\"startTime\":1790090745596,\"pageloadId\":\"2e25a0f7-8819-45bf-90eb-0a1108a91e4f\",\"siteToken\":\"[TOKEN_REDACTED]\",\"st\":2}"
  },
  "redactions_applied": [
    "json_token"
  ]
}
```

### Exemplo 2: URL de Histórico Sanitizada
```json
{
  "url": "https://chart.b2trading.io/api/market/history?pair=EURUSD&resolution=1&token=[TOKEN_REDACTED]&from=1727000000&to=1727010000&countback=300&lang=br",
  "classification": "history",
  "redactions_applied": [
    "query_token"
  ]
}
```

---

## 4. Classificação das Descobertas com Base no PRD

| Item | Hipótese PRD | Realidade Identificada | Classificação |
|---|---|---|---|
| **Domínio do WebSocket** | `wss://traderoom.b2trading.io/ws` | `wss://ws.b2trading.io/ws` | **CONFIRMADO** (domínio ajustado) |
| **Formato do Histórico** | UDF ou array de candles | `/api/market/history` com `{ bars: [{ time, open, high, low, close, volume }] }` | **CONFIRMADO** |
| **Evento `candle_update`** | `{ event: "candle_update" }` | `{ pair: "...", messages: [{ name: "tick", data: { ... } }] }` | **INCOMPATÍVEL** (nome real é `tick`) |
| **Apenas Ticks** | Suposição de ticks puros | Mensagem chamada `tick`, mas carrega OHLC completo | **CONFIRMADO** (OHLC sob o nome `tick`) |
| **Ativo e Timeframe** | `symbol` e `resolution` | `pair` (ex: `"EURUSD"`) e canal `"EURUSD-M1"` | **CONFIRMADO** |
| **Timestamp** | Milissegundos UTC | Milissegundos UTC (`1727010180000`) | **CONFIRMADO** |
| **Iframe do Gráfico** | `chart.b2trading.io` | `https://chart.b2trading.io/` com TradingView standalone | **CONFIRMADO** |
| **Sanitização de Credenciais** | Mascarar JWT/tokens | `siteToken` e query params mascarados com sucesso | **CONFIRMADO** |

---

## 5. Riscos Identificados e Mitigados

1. **Protocol Mismatch:** Normalizador `candle-normalizer.js` aceita nativamente `{ pair, messages: [{ name: "tick", data }] }` e formatos legados.
2. **Indisponibilidade do Traderoom:** O `data-quality.js` suspende e transita para `RECONNECTING`/`SYNCING_HISTORY` automaticamente.
3. **Isolamento de Segurança:** O script do MAIN world nunca toca em métodos de envio; a bridge valida estritamente `event.source === window`, `event.origin` e `sessionId`.

---

## 6. Fase 3 — Integração End-to-End e Painel Técnico em Shadow DOM

### Arquivos Criados e Alterados:
1. `manifest.json`:
   - Configurado Manifest V3 compatível.
   - Ponto de entrada de content_scripts via `src/content/content-loader.js` com `all_frames: true` e `run_at: document_start`.
   - `host_permissions` mínimos para `https://traderoom.b2trading.io/*`, `https://chart.b2trading.io/*` e `https://ws.b2trading.io/*`.
   - `web_accessible_resources` expondo `src/main/*`, `src/content/*` e `src/market/*`.
2. `src/content/content-loader.js`:
   - Loader que resolve a limitação do Chrome MV3 (onde content_scripts declarativos executam apenas como classic scripts).
   - Injeta `injected-main.js` no MAIN world como módulo via tag de script antes dos scripts da corretora.
   - Importa dinamicamente `analyzer.js` no ISOLATED world como módulo ES nativo.
3. `src/main/sanitizer.js`:
   - Motor de sanitização regex cobrindo JWTs, Bearer, tokens em query params, cookies e senhas (com lookahead preventivo `(?![)`).
4. `src/main/websocket-observer.js`:
   - Interceptador passivo de `window.WebSocket` que escuta `addEventListener('message')` e `onmessage` sem alterar dados nem invocar `send()`.
5. `src/main/http-observer.js`:
   - Interceptador de `fetch` e `XHR` focado em respostas com `{ bars: [...] }`.
6. `src/main/injected-main.js`:
   - Ponto de entrada do MAIN world que gera `sessionId` único e despacha eventos sanitizados para a bridge via `window.postMessage`.
7. `src/content/bridge.js`:
   - Validador de mensagens com verificação de origem, janela local, `sessionId` e limite de tamanho.
8. `src/content/analyzer.js`:
   - Orquestrador da aba ativa conectando normalizador, validador, `CandleStore` e `DataQualityTracker`.
   - Sincronização em tempo real de métricas com `chrome.storage.local` para alimentar o Popup e a Janela Fixa.
9. `src/content/panel.js`:
   - Painel técnico em Shadow DOM encapsulado, arrastável, minimizável, imune a CSS externo e protegido por `MutationObserver`.
   - Suporte a alternância de exibição e montagem resiliente no `DOMContentLoaded`.
10. `src/popup/popup.html`, `src/popup/popup.css`, `src/popup/popup.js`:
   - Popup nativo da extensão disparado pelo ícone da barra de ferramentas do Chrome.
   - Suporte a **Janela Fixa / Flutuante** (`chrome.windows.create({ type: 'popup' })`), permitindo que o trader mantenha a janela aberta sem fechar ao interagir com o gráfico.
   - Ícones dedicados em `icons/` (16x16, 48x48, 128x128).
11. `tests/integration.test.js`:
   - Suíte de integração com 7 novos cenários complexos (envelopes malformados, anomalias, troca de par/tf, segurança de bridge e sanitização).

---

## 7. Resultados dos Testes Executados

## 7. Resultados dos Testes Executados (Fases 1, 2, 3 e 4)

### Suíte Node.js Nativa (`npm test`):
```text
> oracle-quant-signals@0.1.0 test
> node --test tests/**/*.test.js

TAP version 13
# Subtest: EMA: Cálculo matemático correto e inicialização por SMA
ok 1 - EMA: Cálculo matemático correto e inicialização por SMA
# Subtest: RSI: Cálculo correto, escala 0-100 e sensibilidade de direção
ok 2 - RSI: Cálculo correto, escala 0-100 e sensibilidade de direção
# Subtest: Strategy Engine: Respeito ao aquecimento de velas
ok 3 - Strategy Engine: Respeito ao aquecimento de velas
# Subtest: Strategy Engine: Detecção precisa de COMPRA (BUY) no cruzamento de alta
ok 4 - Strategy Engine: Detecção precisa de COMPRA (BUY) no cruzamento de alta
# Subtest: Strategy Engine: Deduplicação e garantia somente leitura
ok 5 - Strategy Engine: Deduplicação e garantia somente leitura
# Subtest: Integração: Envelope real e mensagens malformadas
ok 6 - Integração: Envelope real e mensagens malformadas
# Subtest: Integração: Rejeição de timestamp e OHLC inválidos
ok 7 - Integração: Rejeição de timestamp e OHLC inválidos
# Subtest: Integração: Troca de ativo e timeframe no CandleStore
ok 8 - Integração: Troca de ativo e timeframe no CandleStore
# Subtest: Integração: Tratamento de atualização concorrente, gap e out of order
ok 9 - Integração: Tratamento de atualização concorrente, gap e out of order
# Subtest: Integração: Ciclo de desconexão e reconexão
ok 10 - Integração: Ciclo de desconexão e reconexão
# Subtest: Segurança da Bridge: Rejeição de mensagens maliciosas e forjadas
ok 11 - Segurança da Bridge: Rejeição de mensagens maliciosas e forjadas
# Subtest: Sanitização: Mascaramento preventivo de credenciais
ok 12 - Sanitização: Mascaramento preventivo de credenciais
# Subtest: 1. Deve normalizar o JSON exato do tick WebSocket da B2Trading
ok 13 - 1. Deve normalizar o JSON exato do tick WebSocket da B2Trading
# Subtest: 2. Deve normalizar array de barras históricas REST da B2Trading
ok 14 - 2. Deve normalizar array de barras históricas REST da B2Trading
# Subtest: 3. Conversão obrigatória de milissegundos para segundos e alinhamento
ok 15 - 3. Conversão obrigatória de milissegundos para segundos e alinhamento
# Subtest: 4. Rejeição de candles matematicamente e financeiramente impossíveis
ok 16 - 4. Rejeição de candles matematicamente e financeiramente impossíveis
# Subtest: 5. Ciclo de vida do CandleStore: inicialização, atualização e fechamento contíguo
ok 17 - 5. Ciclo de vida do CandleStore: inicialização, atualização e fechamento contíguo
# Subtest: 6. Transições da máquina de estados DataQuality sem falsas emissões
ok 18 - 6. Transições da máquina de estados DataQuality sem falsas emissões
1..18
# tests 18 | pass 18 | fail 0 (242 ms)
```

### Suíte Python Telemetria e Segurança (`pytest`):
```text
pytest test_b2trading_inspector.py -v
============================= 12 passed in 0.91s ==============================
```

---

## 8. Origem Real do WebSocket e Sinais Ativos

- **Origem do WebSocket:** Criado no iframe `https://chart.b2trading.io/`, apontando para `wss://ws.b2trading.io/ws`.
- **Motor de Sinais Ativo:** `EMA9_EMA21_RSI14` (F-007 do PRD):
  - COMPRA: EMA 9 cruza acima da EMA 21 e RSI 14 > 50.
  - VENDA: EMA 9 cruza abaixo da EMA 21 e RSI 14 < 50.
  - AGUARDAR: Demais estados ou período de aquecimento (< 22 candles).
- **Interface Visual:**
  - Painel flutuante em Shadow DOM na tela do traderoom agora exibe card de sinal ativo com cores em tempo real (Verde / Vermelho / Amarelo) e métricas numéricas de EMA 9, EMA 21 e RSI 14.
  - Popup da extensão e Janela Fixa refletem o sinal em tempo real sincronizado pelo `chrome.storage.local`.

---

## 9. Próxima Etapa Recomendada

1. Recarregar a extensão em `chrome://extensions/` e dar F5 na aba da B2Trading.
2. Acompanhar a formação dos candles e o disparo dos sinais na janela fixa ou painel flutuante.

---

## 11. Fase 5 — Adaptação Completa do Viewport (Sem Sobreposição) & Painel Lateral Nativo

### 1. Problema Abordado
Ao abrir a barra lateral fixa na tela da B2Trading, o elemento `position: fixed` sobrepunha a margem lateral da corretora (cobrindo ferramentas de desenho, seletores de ativos e cabeçalho). O usuário exigiu: *"so que nao pode sobrepor a tela tem que abrir adaptado"*.

### 2. Solução Arquitetural Implementada
1. **Adaptação Responsiva Dinâmica do DOM (`src/content/panel.js`)**:
   - `this.host` montado diretamente em `document.documentElement` (`<html>`), isolando-o das transformações aplicadas a `document.body`.
   - `document.body` recebe dinamicamente:
     - `width: calc(100vw - 260px)` (ou `calc(100vw - 34px)` quando recolhido);
     - `transform: translateX(260px)` (lado esquerdo) ou `transform: translateZ(0)` (lado direito);
     - `transition: transform 0.22s ease-in-out, width 0.22s ease-in-out`.
   - Criação de novo containing block que desloca e comprime **todos** os elementos da corretora (incluindo elementos `position: fixed` como topbar, header e botões de ordem).
   - Despacho imediato e pós-animação de `window.dispatchEvent(new Event("resize"))` para que o TradingView e gráficos em Canvas reajustem a largura nativa sem cortes nem distorções.
   - Adicionado botão interativo `◧ Adaptado` no cabeçalho do painel para controle opcional de adaptação.

2. **Painel Lateral Nativo do Chrome (`chrome.sidePanel`)**:
   - Criados `src/sidepanel/sidepanel.html` e `src/sidepanel/sidepanel.js`.
   - Declarados `"sidePanel"` nas permissões e `"side_panel"` no `manifest.json`.
   - Adicionado botão *"📑 Abrir Painel Lateral Nativo do Chrome"* no popup da extensão.
   - Permite divisão de tela 100% nativa gerenciada pelo próprio navegador Chrome ao lado da aba da corretora.

### 3. Validação e Testes
- Testes automatizados no Chromium (`scratch/test_panel_class_direct.py`) comprovaram:
  - Deslocamento de `topbar.left` de 0 para 260px na expansão (0% de sobreposição).
  - Deslocamento para 34px no modo recolhido (0% de sobreposição).
  - Encaixe contíguo exato em 1180px no lado direito (0% de sobreposição).
- Suíte `npm test`: 18/18 testes aprovados (100%).
- Suíte `pytest`: 12/12 testes aprovados (100%).

---

## 12. Fase 6 — Sistema Central de Logs em Tempo Real e Console Visual

### 1. Problema Abordado
O usuário solicitou auditoria e visualização em tempo real das ações internas da extensão: *"adiciona logs na extensao"*. O sistema anterior emitia logs esparsos no console e não oferecia visualização em interface para o operador/trader.

### 2. Solução Implementada
1. **Módulo Central de Logs (`src/utils/logger.js`)**:
   - `LogManager`: Gerenciador de eventos com buffer circular (últimos 80 eventos em memória).
   - Níveis semânticos: `info`, `success`, `warn`, `error`.
   - Tags padronizadas:
     - `[FEED]`: Ticks recebidos, atualizações de máxima/mínima/fechamento, trocas de par.
     - `[SINAL]`: Sinais de COMPRA (verde), VENDA (vermelho) e AGUARDAR (âmbar) com parâmetros de confluência.
     - `[INDICADOR]`: Leituras pontuais de EMA9, EMA21 e RSI14.
     - `[ESTADO]`: Transições de qualidade (BOOTING, SYNCING, READY, DATA_GAP, STALE).
     - `[WS]`: Conexões, quedas e reconexões do WebSocket.
     - `[STORE]`: Abertura e fechamento de candles na grade temporal de 60s.
     - `[HISTÓRICO]`: Ingestão de pacotes históricos REST.
   - Saída colorida no DevTools Console (F12) com formatação CSS avançada.
   - Sincronização reativa via `chrome.storage.local` (`oracle_logs`).

2. **Terminal de Logs na Interface Visual**:
   - **Barra Lateral Adaptada (`src/content/panel.js`)**: Terminal embutido com rolagem automática, contagem de logs em tempo real, botão *"📋 Copiar"* e botão *"🗑️ Limpar"*.
   - **Popup Oficial (`src/popup/popup.html` e `src/popup/popup.js`)**: Seção de logs em tempo real sincronizada via storage.
   - **Painel Lateral Nativo (`src/sidepanel/sidepanel.html` e `src/sidepanel/sidepanel.js`)**: Terminal de logs nativo do Chrome.

### 3. Validação e Testes
- Novo arquivo de testes unitários: `tests/logger.test.js` (3 testes profundos).
- Teste em navegador real com Playwright (`scratch/test_log_ui_terminal.py`):
  - Ingestão de logs [WS], [FEED], [STORE], [SINAL].
  - Renderização das tags coloridas no Shadow DOM.
  - Ação do botão *"Limpar logs"* esvaziando o buffer e a interface.
- Total de testes Node.js: **21 de 21 aprovados (100%)**.
- Total de testes Python: **12 de 12 aprovados (100%)**.

---

## 13. Declaração Explícita de Conformidade e Segurança

Confirmo expressa e categoricamente que:
- **NENHUMA ordem de negociação foi executada.**
- **NENHUM botão de compra ou venda (`#btnBuy`, `#btnSell`) foi clicado.**
- **NENHUM campo de valor (`#amountInput`) foi alterado.**
- **NENHUM `WebSocket.send()` foi chamado ou disparado.**
- **NENHUMA subscrição adicional foi enviada ao servidor.**
- **NENHUM token, senha, cookie ou JWT foi salvo ou exposto.**
- **NENHUM dado foi enviado para serviços externos.**

---

## 14. Rebranding INFLITRUS SIGNALS — Interceptor

### Entrega visual

- Auditoria prévia registrada em `docs/AUDITORIA-UI.md`.
- Painel recriado em Shadow DOM fechado, com tokens oficiais, Space Grotesk, JetBrains Mono, onda em canvas, núcleo, anel, checklist, contexto, acordeões, pílula e onboarding.
- Adaptador puro em `src/ui/view-model.js`: 14 estados técnicos consolidados em 5 estados visíveis, sem recalcular dados ou sinais.
- Popup e side panel em espanhol neutro, sem exibir direção de sinal no popup.
- Notificações com janela válida de cinco segundos e badge semântico Teal/Âmbar.
- Manifest, logo e ícones 16/32/48/128 migrados para Inflitrus.
- Referência, prompt e manual empacotados em `docs/`.

### Validação

- Suite Node: 54/54 testes aprovados.
- Verificação de sintaxe em todos os módulos JavaScript: aprovada.
- Render visual dos cinco estados, pílula, popup e onboarding em `test-output/ifx-*.png`.
- Teste de integração do `DiagnosticPanel` real, incluindo Shadow DOM fechado, CSS carregado por URL da extensão e fontes locais: aprovado sem erros de console.
- Nenhum arquivo em `src/main`, `src/market`, `src/indicators` ou `src/strategy` foi alterado.
- Nenhuma permissão ou host permission foi adicionado.

