# PROMPT — Aplicar a identidade INFLITRUS "Interceptor" na extensão

> **Como usar:** coloque estes 3 arquivos no repositório da extensão e cole no Antigravity o bloco da seção 0.
> - `docs/PROMPT-ANTIGRAVITY-IDENTIDADE.md` (este arquivo)
> - `docs/INFLITRUS-IDENTIDADE-VISUAL.md` (manual da marca, fonte da verdade)
> - `docs/reference/inflitrus-interceptor-board.png` (prancha visual de referência)

---

## 0. Prompt curto (copie e cole no Antigravity)

```
Você vai fazer o rebranding visual completo da extensão Chrome "Oracle Quant" para
"INFLITRUS SIGNALS", conceito "Interceptor".

Leia ANTES de escrever qualquer código, nesta ordem:
1. docs/PROMPT-ANTIGRAVITY-IDENTIDADE.md  (escopo, regras e fases desta tarefa)
2. docs/INFLITRUS-IDENTIDADE-VISUAL.md    (manual da marca: cores, fontes, componentes, estados, textos)
3. docs/reference/inflitrus-interceptor-board.png (referência visual do painel)

Regra de ouro: esta é uma tarefa SÓ DE CAMADA VISUAL. Não altere captura de dados,
normalização, CandleStore, sincronização, indicadores, motores, estratégia,
deduplicação nem persistência. A UI apenas LÊ o estado que já existe.

Execute as fases 1 a 8 da seção 6 em ordem. Ao fim de cada fase, rode a extensão,
confira o critério de "pronto" da fase e só então avance. No final, preencha o
checklist da seção 9 e me entregue o relatório pedido na seção 10.

Todo texto visível ao usuário deve ficar em ESPANHOL neutro LATAM, sem mistura com português.
```

---

## 1. Objetivo

Trocar a aparência e a arquitetura de informação do painel atual (Oracle Quant, azul-escuro com amarelo, tudo com o mesmo peso) pela identidade **INFLITRUS SIGNALS — Interceptor**:

- fundo Petroleum, marca em Teal de osciloscópio, alertas em Âmbar, PUT em Coral;
- a **onda** como elemento principal (ruído → análise → frequência fixada);
- **um único elemento grande** na tela (o núcleo do sinal);
- os 14 estados técnicos resumidos em **5 estados visíveis**;
- dados técnicos (motores, feed, logs) recolhidos em abas.

O resultado precisa ficar igual, em espírito e em detalhe, à prancha `inflitrus-interceptor-board.png`.

---

## 2. Escopo

### 2.1 PODE alterar
- Tudo em `src/content/signal-panel.js`, `src/content/panel.css` (ou os equivalentes reais do repositório)
- `src/popup/*` (HTML, CSS, JS de apresentação)
- Textos e ícone das notificações em `src/background/notifications.js`
- `manifest.json`: `name`, `short_name`, `description`, `icons`, `action.default_icon`, `action.default_title`, `web_accessible_resources` (só para fontes e ícones)
- Criar novos arquivos de UI em `src/ui/` (ver seção 5)
- Assets novos em `assets/` (fontes, ícones, logo SVG)

### 2.2 NÃO PODE alterar (quebra a lógica)
- `src/main/*` (observadores, sanitizer)
- `src/market/*`, `src/indicators/*`, `src/strategy/*`
- Formato dos objetos `Signal`, `Candle` e dos eventos entre contextos
- **Chaves do `chrome.storage.local` e nome do banco IndexedDB.** Mantenha os nomes atuais para o usuário não perder configurações e histórico. Se quiser renomear, crie uma migração que lê a chave antiga e grava a nova, sem apagar nada até a próxima versão.
- Permissões e `host_permissions` do manifest (não adicione novas)

Se, para exibir algo, faltar um dado que o motor não expõe, **não recalcule na UI**. Crie um seletor/adaptador somente leitura (seção 5.2) e anote no relatório final.

---

## 3. Primeiro passo obrigatório: auditoria

Antes de mudar qualquer arquivo:

1. Liste a estrutura real do repositório e encontre:
   - onde o painel é criado e injetado;
   - onde está o CSS do painel;
   - onde o estado da máquina (BOOTING ... ERROR) é lido pela UI;
   - onde ficam os sinais gravados, WR, os 5 motores, Prob/Edge/Qual/BE, pressão de ticks, regime, payout, integridade do feed e logs;
   - onde o popup e as notificações são montados;
   - todos os textos visíveis ao usuário (procure por strings em português: "Aguardar", "Ativo", "Preço", "Próxima vela", "Sinais gravados", "Dados de mercado", "Integridade", "Copiar", "Limpar", "Barra Lateral Adaptada", "Oracle", etc.).
