# Documento de Validação Final — Inflitrus Signals (MV3)

Este documento consolida a rastreabilidade completa entre os problemas diagnosticados na auditoria inicial, os commits que implementaram as soluções, a cobertura da suíte de testes automatizados e o roteiro de homologação manual.

---

## 1. Matriz de Rastreabilidade (ID do Relatório → Commit → Teste Automatizado)

| ID | Categoria | Descrição do Problema | Commit de Correção | Teste Automatizado que Cobre |
|---|---|---|---|---|
| **P-04** | Performance | Testes legados testavam cópias de funções | `7dec108` | `npm test` oficial via `package.json` |
| **T-01** | Relógio | Cronômetro travado em `01:00 / EXECUTE` por reset com abertura | `abf5fe0` | `tests/regression-audit.test.js` (Caso 1), `tests/candle-timer.test.js` |
| **T-02** | Relógio | Sincronização do relógio a cada tick recebido | `abf5fe0` | `tests/market-clock.test.js` |
| **T-03** | Relógio | Offset do servidor aceitando amostras anômalas | `abf5fe0` | `tests/market-clock.test.js` |
| **T-05** | Relógio | Pips disparados quando `remainingSeconds === 60` no meio da vela | `abf5fe0`, `cd3d591` | `tests/sound-transitions.test.js` |
| **P-05** | Performance | Atrasos de timers em janelas minimizadas | `abf5fe0` | `src/utils/market-clock.js` (cálculo instantâneo) |
| **R-02** | Repaint | `QuantPortfolio.evaluate()` mutava estado interno (`this.*`) | `ac34aaa` | `tests/portfolio-purity.test.js`, `tests/quant-portfolio.test.js` |
| **R-03** | Repaint | Inversão abrupta de sinal no primeiro tick da nova vela | `ac34aaa`, `bf4b90a` | `tests/regression-audit.test.js` (Caso 4), `tests/signal-lifecycle.test.js` |
| **R-04** | Repaint | Múltiplas chamadas de `evaluate()` degradavam CUSUM falsamente | `ac34aaa` | `tests/regression-audit.test.js` (Caso 3) |
| **R-06** | Repaint | Subestratégias com estado compartilhado entre pares distintos | `ac34aaa` | `tests/portfolio-registry.test.js` |
| **R-01** | Repaint | Decisão avaliada a cada tick oscilando CALL e PUT | `bf4b90a` | `tests/regression-audit.test.js` (Caso 4), `tests/signal-lifecycle.test.js` |
| **R-05** | Repaint | Falta de cancelamento defensivo se a qualidade dos dados cair | `bf4b90a` | `tests/signal-lifecycle.test.js` |
| **R-07** | Repaint | IDs de sinal instáveis disparando alertas repetidos | `bf4b90a` | `tests/signal-lifecycle.test.js` |
| **A-01** | Auditoria | Sinais liquidados prematuramente com vela aberta (`closed: false`) | `bf4b90a` | `tests/regression-audit.test.js` (Caso 2), `tests/signal-auditor.test.js` |
| **A-02** | Auditoria | Aprendizado estatístico alimentado antes do fechamento formal | `bf4b90a` | `tests/signal-auditor.test.js` |
| **T-04** | Relógio | Ausência de gatilho explícito de entrada na abertura M1 | `bf4b90a` | `tests/signal-lifecycle.test.js` |
| **I-03** | Isolamento | Ativo inferido pelo primeiro tick arbitrário do feed | `cde4623` | `tests/active-channel.test.js` |
| **I-04** | Isolamento | Dois analyzers concorrentes por aba (top frame e iframe) | `cde4623` | `tests/frame-and-bridge.test.js` |
| **I-05** | Isolamento | Payout global sobrescrevendo pares concorrentes | `cde4623`, `ac34aaa` | `tests/portfolio-registry.test.js` |
| **I-10** | Isolamento | Ingestão de histórico REST gravando em par em memória | `cde4623` | `tests/active-channel.test.js`, `tests/market-core.test.js` |
| **I-11** | Isolamento | Ausência de cancelamento/limpeza ao trocar de ativo | `cde4623` | `tests/active-channel.test.js` |
| **T-07** | Relógio | Processamento de timeframes incompatíveis com M1 | `cde4623` | `tests/active-channel.test.js`, `tests/lifecycle-card.test.js` |
| **I-01** | Isolamento | Chaves globais no storage gerando concorrência entre abas | `cd3d591` | `tests/regression-audit.test.js` (Caso 5), `tests/service-worker-isolation.test.js` |
| **I-02** | Isolamento | Side Panel lia dados misturados de qualquer aba aberta | `cd3d591` | `tests/regression-audit.test.js` (Caso 5), `tests/ui-view-model.test.js` |
| **I-06** | Isolamento | Badge no ícone da extensão sobrescrevia outras abas | `cd3d591` | `tests/service-worker-isolation.test.js` |
| **I-07** | Isolamento | Áudio vazando em abas em segundo plano e no content script | `cd3d591` | `tests/sound-transitions.test.js` |
| **I-08** | Isolamento | Painel legado duplicado em múltiplos frames | `cd3d591` | `tests/frame-and-bridge.test.js` |
| **I-09** | Isolamento | Botões multi-janela redimensionando janelas incorretas | `cd3d591` | `src/background/service-worker.js` |
| **T-06** | Interface | Mensagens conflitantes no card e cronômetro sem contagem | `dda2e81` | `tests/lifecycle-card.test.js` |
| **P-03** | Performance | `WaveRenderer` destruído e recriado a cada 250ms | `dda2e81` | `src/sidepanel/sidepanel.js`, `src/popup/popup.js` |
| **P-01** | Performance | `evaluate()` recalculando todas as 21 subestratégias a cada tick | `6e462e2` | `src/content/analyzer.js`, `tests/quant-portfolio.test.js` |
| **P-02** | Performance | `setInterval` de 2.5s sobrecarregando escritas no storage | `6e462e2` | `src/content/analyzer.js` |

