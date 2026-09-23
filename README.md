# B2Trading Inspector — Observador Passivo de Mercado

Ferramenta local de diagnóstico e telemetria de rede baseada em **Playwright (Python assíncrono)** para analisar a plataforma `https://traderoom.b2trading.io/` em modo estritamente **SOMENTE LEITURA (Read-Only)**.

---

## 1. Propósito e Diretrizes de Segurança

O `b2trading_inspector.py` foi desenvolvido para mapear fluxos de dados, frames, WebSockets e endpoints HTTP (cotações em tempo real e histórico de candles) necessários para a engenharia da extensão Chrome **Oracle Quant Signals**.

### 🛡️ Garantias de Segurança Invioláveis
- **Modo Somente Leitura:** A ferramenta é apenas observadora de tráfego.
- **Zero Execução de Ordens:** NUNCA clica nos botões `#btnBuy` ou `#btnSell`.
- **Zero Modificação de Campos:** NUNCA preenche ou altera `#amountInput` ou outros campos da plataforma.
- **Zero Injeção WebSocket:** NUNCA invoca `socket.send()`; escuta apenas mensagens emitidas legitimamente pela corretora.
- **Zero Chamadas Externas à API:** Não usa `requests`, `urllib` ou `httpx` para reenviar dados ou fazer chamadas adicionais à corretora fora do navegador.
- **Zero Replay de Tráfego:** Requisições nunca são repetidas ou manipuladas.
- **Sanitização Ativa de Credenciais:** Mascara em tempo real JWTs (`eyJ...`), cabeçalhos `Authorization: Bearer`, cabeçalhos `Cookie` e `Set-Cookie`, senhas, tokens de query string e e-mails antes de qualquer gravação em disco.
- **Login Manual:** O navegador Chromium abre visível (`headless=False`) e aguarda o operador realizar o login manualmente. A ferramenta não burla autenticação, CAPTCHA ou DRM.

---

## 2. Requisitos Técnicos

- **Python:** Versão 3.11 ou superior (testado e homologado em Python 3.13).
- **Playwright:** 1.40.0 ou superior.
- **Navegador:** Chromium oficial do Playwright.
- **Sistema Operacional:** Windows, Linux ou macOS.

---

## 3. Instalação

Abra o terminal na pasta do projeto e execute os passos abaixo:

### Passo 1: Criar e ativar o ambiente virtual

**No Windows (PowerShell):**
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

**No Linux / macOS (Bash/Zsh):**
```bash
python -m venv .venv
source .venv/bin/activate
```

### Passo 2: Instalar as dependências do projeto
```bash
pip install -r requirements.txt
```

### Passo 3: Instalar o binário do Chromium do Playwright
```bash
python -m playwright install chromium
```

---

## 4. Como Executar a Ferramenta

### Execução Padrão (Recomendada)
Inicia o navegador visível com perfil persistente em `./browser-profile` e saídas em `./inspection-output`:
```bash
python b2trading_inspector.py
```

### Parâmetros da Linha de Comando (CLI)

| Argumento | Padrão | Descrição |
|---|---|---|
| `--url` | `https://traderoom.b2trading.io/` | URL principal da plataforma alvo |
| `--profile` | `./browser-profile` | Diretório do perfil persistente (mantém login manual entre sessões) |
| `--output` | `./inspection-output` | Diretório onde os arquivos JSON e JSONL serão salvos |
| `--duration` | `None` (até Ctrl+C) | Duração máxima da captura em segundos |
| `--slow-mo` | `0` | Atraso intencional em milissegundos entre ações |
| `--verbose` | `False` | Exibe logs detalhados de requisições individuais no console |
| `--no-wait` | `False` | Não aguarda a tecla Enter após o carregamento inicial |

#### Exemplos de comandos avançados:

1. **Captura com limite de 120 segundos:**
   ```bash
   python b2trading_inspector.py --duration 120
   ```

2. **Modo Verbose em diretório personalizado:**
   ```bash
   python b2trading_inspector.py --output ./coleta-mercado --verbose
   ```

3. **Modo de teste rápido automatizado:**
   ```bash
   python b2trading_inspector.py --duration 10 --no-wait
   ```

---

## 5. Fluxo Passo a Passo: Login Manual e Início da Captura

1. Execute o comando `python b2trading_inspector.py`.
2. O terminal exibirá o banner oficial:
   ```text
   ================================================================================
   🚀 B2TRADING INSPECTOR — Observador Passivo de Mercado
   🔒 MODO SOMENTE LEITURA ATIVO | NENHUMA ORDEM SERÁ ENVIADA
   🛡️ REGRAS: Sem cliques em BUY/SELL, sem alteração de valor, sem injeção WS
   ⚠️ LOGIN MANUAL NECESSÁRIO: Faça login no navegador aberto
   ================================================================================
   ```