2. Crie `docs/AUDITORIA-UI.md` com uma tabela `elemento atual → arquivo/linha → fonte do dado → novo destino` (use a seção 7 como guia).
3. Só depois comece a fase 1.

---

## 4. Regras de marca (resumo, o manual manda)

| Regra | Valor |
|---|---|
| Nome | `INFLITRUS` + descritor `SIGNALS` (menor, espaçado, Teal). Texto corrido: "Inflitrus" |
| Cores (só estas 6) | Petroleum `#0B1A1F` · Teal `#3FE0C5` · Steel `#8A9BA3` · Amber `#F2A93B` · Ice `#E6EEF0` · Coral `#FF5A6E` |
| Variações | apenas transparências dessas 6 (tokens `--ifx-surface-*`, `--ifx-*-soft`, `--ifx-border*`) |
| Fontes (só estas 2) | Space Grotesk (500/700) para display · JetBrains Mono (400/500/700) para dados e interface |
| CALL | Teal + `▲` + palavra `CALL` |
| PUT | Coral + `▼` + palavra `PUT` |
| Glow | só em 3 lugares: linha de frequência fixada, direção do sinal, anel do timer com sinal ativo |
| Números | sempre `font-variant-numeric: tabular-nums` |
| Tamanho mínimo de texto | 11px só em rótulos caixa alta; leitura ≥ 14px |
| Idioma | espanhol neutro LATAM em 100% da UI |
| Rodapé fixo | `Inflitrus detecta. Tú decides.` |
| Ícones | linha 1.5px (Lucide como referência, embutidos como SVG inline), nunca emoji |

Tokens CSS completos: seção **16.1** do manual. Copie exatamente.

---

## 5. Arquitetura da nova camada de UI

### 5.1 Estrutura sugerida (adapte aos nomes reais do repo)

```
src/ui/
├── tokens.css              # :host { --ifx-* } copiado do manual 16.1
├── base.css                # reset dentro do shadow root, tipografia, scanlines
├── fonts.js                # carrega as fontes via FontFace (ver 5.4)
├── i18n/es.js              # todos os textos visíveis + tradução de reasons
├── view-model.js           # adaptador: estado do motor -> estado visual (5 estados)
├── components/
│   ├── header.js
│   ├── wave.js             # a onda (canvas)
│   ├── core.js             # núcleo: estado, direção, validade, anel
│   ├── timer-ring.js
│   ├── checklist.js
│   ├── context-row.js      # PRECIO · PAYOUT · FEED
│   ├── tabs.js             # acordeão Registro / Mercado / Sistema
│   ├── tab-registro.js
│   ├── tab-mercado.js
│   ├── tab-sistema.js
│   ├── footer.js
│   ├── mini-pill.js
│   └── first-run.js        # aviso legal na primeira execução
├── icons.js                # SVGs inline (pulso, doc, barras, engrenagem, som, minimizar, check, círculo, x)
└── sound.js                # sons gerados por Web Audio (ver 5.6)
assets/
├── fonts/                  # SpaceGrotesk-*.woff2, JetBrainsMono-*.woff2 + OFL.txt
├── logo/                   # inflitrus-horizontal.svg, inflitrus-symbol.svg
└── icons/                  # icon-16.png, icon-32.png, icon-48.png, icon-128.png
```

Não é obrigatório usar framework. Se o painel atual é JS puro, mantenha JS puro; só separe em módulos.

### 5.2 `view-model.js` (o coração da tarefa)

Função pura que recebe o estado atual já existente e devolve o que a UI precisa. A UI renderiza **somente** a partir dele.

