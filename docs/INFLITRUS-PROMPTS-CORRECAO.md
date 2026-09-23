# Inflitrus Signals — Prompts de Correção para a IDE (Antigravity)

Sequência completa para corrigir os 3 problemas: **vazamento entre janelas**, **repaint (CALL → PUT)** e **cronômetro sem "faltam X s / entre agora"**.

## Como usar

1. Copie estes 3 arquivos para a pasta `docs/` do repositório `infitrus`:
   - `docs/INFLITRUS-AUDITORIA-SINAIS.md` (relatório, com os IDs I-xx, R-xx, T-xx, A-xx, P-xx)
   - `docs/INFLITRUS-PLANO-CORRECAO-SINAIS.md` (plano)
   - `docs/INFLITRUS-PROMPTS-CORRECAO.md` (este arquivo)
2. Abra uma conversa nova na IDE e cole o **PROMPT 00**. Ele fixa as regras para a conversa inteira.
3. Cole **um prompt por vez**, na ordem. Só passe para o próximo quando a IDE responder com o relatório de fim de etapa e **todos os testes estiverem verdes**.
4. Se algo quebrar, use o **PROMPT S.O.S** no final.
5. Os prompts 03 e 04 trazem **código pronto e já testado** (relógio e ciclo de vida do sinal). A IDE deve copiar esse código, não reinventar.

| # | Etapa | Resolve |
|---|---|---|
| 00 | Contexto e regras | — |
| 01 | Linha de base + testes de regressão | P-04 |
| 02 | Relógio único e cronômetro | T-01, T-02, T-03, T-05, P-05 |
| 03 | Ciclo de vida do sinal + estratégia sem efeito colateral | R-02, R-03, R-04, R-06 |
| 04 | Integrar o ciclo de vida (anti-repaint) + placar + aprendizado | R-01, R-05, R-07, A-01, A-02, T-04 |
| 05 | Detecção do ativo pelo canal + 1 frame de cálculo por aba | I-03, I-04, I-05, I-10, I-11, T-07 |
| 06 | Storage por aba + Side Panel preso à própria janela + som/badge | I-01, I-02, I-06, I-07, I-08, I-09 |
| 07 | Interface do cronômetro e do ciclo do sinal | T-06 |
| 08 | Performance e documentação | P-01, P-02, P-03 |
| 09 | Verificação final | Definição de pronto |

---

## PROMPT 00 — Contexto e regras (colar primeiro)

```text
Você vai corrigir a extensão Chrome "Inflitrus Signals" (MV3) deste repositório. Ela lê o WebSocket da corretora B2Trading, gera sinais CALL/PUT para opções binárias M1 e mostra tudo em um Side Panel.

Antes de qualquer alteração, leia por completo:
- docs/INFLITRUS-AUDITORIA-SINAIS.md  (relatório de bugs com IDs I-xx, R-xx, T-xx, A-xx, P-xx e arquivo:linha)
- docs/INFLITRUS-PLANO-CORRECAO-SINAIS.md  (arquitetura-alvo, máquina de estados, testes obrigatórios)
- WORKLOG.md, manifest.json, src/content/analyzer.js, src/sidepanel/sidepanel.js, src/strategy/quant-portfolio.js

Os 3 problemas que o usuário vê:
1. Com 2 janelas do Chrome (mesmo perfil), cada uma com a corretora em um ativo diferente, um sinal de uma janela pisca e toca na outra.
2. Repaint: manda CALL e, quando chega o primeiro tick da vela seguinte, manda PUT.
3. O cronômetro não mostra "faltam X s" nem "entre agora"; ele fica travado em 01:00.

REGRAS OBRIGATÓRIAS PARA TODA A CONVERSA:
1. Trabalhe só na etapa do prompt atual. Não adiante etapas futuras e não refatore o que não foi pedido.
2. NÃO altere a matemática das estratégias, dos detectores e dos indicadores (famílias, subestratégias, fórmulas, limiares). Só mova estado e chamadas de lugar quando o prompt mandar.
3. Uma aba = uma fonte de verdade. Um sinal = uma vela de entrada. Direção travada NUNCA inverte (só pode ser CANCELADA, e isso aparece na tela). Um relógio só. Aprendizado só com vela FECHADA.
4. Todo texto visível ao usuário final fica em ESPANHOL (LATAM). Comentários e nomes de código ficam como já estão no projeto.
5. Não use bibliotecas novas. Continue em JavaScript ES modules puro, testes com node:test.
6. Ao final de CADA etapa:
   a) rode `npm test` e mostre o resumo (total / pass / fail);
   b) se houver teste vermelho, corrija antes de encerrar; nunca apague nem enfraqueça um teste para ele passar;
   c) faça 1 commit com a mensagem indicada no prompt;
   d) responda com o "RELATÓRIO DE ETAPA": arquivos alterados, o que mudou em cada um, resumo dos testes, e o que o usuário deve testar manualmente.
7. Se encontrar algo que contradiz o relatório (código diferente do descrito, linha que não existe), PARE e me explique antes de improvisar.

Responda apenas "Contexto carregado" com um resumo de 5 linhas do fluxo atual (WebSocket → analyzer → storage → Side Panel). Não altere nada ainda.
```