3. Uma janela do Google Chrome/Chromium abrirá exibindo `https://traderoom.b2trading.io/`.
4. **Realize o login manualmente:** Digite seu e-mail e senha diretamente no formulário da página da corretora. Como o perfil persistente é utilizado (`./browser-profile`), em execuções subsequentes a sua sessão permanecerá salva.
5. Quando o gráfico for renderizado e a sala de negociação estiver ativa, volte ao terminal e pressione **[ENTER]**.
6. A ferramenta continuará monitorando em segundo plano todo o tráfego HTTP, WebSockets, iframes e elementos do gráfico.
7. Para encerrar a qualquer momento com segurança, pressione **Ctrl+C** no terminal. O navegador fechará e todos os arquivos estatísticos serão salvos de forma atômica.

---

## 6. Arquivos Gerados na Pasta `./inspection-output/`

| Arquivo | Descrição |
|---|---|
| `events.jsonl` | Registro cronológico completo de todos os eventos HTTP, WebSockets, DOM e iframes capturados (1 JSON por linha). |
| `relevant-events.jsonl` | Subconjunto filtrado contendo exclusivamente eventos classificados como mercado (`likely_market_data: true`), candles, cotações e histórico. |
| `summary.json` | Sumário quantitativo consolidado com contadores de requests, conexões WebSocket, ativos detectados e duração da sessão. |
| `frames.json` | Relação estruturada de todos os iframes detectados na página (`chart.b2trading.io`, `traderoom.b2trading.io`, `restapi.b2trading.io`). |
| `websocket-summary.json` | Lista de conexões WebSocket mapeadas por hash SHA-256 anônimo da URL sanitizada, total de frames RX/TX e ativos identificados. |
| `README.txt` | Guia de diagnóstico rápido embutido na pasta de saída. |
| `errors.log` | Registro de exceções toleráveis de rede (timeouts, respostas abortadas). |

---

## 7. Exemplo de Saída Sanitizada

### Exemplo de Evento de WebSocket Recebido (`events.jsonl` / `relevant-events.jsonl`):
```json
{
  "id": "7f8b9a12-34cd-56ef-a012-3456789abcde",
  "timestamp": "2026-09-22T15:25:30.123456+00:00",
  "event_type": "ws_frame_received",
  "source": "websocket",
  "url": "wss://traderoom.b2trading.io/ws?token=[TOKEN_REDACTED]",
  "frame_url": "https://traderoom.b2trading.io/",
  "classification": "websocket",
  "data": {
    "conn_id": "8a3f910b2c4e",
    "direction": "received",
    "opcode": 1,
    "payload_type": "text",
    "size_bytes": 168,
    "preview": "{\"event\": \"candle_update\", \"symbol\": \"EURUSD\", \"resolution\": \"1\", \"data\": {\"time\": 1727010180000, \"open\": 1.08520, \"high\": 1.08565, \"low\": 1.08510, \"close\": 1.08542, \"volume\": 142.5}}",
    "likely_market_data": true,
    "evidence": [
      "Conjunto OHLC detectado: ['close', 'high', 'low', 'open']",
      "Evento com nomenclatura de mercado: ['event:candle_update']",
      "Chave de granularidade temporal (resolution/timeframe)"
    ],
    "keys_found": ["close", "event:candle_update", "high", "low", "open", "resolution", "symbol", "time", "volume"],
    "symbol_detected": "EURUSD"
  },
  "redactions_applied": [
    "query_token"
  ]
}
```

### Exemplo de Evento HTTP Response com Sanitização de Tokens:
```json
{
  "id": "e2a3b4c5-6789-0123-4567-89abcdef0123",
  "timestamp": "2026-09-22T15:25:31.450100+00:00",
  "event_type": "http_response",
  "source": "network_response",
  "url": "https://restapi.b2trading.io/api/v1/market/history?symbol=EURUSD&from=1727000000&to=1727010000&token=[TOKEN_REDACTED]",
  "frame_url": "https://chart.b2trading.io/",
  "classification": "history",
  "data": {
    "status": 200,
    "content_type": "application/json; charset=utf-8",
    "body_size": 2048,
    "body_preview": "{\"status\":\"ok\",\"t\":[1727000000,1727000060],\"o\":[1.0851,1.0852],\"h\":[1.0855,1.0856],\"l\":[1.0850,1.0851],\"c\":[1.0852,1.0854],\"v\":[100,120]}",
    "likely_market_data": true,
    "evidence": [
      "Conjunto OHLC detectado: ['close', 'high', 'low', 'open']"
    ],
    "keys_found": ["close", "high", "low", "open", "time", "volume"],
    "symbol_detected": "EURUSD"
  },
  "redactions_applied": [
    "query_token"
  ]
}
```