```js
// forma esperada (ajuste aos campos reais)
{
  visualState: 'CONECTANDO' | 'CALIBRANDO' | 'ESCANEANDO' | 'SENAL' | 'BLOQUEADO',
  technicalState: 'READY' | 'STALE' | ...,
  statusDot: 'teal' | 'amber' | 'coral',
  asset: 'AUDCAD_OTC', timeframe: 'M1',
  wave: 'noise' | 'analyzing' | 'locked' | 'flat' | 'broken',
  whisper: 'Ruido de mercado. Sin señal.',
  title: 'ESCANEANDO',
  signal: null | {
    direction: 'CALL' | 'PUT',
    phase: 'prealert' | 'live' | 'expired',
    validForSec: 5, validRemainingSec: 3,
  },
  countdown: { secondsToCandleClose: 37, progress: 0.38 },
  calibration: null | { have: 97, need: 150 },
  checklist: [{ label: 'EMA 9 cruzó EMA 21', status: 'ok' | 'pending' | 'fail' }],
  context: { price: '0.89421', payout: 92, feed: 'Estable' | 'Inestable' | 'Sin datos' },
  registro: { winRate: 64.3, wins: 9, losses: 5, rows: [...] },
  mercado: { ...indicadores, motores, prob, edge, qual, be, presionTicks, regimen },
  sistema: { websocket, historico, gaps, estadoTecnico, logs },
}
```

Mapeamento de estados (manual, seção 10):

| Técnico | `visualState` | Ponto | Onda | Título | Sussurro |
|---|---|---|---|---|---|
| BOOTING, WAITING_FOR_FRAME, CONNECTING | CONECTANDO | amber (pulsando) | flat (tracejada) | `INFILTRÁNDOSE` | `Buscando la transmisión…` |
| SYNCING_HISTORY, SYNCING_REALTIME | CALIBRANDO | amber | noise baixo | `CALIBRANDO` | `{have}/{need} velas sincronizadas.` + barra Âmbar |
| READY, CANDLE_UPDATING, CANDLE_CLOSED sem sinal | ESCANEANDO | teal | noise + retícula de radar | `ESCANEANDO` | `Ruido de mercado. Sin señal.` |
| Sinal BUY/SELL válido | SENAL | teal | locked | `SEÑAL INTERCEPTADA` | `Transmisión interceptada.` |
| STALE | BLOQUEADO | amber | broken | `SEÑAL BLOQUEADA` | `Datos congelados. No operar.` |
| DATA_GAP | BLOQUEADO | amber | broken | `SEÑAL BLOQUEADA` | `Faltan velas. Recalibrando…` |
| INVALID_DATA | BLOQUEADO | amber | broken | `SEÑAL BLOQUEADA` | `Datos inválidos detectados.` |
| FORMAT_CHANGED | BLOQUEADO | amber | broken | `SEÑAL BLOQUEADA` | `La plataforma cambió. Revisando…` |
| RECONNECTING | BLOQUEADO | amber | broken | `SEÑAL BLOQUEADA` | `Señal perdida. Reconectando…` |
| ERROR | BLOQUEADO | coral | broken | `SEÑAL BLOQUEADA` | `Error interno. Revisa Sistema.` |

Mapeamento de ação: `BUY → CALL ▲`, `SELL → PUT ▼`, `WAIT → ESCANEANDO`, `NO DATA → BLOQUEADO`. Não altere os valores internos, só a exibição.

Subestados do sinal:
- **prealert:** últimos segundos da vela, quando o motor já indica que um padrão está se formando (use o dado existente, se houver; se não houver, pule esse subestado e anote no relatório). Texto `Patrón detectado. Validando…`, onda em `analyzing`, borda Teal 20%.
- **live:** sequência de revelação (fase 5) + som + notificação.
- **expired:** tudo em Steel, direção riscada, sem glow, texto `Ventana cerrada.`. Volta para ESCANEANDO na próxima vela.

### 5.3 Shadow DOM
- O painel inteiro vive num `attachShadow({ mode: 'closed' })` num host único (`<inflitrus-panel>` ou `div#inflitrus-root`).
- `tokens.css` e `base.css` são injetados dentro do shadow root (via `<style>` ou `adoptedStyleSheets`).
- Nenhum CSS da corretora pode vazar para dentro, e nenhum CSS da extensão pode vazar para fora.
- Manter o comportamento atual de **recriar o painel** se a página remover o host, preservando o estado.

### 5.4 Fontes (atenção, detalhe importante)
- Baixe Space Grotesk (500, 700) e JetBrains Mono (400, 500, 700) em `.woff2`, ambas licença OFL. Inclua `assets/fonts/OFL.txt`.
- **`@font-face` declarado dentro de um shadow root não é aplicado pelo Chrome.** Não faça isso.
- Carregue pelo content script usando a API `FontFace` com **ArrayBuffer**, para não depender do CSP `font-src` da corretora:
  ```js
  const buf = await (await fetch(chrome.runtime.getURL('assets/fonts/SpaceGrotesk-Bold.woff2'))).arrayBuffer();
  const face = new FontFace('Space Grotesk', buf, { weight: '700', display: 'swap' });
  await face.load(); document.fonts.add(face);
  ```