---

## PROMPT 01 — Linha de base e testes de regressão

```text
ETAPA 01 — Linha de base e testes de regressão. Commit: "test: linha de base e testes de regressão da auditoria"

Objetivo: deixar a suíte confiável e criar testes que provam os bugs antes de corrigi-los.

1) Scripts de teste (package.json):
   - "test": "node --test tests/"
   - Os arquivos test_*.js da raiz testam CÓPIAS de funções, não o código real (relatório P-04). Mova-os para tests/legacy/ e renomeie a extensão para .legacy.js, para NÃO rodarem no `npm test`. Não os apague.

2) Hoje 5 de 55 testes falham:
   - Detectores: Família H
   - EdgeSelector: Decisão por Edge
   - Integração: desconexão/reconexão
   - DataQuality: transições
   - QuantPortfolio: orquestração
   Para cada um, investigue e decida: o código está errado ou o teste está desatualizado? Corrija o lado errado. Não altere a matemática das estratégias (regra 2); se o problema for a matemática, me explique e marque o teste com { todo: "motivo" } em vez de mudá-la. Liste a decisão de cada um no relatório.

3) Crie tests/regression-audit.test.js com os 5 casos abaixo. Primeiro rode e CONFIRME que falham contra o código atual (mostre a saída). Depois marque cada um com { skip: "desbloqueado na ETAPA NN" }, usando o número indicado, para a suíte ficar verde. As próximas etapas removem o skip.

   Caso 1 (ETAPA 02) — T-01: sincronizar o CandleTimer com o horário de abertura da vela não pode deixar o cronômetro em remaining=60. Use um relógio falso: agora = abertura + 29,3 s → remainingSeconds tem de ser 31.
   Caso 2 (ETAPA 04) — A-01: o SignalAuditor não pode liquidar um sinal usando uma vela com closed=false. Registre um CALL na vela T, faça ingest do 1º tick de T+60 (closed=false) e verifique que o sinal continua PENDING.
   Caso 3 (ETAPA 03) — R-04: 30 chamadas de RegimeChangeDetector.evaluate() com as MESMAS velas e features → 0 change points e marketStability igual ao valor inicial.
   Caso 4 (ETAPA 04) — R-01/R-03: simule a virada da vela. A decisão devolve CALL aos 50 s da vela T. Troque a decisão para PUT e mande ticks de T+60 até T+63. A direção exibida continua CALL e existe exatamente 1 evento de sinal novo.
   Caso 5 (ETAPA 06) — I-01/I-02: duas abas (tabId 1 com AUDCAD e tabId 2 com EURUSD) gravam estado e sinal. A função de seleção do Side Panel com boundTabId=2 não pode devolver nenhum dado da aba 1. Nesta etapa, crie só o teste chamando `selectTabView(storageSnapshot, 2)` de src/ui/tab-view-selector.js (o arquivo ainda não existe; por isso o skip).

4) Rode `npm test`. Resultado esperado: 0 falhas; os 5 casos novos aparecem como skipped.

Entregue o RELATÓRIO DE ETAPA.
```

---

## PROMPT 02 — Relógio único e cronômetro correto

```text
ETAPA 02 — Relógio único e cronômetro. Commit: "fix(clock): relógio único de mercado e cronômetro sem reset (T-01,T-02,T-03,T-05)"

Problema: sidepanel.js:546-548 e panel.js:266 chamam candleTimer.syncServerTime(candleTimestamp). O candleTimestamp é a ABERTURA da vela, então o relógio volta para o segundo 0 a cada render e fica travado em 01:00 / EXECUTE.

1) Crie src/utils/market-clock.js com EXATAMENTE este código (já testado):

```js
export class MarketClock {
  constructor({ maxOffsetMs = 3000, alpha = 0.3, now = () => Date.now() } = {}) {
    this.maxOffsetMs = maxOffsetMs;
    this.alpha = alpha;
    this._now = now;
    this.offsetMs = 0;
    this.samples = 0;
  }