---

## 8. Como Localizar Recursos Críticos nos Arquivos Gerados

Para apoiar o desenvolvimento dos módulos de captura do content script do Chrome, utilize os comandos e padrões abaixo para filtrar dados nos arquivos JSONL:

### 8.1 Histórico OHLC e `getBars`
Para encontrar as chamadas REST que alimentam o histórico inicial do gráfico (TradingView Charting Library `getBars`):
```bash
# Filtrar requisições classificadas como 'history'
grep '"classification": "history"' ./inspection-output/relevant-events.jsonl

# Procurar por endpoints da API de histórico
grep -E 'history|bars|ohlc' ./inspection-output/events.jsonl
```
- **O que observar:** O formato retornado (`{ t: [...], o: [...], h: [...], l: [...], c: [...], v: [...] }` ou lista de objetos `{ time, open, high, low, close }`), a URL base (`restapi.b2trading.io` ou `chart.b2trading.io`) e os parâmetros de timeframe (`resolution=1`, `resolution=60`, etc.).

### 8.2 Ticks e Cotações Rápidas
```bash
grep '"classification": "tick"' ./inspection-output/relevant-events.jsonl
grep -i '"price"' ./inspection-output/relevant-events.jsonl
```
- **O que observar:** Se a corretora envia atualizações tick-a-tick em JSON ou formato binário comprimido e a frequência de disparo.

### 8.3 Candles e Atualizações em Tempo Real (`candle_update`)
```bash
grep -i 'candle_update' ./inspection-output/relevant-events.jsonl
grep '"likely_market_data": true' ./inspection-output/relevant-events.jsonl
```
- **O que observar:** Estrutura do objeto de vela, timestamp de abertura/fechamento (milissegundos vs segundos em epoch UTC) e o nome do ativo (`symbol` ou `pair`).

### 8.4 WebSockets e Streams de Dados
Verifique o arquivo `websocket-summary.json` para obter o mapeamento imediato de conexões:
```json
[
  {
    "conn_id": "8a3f910b2c4e",
    "url": "wss://traderoom.b2trading.io/ws?token=[TOKEN_REDACTED]",
    "frames_received": 1420,
    "frames_sent": 12,
    "detected_symbols": ["EURUSD", "BTCUSD"],
    "likely_market_data": true
  }
]
```
E filtre as mensagens transmitidas em `relevant-events.jsonl`:
```bash
grep '"event_type": "ws_frame_received"' ./inspection-output/relevant-events.jsonl
```

### 8.5 Subscrições em Tempo Real (`subscribeBars`)
Para inspecionar mensagens enviadas pelo frontend do navegador à corretora para se inscrever em um par de moedas:
```bash
grep '"event_type": "ws_frame_sent"' ./inspection-output/events.jsonl
```
- **O que observar:** O payload de inscrição enviado pelo cliente (ex: `{"action": "subscribe", "channel": "candles", "symbol": "EURUSD", "timeframe": "1m"}`).

---

## 9. Suíte de Testes Automatizados

A ferramenta conta com testes unitários rigorosos cobrindo todas as 12 frentes de segurança e classificação estatística.

Para rodar os testes:
```bash
pytest test_b2trading_inspector.py -v
```

Cobertura dos testes:
1. `test_sanitize_url_with_token`: Mascaramento de parâmetros sensíveis em URLs.
2. `test_sanitize_jwt`: Redação de tokens JWT `eyJ...`.
3. `test_sanitize_authorization_bearer`: Redação de cabeçalhos de autorização Bearer.
4. `test_sanitize_cookie_headers_and_fields`: Redação de Cookies e Set-Cookie.
5. `test_sanitize_json_with_sensitive_fields`: Mascaramento em JSON de senhas, e-mails e tokens.
6. `test_payload_with_ohlc`: Detecção positiva de OHLC completo.
7. `test_payload_price_only_not_candle`: Garantia de não-falso-positivo com preço isolado.
8. `test_binary_arraybuffer_hex_preview`: Tratamento seguro de buffers binários.
9. `test_classify_url_chart_iframe`: Classificação de componentes e iframes do TradingView.
10. `test_classify_all_url_categories`: Cobertura de todas as 10 categorias de classificação de URL.
11. `test_ws_hash_does_not_contain_token`: Hash estável de WebSocket sem vazar credenciais.
12. `test_output_manager_files_generation`: Geração e integridade física de todos os arquivos de saída.