---

## 2. Matriz dos 16 Itens de Teste da Seção §5 do Plano

| # | Comportamento Requerido | Arquivo de Teste | Status |
|---|---|---|---|
| 1 | Sincronização do relógio sem travar em `remaining=60` | `tests/regression-audit.test.js` (Caso 1) | PASS |
| 2 | Amostras de offset fora de $\pm 3000$ ms ignoradas | `tests/market-clock.test.js` | PASS |
| 3 | Contagem regressiva contínua no `CandleTimer` | `tests/candle-timer.test.js` | PASS |
| 4 | Avaliação pura do `RegimeChangeDetector` (0 falsos change points) | `tests/regression-audit.test.js` (Caso 3) | PASS |
| 5 | Avaliação estritamente pura e idempotente do `QuantPortfolio` | `tests/quant-portfolio.test.js`, `tests/portfolio-purity.test.js` | PASS |
| 6 | Transição para `PRE_SIGNAL` aos 52s quando há Edge qualificado | `tests/signal-lifecycle.test.js` | PASS |
| 7 | Bloqueio de repainting: tick oposto aos 55s NÃO inverte direção | `tests/regression-audit.test.js` (Caso 4), `tests/signal-lifecycle.test.js` | PASS |
| 8 | Transição para `ENTRY_NOW` no segundo 00 da vela alvo | `tests/signal-lifecycle.test.js` | PASS |
| 9 | Transição para `IN_TRADE` do segundo 01 ao 59 da vela alvo | `tests/signal-lifecycle.test.js` | PASS |
| 10 | Transição para `SETTLED` no segundo 60 com vela fechada | `tests/signal-lifecycle.test.js` | PASS |
| 11 | Cancelamento defensivo `CANCELLED` se qualidade degradar antes da entrada | `tests/signal-lifecycle.test.js` | PASS |
| 12 | `SignalAuditor` não liquida sinal com vela aberta (`closed: false`) | `tests/regression-audit.test.js` (Caso 2), `tests/signal-auditor.test.js` | PASS |
| 13 | Auditoria em T+1 e calibração estatística apenas em vela fechada | `tests/signal-auditor.test.js` | PASS |
| 14 | Isolamento multi-abas: `selectTabView` nunca vaza dados entre abas | `tests/regression-audit.test.js` (Caso 5) | PASS |
| 15 | Isolamento do Badge: `setBadgeText` recebe estritamente o `tabId` | `tests/service-worker-isolation.test.js` | PASS |
| 16 | Alertas sonoros, bips 3-2-1 e deduplicação por transição de fase | `tests/sound-transitions.test.js` | PASS |

---

## 3. Checklist de Homologação Manual (Seção §6 do Plano)

Utilize este checklist interativo para validar visual e operacionalmente a extensão em seu navegador:

### Cenário 1: Operação Concorrente com 2 Janelas (Multi-Window)
- [ ] **1.1** Abrir Janela 1 com `https://traderoom.b2trading.io/` no par `EURUSD` (M1).
- [ ] **1.2** Abrir Janela 2 separada (`Ctrl+N`) com `https://traderoom.b2trading.io/` no par `AUDCAD` ou `1000SATS_OTC` (M1).
- [ ] **1.3** Abrir o Side Panel em cada janela.
- [ ] **1.4** Clicar no botão `"2 Ventanas"` no Side Panel e confirmar o auto-redimensionamento lado a lado na tela.
- [ ] **1.5** Verificar os identificadores no topo:
  - Janela 1: `EURUSD · M1 · Ventana 1`
  - Janela 2: `AUDCAD · M1 · Ventana 2`
- [ ] **1.6** Confirmar que sinais, bips e alertas visuais ocorrem de forma 100% isolada em cada janela sem interferência cruzada.

### Cenário 2: Ciclo de 60 Segundos e Zero Repainting
- [ ] **2.1 Segundos 00 a 44 (Scanning):** O card permanece neutro em cinza: *"Escuchando {PAR} · decisión en Xs"*. Zero repainting ou oscilação de CALL/PUT no meio da vela.
- [ ] **2.2 Segundos 45 a 56 (Decision / Pre-Signal):** Se houver oportunidade, card acende em Verde/Vermelho: *"▲ Pré-alerta CALL/PUT {PAR} · entrada en Xs"*. O sinal congela e **não inverte** mesmo com ticks voláteis.
- [ ] **2.3 Segundos 57, 58 e 59 (Preparation):** Ouvem-se os 3 bips curtos de preparação.
- [ ] **2.4 Segundo 00 a 05 (Abertura):** Card destaca *"ENTRE AHORA · CALL/PUT {PAR} (Xs restantes)"* e emite tom duplo de entrada na abertura.
- [ ] **2.5 Segundos 06 a 59 (In Trade):** Card exibe *"Operación en curso {PAR} · expira en Xs"*.
- [ ] **2.6 Fechamento da Vela:** Card exibe *"Resultado WIN/LOSS {PAR}"*.

### Cenário 3: Cronômetro Contínuo
- [ ] **3.1** Cronômetro avança de forma suave e contínua segundo a segundo alinhado com o gráfico.
- [ ] **3.2** O cronômetro **nunca volta para 01:00** no meio da vela.
- [ ] **3.3** O cronômetro **nunca exibe números negativos** (clamp em 0s).

### Cenário 4: Troca de Ativo
- [ ] **4.1** Ao mudar de par na plataforma da corretora, o Side Panel detecta a troca de canal imediatamente.
- [ ] **4.2** Qualquer pré-alerta ativo do par anterior é cancelado e registrado no histórico com a tag `ASSET_CHANGED`.

### Cenário 5: Histórico e Placar Auditado
- [ ] **5.1** A aba `Registro` exibe histórico de operações exclusivo da aba ativa.
- [ ] **5.2** Operações mostram preço de entrada e preço de fechamento da vela.
- [ ] **5.3** Operações canceladas aparecem riscadas com a justificativa técnica.

---

## 4. Riscos Restantes Conhecidos

1. **Alteração Estrutural no Formato de Mensagens da Corretora:**
   - A extensão monitora subscrições no formato `{ action: "subscribe", channel: "PAR-M1" }` e envelopes de mensagens com propriedade `pair`. Se a corretora alterar a convenção do WebSocket (ex.: migrar para buffers binários protobuf ou mudar o padrão do nome do canal), o `ActiveChannel` precisará de ajuste na regex de canal.
2. **Latência Extrema de Rede do Cliente (> 3000 ms):**
   - O `MarketClock` descarta amostras de sincronização com desvio superior a $\pm 3000$ ms para proteger contra congelamentos de aba. Se a conexão do operador sofrer jitter extremo prolongado, o relógio local usará o tempo do sistema até a próxima vela estável.
3. **Restrições de Áudio Autoplay do Chrome:**
   - Em abas recém-abertas sem qualquer interação do usuário (clique), a Web Audio API pode iniciar em estado `"suspended"`. O Side Panel trata isso automaticamente retomando o contexto de áudio (`audioCtx.resume()`) no primeiro clique na extensão ou no botão de som.