- Adicione `assets/fonts/*` em `web_accessible_resources` restrito aos domínios `traderoom.b2trading.io` e `chart.b2trading.io`.
- Fallback: `system-ui` e `ui-monospace` (já nos tokens). O painel deve continuar legível se a fonte falhar.
- No popup, fontes via `@font-face` normal em `popup.css` apontando para `../../assets/fonts/...`.
- Nunca carregar do Google Fonts.

### 5.5 A onda (`wave.js`)
Especificação completa no manual, seção 6. Resumo:
- `<canvas>` de 72px de altura no painel (24px na pílula), com `devicePixelRatio` para ficar nítido.
- Até 60 pontos, traço 1.5px, pontas arredondadas, máx. 30fps (`requestAnimationFrame` com limitador).
- Layout padrão: ruído à esquerda, **linha vertical de interceptação** (1px Teal com brilho 6px), estado atual à direita, como na prancha.
- Estados: `noise` (Steel 60%, caótica), `analyzing` (amplitude caindo, Steel→Teal), `locked` (linha reta Teal com glow), `flat` (tracejada Steel), `broken` (linha interrompida com lacunas, Âmbar 70%).
- A onda é **simbólica**: a amplitude reflete o estado, não o preço.
- Pausar quando `document.hidden` e quando o painel estiver minimizado.
- `prefers-reduced-motion: reduce` → desenho estático do estado atual.

### 5.6 Som (`sound.js`)
Sem arquivos de áudio; gere com Web Audio API (`OscillatorNode` + `GainNode`):
- **Sinal:** 2 bipes ascendentes curtos, tipo sonar (~880Hz → ~1320Hz, ~110ms cada, envelope suave), total ~250ms.
- **Bloqueio:** 1 tom grave curto (~220Hz, ~180ms).
- **Conectado:** ruído branco curto que diminui (~200ms).
- Volume padrão 60%, respeitar a preferência de som já existente.
- Se o `AudioContext` estiver suspenso (autoplay), não quebre: o fallback é o glow + a borda do painel.

### 5.7 `i18n/es.js`
- Todas as strings visíveis ficam aqui, nenhuma solta nos componentes.
- As `reasons` do motor podem vir em português. Crie um mapa de tradução **só na UI** com fallback:
  | Original (exemplo) | Exibir |
  |---|---|
  | `EMA 9 cruzou acima da EMA 21` | `EMA 9 cruzó EMA 21` |
  | `EMA 9 cruzou abaixo da EMA 21` | `EMA 9 cruzó bajo EMA 21` |
  | `RSI acima de 50` | `RSI > 50` |
  | `RSI abaixo de 50` | `RSI < 50` |
  | `Candle confirmado` | `Vela confirmada` |
  | `Confluência (x/5)` | `Confluencia (x/5)` |
  | `Regressão Logística` | `Regresión logística` |
  | não mapeado | exibe o original e registra `console.warn('[inflitrus] i18n faltando: ...')` só em modo dev |

---

## 6. Fases de execução

### Fase 1 — Fundação visual
- Criar `tokens.css`, `base.css`, `fonts.js`, `icons.js`, `i18n/es.js`.
- Migrar o host do painel para Shadow DOM fechado (se ainda não for).
- Fundo Petroleum, scanlines sutis (`repeating-linear-gradient` com `--ifx-scanline`, 1px a cada 3px), raio 16px, borda 1px `--ifx-border`, sombra `0 12px 40px rgba(0,0,0,0.45)`.
- Largura 320px (mín. 288, máx. 360), padding 16px, gap 12px entre blocos.

**Pronto quando:** o painel antigo aparece com fundo, bordas e fontes novas, sem nenhum estilo da corretora vazando, e as fontes carregam dentro da página da B2Trading (confirmar no DevTools → Rendered Fonts).

### Fase 2 — `view-model.js` e textos
- Implementar o adaptador da seção 5.2 lendo o estado real.
- Substituir todos os textos por chaves do `es.js`.

**Pronto quando:** existe um log de dev (`[inflitrus] vm`) mostrando o objeto correto em cada estado, e nenhuma string em português aparece na UI.