  observeCandleOpen(candleOpenSec, receivedAtMs) {
    if (!Number.isFinite(candleOpenSec) || !Number.isFinite(receivedAtMs)) return this.offsetMs;
    const sample = candleOpenSec * 1000 - receivedAtMs;
    if (Math.abs(sample) > this.maxOffsetMs) return this.offsetMs;
    this.offsetMs = this.samples === 0 ? sample : this.offsetMs + this.alpha * (sample - this.offsetMs);
    this.offsetMs = Math.max(-this.maxOffsetMs, Math.min(this.maxOffsetMs, this.offsetMs));
    this.samples += 1;
    return this.offsetMs;
  }

  nowMs() { return this._now() + this.offsetMs; }
  nowSec() { return this.nowMs() / 1000; }
  formingCandleTs(tf) { return Math.floor(this.nowSec() / tf) * tf; }
  secondInCandle(tf) { return Math.floor(this.nowSec()) - this.formingCandleTs(tf); }
  remainingInCandle(tf) { return tf - this.secondInCandle(tf); }
}

export const marketClock = new MarketClock();
```

2) Onde alimentar o relógio:
   - Em src/main/injected-main.js, grave `receivedAt: Date.now()` no envelope ORACLE_MAIN_MARKET_EVENT NO MOMENTO em que a mensagem do WebSocket chega (antes de qualquer parse). Garanta que esse valor chega até a vela normalizada (candle.receivedAt); o normalizador só usa Date.now() se ele faltar.
   - Em src/content/analyzer.js, SUBSTITUA a linha 227 (`candleTimer.syncServerTime(candle.receivedAt || candle.timestamp)`) por: quando o store devolver o status NEW_CANDLE para o par/timeframe ativo, chamar `marketClock.observeCandleOpen(candle.timestamp, candle.receivedAt)`. Em nenhum outro evento.

3) src/utils/candle-timer.js:
   - computeCurrentState() passa a usar marketClock (secondInCandle / remainingInCandle), não mais Date.now() + offset próprio.
   - APAGUE o método syncServerTime e corrija todos os chamadores. Faça uma busca no projeto: não pode sobrar nenhuma chamada syncServerTime.
   - O segundo 0 da vela deixa de ser tratado como "EXECUTE" para qualquer decisão. Por enquanto, a fase no segundo 0 passa a ser "WAIT" (a etapa 04 troca as fases visuais pelo ciclo de vida do sinal).
   - Qualquer código que decide algo pela hora deve calcular o tempo NA HORA com marketClock, nunca usar getState() em cache (P-05: janelas minimizadas atrasam os timers).

4) Side Panel (src/sidepanel/sidepanel.js) e painel da página (src/content/panel.js):
   - Remova as chamadas syncServerTime(candleTimestamp) (sidepanel.js:546-548 e panel.js:266).
   - O analyzer passa a gravar `clockOffsetMs: marketClock.offsetMs` no objeto de estado salvo no storage.
   - No Side Panel, crie uma instância local `new MarketClock()` e, a cada estado recebido, faça `clock.offsetMs = state.clockOffsetMs ?? 0`.
   - Separe o cronômetro do render completo: um setInterval de 250 ms que SÓ atualiza o texto do cronômetro e a barra de progresso, usando clock.remainingInCandle(60). O renderState completo continua disparando por mudança de storage, mas não mexe mais no relógio.

5) Sons de contagem (T-05): remova os pips disparados quando remainingSeconds === 60 (sidepanel.js:682-688 e analyzer.js:42-52). Nesta etapa, fica SEM pip de contagem; a etapa 06 recoloca o som nos momentos certos.

6) Testes:
   - Remova o skip do Caso 1 em tests/regression-audit.test.js.
   - Crie tests/market-clock.test.js:
     a) offset estimado pela virada: abertura = 1700000040, receivedAt = abertura*1000 + 350 → offsetMs = -350, e secondInCandle(60) = 0;
     b) amostra fora de ±3000 ms é ignorada;
     c) 29 s depois → secondInCandle = 29 e remainingInCandle = 31;
     d) EMA: segunda amostra move o offset 30% em direção à nova amostra.
   - Ajuste tests/candle-timer.test.js para o novo contrato (sem syncServerTime).

Aceite: com o Side Panel aberto por 3 minutos, o cronômetro desce de 59 para 0 todo minuto, alinhado com o gráfico (±1 s), sem voltar para 01:00. Nenhum pip toca.

Entregue o RELATÓRIO DE ETAPA.
```
