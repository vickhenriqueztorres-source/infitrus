================================================================================
B2TRADING INSPECTOR - ARQUIVOS DE DIAGNÓSTICO DE REDE E MERCADO
================================================================================

AVISO IMPORTANTE:
Estes arquivos contêm exclusivamente telemetria de tráfego capturada em modo
SOMENTE LEITURA. Nenhuma ordem de negociação foi executada ou enviada.
Todos os tokens, credenciais, JWTs, senhas e cookies foram devidamente mascarados.

ESTRUTURA DOS ARQUIVOS GERADOS:

1. events.jsonl
   - Registro completo de todos os eventos HTTP, WebSocket, Frames e DOM capturados.
   - Formato: 1 objeto JSON válido por linha.

2. relevant-events.jsonl
   - Subconjunto filtrado contendo apenas eventos de mercado (OHLC, candles, ticks,
     cotações em tempo real e feeds identificados com likely_market_data = true).

3. summary.json
   - Sumário estatístico global: total de requisições, conexões WebSocket ativas,
     ativos detectados e duração da sessão.

4. frames.json
   - Lista e árvore de iframes detectados na página (traderoom, chart, restapi).

5. websocket-summary.json
   - Conexões WebSocket mapeadas por hash seguro da URL sanitizada, volumes de frames
     e ativos identificados nos streams.

6. errors.log
   - Log de erros toleráveis de rede (timeouts, respostas abortadas, etc.).

Finalidade: Engenharia reversa ética e mapeamento de feed para o projeto Oracle Quant.