### Fase 3 — Header, núcleo, onda e anel
- **Header (48px):** `[pulso] INFLITRUS SIGNALS` · `● AUDCAD_OTC · M1` · `[engrenagem]` `[minimizar]`. O ativo aparece **só aqui**.
  - A engrenagem abre um menu com as funções do header antigo: Sonido (on/off), Lado (Izquierda/Derecha, substitui "Dir"), Modo (Estándar/Mini, substitui "Adaptado").
- **Núcleo:** onda (72px) → sussurro → título → direção (`signal-xl` 48px, só em SENAL) → `Válida por 0:05` → **anel de contagem** 72px à direita.
  - Sem sinal: o anel mostra os **segundos até o fechamento da vela** (substitui "Próxima vela M1 00:37" e a barra azul), progresso em Steel.
  - Com sinal: o anel mostra a validade, progresso Teal com glow, Âmbar nos últimos 2s.
  - CALIBRANDO: no lugar da direção, barra de progresso Âmbar `97/150 velas sincronizadas.`
  - Retícula de radar (círculo + cruz, Steel 6%) atrás do núcleo só em ESCANEANDO.

**Pronto quando:** os 5 estados visíveis podem ser forçados (crie um modo de pré-visualização `?ifx-debug=1` ou um atalho no Sistema) e cada um bate com a tabela da seção 5.2 e com a prancha.

### Fase 4 — Checklist, linha de contexto, abas e rodapé
- **Checklist:** até 3 linhas vindas das `reasons` do sinal (ou dos motores confirmados). Se houver mais, mostrar as 3 principais + `+2 más` que abre a aba Mercado. Ícones: `✓` Teal (ok), `○` Steel (pendente), `×` Coral (falhou). Em ESCANEANDO, mostrar as condições da estratégia principal como pendentes/parciais.
- **Linha de contexto:** `PRECIO ACTUAL` | `PAYOUT` | `FEED ● Estable`. Clique no payout abre o seletor atual (70/80/85/90) como chips pequenos; a lógica do payout continua a mesma.
- **Abas (acordeão, uma aberta por vez, fechadas por padrão):** conteúdo na seção 7.
- **Rodapé fixo:** `Inflitrus detecta. Tú decides.`

**Pronto quando:** tudo o que existia no painel antigo continua acessível (nenhum dado perdido), mas a tela inicial mostra só header, núcleo, checklist, contexto, abas fechadas e rodapé.

### Fase 5 — Movimento e som
- Sequência de revelação do sinal (manual 11.3): onda colapsa (0ms, 300ms) → pulso na linha de interceptação (200ms) → título com fade + subida de 4px (300ms) → direção com glow crescente (400ms) → anel começa (500ms) → borda do painel vira `--ifx-border-strong` enquanto o sinal vale.
- Transições gerais com `--ifx-fast` / `--ifx-base` e `--ifx-ease`. Só `transform` e `opacity`.
- Ponto de status em CONECTANDO pulsa (opacity 0.4 ↔ 1, 1.2s).
- Integrar `sound.js` aos eventos: sinal live, entrada em BLOQUEADO, conectado.
- `prefers-reduced-motion`: sem onda animada, sem pulso, sem subida; troca instantânea e glow estático.

**Pronto quando:** um sinal simulado dispara a sequência completa uma única vez, com um som; e com movimento reduzido ativado no sistema nada se move.

### Fase 6 — Pílula mini e posicionamento
- **Pílula (240 × 56px, raio total):** `[pulso] AUDCAD_OTC · M1 ●` + `CALL ▲` (ou mini-onda de 24px sem sinal) + anel de 32px. Clique expande.
- Minimizar no header vira a pílula (substitui o comportamento atual de minimizar).
- Arrastável, encaixa à esquerda ou à direita, lembra a posição (use a chave de posição que já existe).
- Nunca cobrir os controles de ordem da corretora: detectar a área deles e reposicionar se houver colisão.

**Pronto quando:** alternar entre painel e pílula mantém o estado, e a posição persiste após recarregar.

### Fase 7 — Popup, ícones, notificações e manifest
- **Ícones da extensão:** símbolo de pulso Teal sobre quadrado Petroleum com raio de 22%. Gerar 16/32/48/128px a partir do SVG (no de 16px, traço mais grosso). Badge: ponto Teal = sinal ativo, Âmbar = dados instáveis (`chrome.action.setBadgeBackgroundColor` + texto `•`).
- **Popup (360 × ~420px):** logo horizontal, `● Activo · Escuchando el mercado…` (ou estado atual), mini-onda, ativo atual, `● Datos estables`, interruptores de Activo / Sonido / Notificaciones, licença. **O sinal nunca aparece no popup.**
- **Notificação:** título `Señal interceptada · CALL ▲` (ou `PUT ▼`), corpo `AUDCAD_OTC · M1 · Válida por 5s`, ícone 128px. Sinal atrasado não notifica (regra já existente, não mexer).
- **Manifest:** `name: "Inflitrus Signals"`, `short_name: "Inflitrus"`, `description: "Escucha el mercado. Encuentra la señal. Herramienta de análisis técnico para B2Trading. No ejecuta operaciones."`, `default_title: "Inflitrus Signals"`, novos ícones.

**Pronto quando:** o ícone, o popup e uma notificação de teste seguem o manual, e nenhum lugar mostra "Oracle Quant".

### Fase 8 — Primeira execução e limpeza
- **Primeira execução:** 3 telas dentro do painel (não em nova aba):
  1. `Abre un gráfico en B2Trading.`
  2. `Inflitrus se conecta y calibra.`
  3. `Espera la señal. Tú decides.` + aviso legal (abaixo) + botão `Entendido`.
  Guardar o aceite no `chrome.storage.local` (chave nova, ex.: `ifx_onboarding_v1`).
  > Inflitrus Signals es una herramienta de análisis técnico. No ejecuta operaciones ni garantiza resultados. Operar implica riesgo de pérdida. Tú decides.
- Remover CSS e strings antigos não usados (sem mexer em lógica).
- Buscar e eliminar qualquer "Oracle", "Quant", "Portfólio Quantitativo", "Barra Lateral Adaptada" restante na UI.
- Remover logs de dev `[inflitrus] vm` ou deixá-los atrás de uma flag de debug.

**Pronto quando:** instalação limpa mostra o onboarding uma vez, e a busca global por "Oracle" não encontra nada visível ao usuário.

---

## 7. De → Para (painel atual → novo painel)

| Elemento atual (print Oracle Quant) | Novo destino |
|---|---|
| `ORACLE QUANT` + ícone | Header: `[pulso] INFLITRUS SIGNALS` |
| Botão de som | Menu da engrenagem → `Sonido` |
| Botão `Adaptado` | Menu da engrenagem → `Modo: Estándar / Mini` |
| Botão `Dir` | Menu da engrenagem → `Lado: Izquierda / Derecha` |
| Botão `▶` (minimizar) | Botão minimizar → pílula |
| `PRÓXIMA VELA M1 00:37` + barra azul | Anel de contagem no núcleo |
| `Análise probabilística em tempo real` | Removido (o sussurro do núcleo cumpre o papel) |
| `Payout Líquido 70/80/85/90` | Chip `PAYOUT` na linha de contexto → seletor ao clicar |
| Cartão `SINAL QUANTITATIVO M1` / `AGUARDAR MERCADO` | Núcleo (título + direção + validade) |
| `Aguardando confluência e edge favorável` | Sussurro do estado (ex.: `Ruido de mercado. Sin señal.`) |
| Ativo / Preço / Payout dentro do cartão | Ativo → header · Preço e Payout → linha de contexto |
| `Prob 50% · Edge 0% · Qual 50% · BE 55.6%` | Aba **Mercado** → bloco `Lectura cuantitativa` (Prob., Edge, Calidad, Break-even) |
| `Coletando dados M1 (97/15 velas)` | Estado CALIBRANDO (barra Âmbar) |
| `Pressão Ticks` / `Regime STABLE` | Aba **Mercado** → `Presión de ticks` / `Régimen: Estable` |
| `OS 5 MOTORES PROBABILÍSTICOS M1` | Aba **Mercado** → `Motores (5)` com status de cada um; os confirmados alimentam o checklist |
| `SINAIS GRAVADOS (15)` + `WR 64.3% (9V/5D)` | Aba **Registro** → título `Registro · 64,3%`; resumo `9 W · 5 L`; tabela `HORA · DIR. · ESTRATEGIA · RESULTADO` com `CALL ▲`/`PUT ▼`, `WIN +0.8` (Teal), `LOSS -1` (Coral), `Pendiente` (Âmbar) |
| `DADOS DE MERCADO` (Ativo, Timeframe, Último preço, Último candle) | Ativo/TF → header · Preço → contexto · Último candle e idade do dado → aba **Mercado** |
| `INTEGRIDADE DO FEED` (WebSocket, Histórico, Gaps, Estado da máquina) | Chip `FEED` no contexto (resumo) · detalhes na aba **Sistema** |
| `LOGS EM TEMPO REAL` + Copiar/Limpar | Aba **Sistema** → `Registros técnicos` + `Copiar` / `Limpiar` |
| Rodapé `Barra Lateral Adaptada · Portfólio Quantitativo` | `Inflitrus detecta. Tú decides.` |

Conteúdo das abas:
- **Registro:** resumo (taxa de acerto, W/L), tabela das últimas 20 entradas com rolagem interna, estado vazio `Aún no hay señales interceptadas.`
- **Mercado:** EMA 9, EMA 21, RSI 14, `Lectura cuantitativa`, `Motores (5)`, `Presión de ticks`, `Régimen`, `Última vela`, `Edad del dato`.
- **Sistema:** `WebSocket`, `Histórico`, `Gaps`, `Estado técnico` (nome técnico cru, ex.: `RECONNECTING`, em JetBrains Mono Steel), `Registros técnicos` com `Copiar` e `Limpiar`, e o modo de pré-visualização de estados (só em debug).

---

## 8. Critérios visuais (compare com a prancha)

- Só **um** elemento grande: o núcleo. Nada mais passa de 20px, exceto a direção (48px) e o número do anel (22px).
- Teal ocupa **menos de 10%** da área do painel em ESCANEANDO.
- Rótulos em JetBrains Mono 11px, caixa alta, tracking +18%, Steel.
- Valores em JetBrains Mono 18px, Ice (payout em Teal).
- Cartões internos: `--ifx-surface-1`, raio 10px, borda `--ifx-border`.
- Divisórias de 1px `--ifx-border` entre as colunas da linha de contexto e entre as abas.
- Nenhum gradiente decorativo, nenhum orbe, nenhuma "chuva Matrix", nenhum emoji.
- Contraste mínimo AA (a paleta já garante sobre Petroleum; não coloque texto Steel sobre superfícies Teal).

---

## 9. Checklist final (preencha e cole no relatório)

- [ ] Nenhum arquivo de `main/`, `market/`, `indicators/`, `strategy/` alterado
- [ ] Chaves de storage e IndexedDB preservadas (ou migradas sem perda)
- [ ] Nenhuma permissão nova no manifest
- [ ] Painel em Shadow DOM fechado, sem vazamento de CSS
- [ ] Fontes carregando via FontFace + ArrayBuffer dentro da B2Trading
- [ ] Só as 6 cores oficiais e suas transparências
- [ ] Só Space Grotesk + JetBrains Mono
- [ ] Números com `tabular-nums`
- [ ] 100% da UI em espanhol; zero "Oracle"/"Quant" visível
- [ ] 14 estados técnicos → 5 estados visíveis, conforme a tabela 5.2
- [ ] Direção sempre com cor + seta + palavra
- [ ] Glow só nos 3 lugares permitidos
- [ ] O ativo aparece só no header
- [ ] Sequência de revelação funciona e dispara uma vez por sinal
- [ ] Onda pausa com aba oculta e painel minimizado
- [ ] `prefers-reduced-motion` respeitado
- [ ] Som com fallback visual se o áudio for bloqueado
- [ ] Pílula mini, arrastar, lado esquerdo/direito e posição persistente
- [ ] Painel não cobre os controles de ordem
- [ ] Painel é recriado se a página removê-lo, mantendo o estado
- [ ] Popup sem sinal; notificação com o texto novo
- [ ] Ícones 16/32/48/128 novos
- [ ] Onboarding com aviso legal aparece uma vez
- [ ] Rodapé `Inflitrus detecta. Tú decides.` presente
- [ ] Testes existentes continuam passando

---

## 10. Relatório de entrega

Ao terminar, responda com:
1. Lista de arquivos criados, alterados e removidos.
2. Checklist da seção 9 preenchido.
3. Capturas (ou descrição precisa) dos 5 estados visíveis + pílula + popup.
4. Dados que a UI precisou e o motor não expunha (e como foi resolvido sem alterar a lógica).
5. Qualquer desvio do manual e o motivo.
