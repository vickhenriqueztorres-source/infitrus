# INFLITRUS SIGNALS — Manual de Identidade Visual

  

**Conceito aprovado:** Concepto 2 — INTERCEPTOR

**Produto:** extensão Chrome de leitura de sinais para B2Trading (público LATAM)

**Idioma da interface e da comunicação:** espanhol

**Referência visual oficial:** `docs/reference/inflitrus-interceptor-board.png`

  

> Este documento é a fonte da verdade da marca. Qualquer tela, anúncio, landing page ou asset deve obedecer às regras abaixo. Em caso de conflito entre a prancha e este manual, **vale o manual**.

  

---

  

## 1. Essência da marca

  

### 1.1 Big Idea

**"El mercado habla. Nosotros escuchamos distinto."**

  

O mercado é uma transmissão cheia de ruído. A Inflitrus é o interceptor: sintoniza, filtra e só entrega quando a frequência está limpa. A fantasia é de espionagem de sinais (radiotelescópio, osciloscópio, sala de escuta). Não há invasão real da corretora; a infiltração é **narrativa e visual**.

  

### 1.2 Promessa

Menos ruído. Mais leitura. A decisão continua sendo do usuário.

  

### 1.3 Posicionamento

> Una inteligencia infiltrada en la lectura del mercado.

  

Não é "outra IA de sinais". É um instrumento de escuta disciplinado, que **prefere ficar calado a entregar um sinal ruim**.

  

### 1.4 Personalidade

| É | Não é |

|---|---|

| Silenciosa, precisa, fria | Barulhenta, eufórica |

| Técnica, confiável | "Hacker de filme" caricato |

| Disciplinada (espera confirmação) | Apostadora, "ganhe fácil" |

| Misteriosa, sóbria | Neon Matrix, verde-limão piscando |

| Instrumento profissional | Cassino, luzes, promessas de lucro |

  

### 1.5 Assinaturas oficiais

- **Principal:** `Inflitrus detecta. Tú decides.` (vai no rodapé do painel, sempre)

- **Institucional:** `Escucha el mercado. Encuentra la señal.`

- **Curta:** `Detecta lo que otros pasan por alto.`

- **Manifesto:** `El mercado habla. Nosotros escuchamos distinto.`

- **Técnica (cyber):** `INFLITRUS // INSIDE THE MARKET`

  

---

  

## 2. Nome e hierarquia

  

- **INFLITRUS** = a entidade (marca principal, peso máximo)

- **SIGNALS** = o que ela entrega (descritor, peso mínimo)

  

Regras:

- SIGNALS **nunca** tem o mesmo peso ou tamanho de INFLITRUS.

- SIGNALS fica sempre abaixo, alinhado à direita do wordmark, em letras espaçadas.

- No texto corrido: "Inflitrus" (só a inicial maiúscula). Em títulos e logo: "INFLITRUS".

- Nunca abreviar para "IS", "Inflit" ou similares.

  

---

  

## 3. Logotipo

  

### 3.1 Construção

O **"I" inicial é o símbolo**: uma linha de frequência horizontal que dispara num pulso vertical agudo (como um batimento ou uma interceptação num osciloscópio) e volta a ficar plana. O pulso substitui o "I" de INFLITRUS.

  

```

  ──╱╲  ╱── NFLITRUS

      ╲╱        S I G N A L S

```

  

- **Símbolo (pulso):** traço de espessura igual à haste das letras, pontas arredondadas, cor Teal.

- **Wordmark "NFLITRUS":** Space Grotesk Bold, caixa alta, tracking +2%, cor Gelo (texto claro) com leve gradiente vertical metálico **apenas** no logo principal de marketing. Na interface o wordmark é sólido.

- **Descritor "SIGNALS":** JetBrains Mono Medium, caixa alta, tracking +60% (bem espaçado), cor Teal, altura ≈ 35% da altura do wordmark.

  

### 3.2 Versões

| Versão | Uso |

|---|---|

| **Horizontal completa** (pulso + INFLITRUS + SIGNALS) | Landing, header do painel, Chrome Web Store, anúncios |

| **Horizontal sem descritor** | Espaços com menos de 120px de largura |

| **Símbolo isolado** (só o pulso) | Ícone da extensão, favicon, pílula mini, avatar de redes, marca d'água |

| **Monocromática Teal** | Fundos escuros com muita informação |

| **Monocromática Gelo** | Vídeos, fotos, overlays |

| **Monocromática Petróleo** | Raros usos sobre fundo claro (impressos, documentos) |

  

### 3.3 Área de proteção

Margem mínima em volta do logo = **altura do "N"** em todos os lados. Nada entra nessa área.

  

### 3.4 Tamanhos mínimos

- Logo horizontal: **96px** de largura na tela (sem descritor abaixo de 120px)

- Símbolo: **16px** (ícone da extensão)

  

### 3.5 Brilho (glow)

- O pulso pode ter um brilho suave: `drop-shadow(0 0 8px rgba(63,224,197,0.45))`.

- O wordmark **nunca** tem glow.

- Na interface o glow do logo fica desligado; ele é reservado ao momento do sinal (ver seção 8).

  

### 3.6 Usos proibidos

- Esticar, inclinar, rotacionar ou distorcer

- Trocar o Teal do pulso por outra cor

- Colocar o logo sobre fundo claro poluído ou foto sem contraste

- Adicionar contorno, sombra dura, bisel, 3D ou gradiente arco-íris

- Separar o pulso do wordmark numa distância maior que a original

- Escrever "SIGNALS" maior ou mais pesado que "INFLITRUS"

- Animar o logo inteiro de forma contínua (só o pulso pode animar, e só em momentos-chave)

  

---

  

## 4. Cores

  

### 4.1 Paleta núcleo (4 cores da prancha)

| Token | Nome | HEX | RGB | Papel |

|---|---|---|---|---|

| `--ifx-petroleum` | Petroleum Blue | `#0B1A1F` | 11, 26, 31 | Fundo, a "noite" da escuta |

| `--ifx-teal` | Oscilloscope Teal | `#3FE0C5` | 63, 224, 197 | Cor da marca, frequência limpa, **CALL** |

| `--ifx-steel` | Steel Gray | `#8A9BA3` | 138, 155, 163 | Texto secundário, rótulos, ruído |

| `--ifx-amber` | Amber | `#F2A93B` | 242, 169, 59 | Alertas, calibração, bloqueio |

  

### 4.2 Cores funcionais (2 complementares)

| Token | Nome | HEX | Papel |

|---|---|---|---|

| `--ifx-ice` | Ice | `#E6EEF0` | Texto principal, números grandes |

| `--ifx-coral` | Signal Coral | `#FF5A6E` | **PUT**, LOSS, erro crítico |

  

> Paleta total: **6 cores**. Não adicionar nenhuma nova. Variações (superfícies, bordas, hovers) são **transparências** destas cores, não cores novas.

  

### 4.3 Superfícies derivadas (transparências)

| Token | Valor | Uso |

|---|---|---|

| `--ifx-surface-0` | `#0B1A1F` | Fundo do painel |

| `--ifx-surface-1` | `rgba(138,155,163,0.06)` | Cartões internos (checklist, contexto) |

| `--ifx-surface-2` | `rgba(138,155,163,0.10)` | Hover, abas ativas |

| `--ifx-border` | `rgba(138,155,163,0.18)` | Bordas 1px padrão |

| `--ifx-border-strong` | `rgba(63,224,197,0.35)` | Borda do painel quando há sinal |

| `--ifx-teal-soft` | `rgba(63,224,197,0.12)` | Fundo de chips Teal |

| `--ifx-amber-soft` | `rgba(242,169,59,0.12)` | Fundo de avisos |

| `--ifx-coral-soft` | `rgba(255,90,110,0.12)` | Fundo de PUT/LOSS |

| `--ifx-scanline` | `rgba(63,224,197,0.03)` | Linhas de varredura de fundo |

  

### 4.4 Proporção de uso

- **75%** Petroleum (fundo e superfícies)

- **15%** Ice e Steel (texto)

- **7%** Teal (marca, onda, estado ativo)

- **3%** Amber e Coral (só quando têm significado)

  

Se a tela parecer "colorida", está errada. **O Teal precisa ser raro para ter impacto.**

  

### 4.5 Significado fixo das cores (não negociável)

| Cor | Significa sempre | Nunca usar para |

|---|---|---|

| Teal | Frequência limpa, sinal CALL, conectado, ativo | Decoração aleatória |

| Coral | Sinal PUT, LOSS, erro | Alertas leves |

| Amber | Espera, calibrando, dados instáveis, bloqueado | Sinal de entrada |

| Steel | Ruído, inativo, rótulos, informação secundária | Números principais |

| Ice | Conteúdo principal legível | Estados |

  

**Regra de acessibilidade:** direção **nunca** é comunicada só por cor. Sempre **cor + seta + palavra**: `CALL ▲` / `PUT ▼`.

  

### 4.6 Contraste (sobre `#0B1A1F`)

| Cor | Contraste aprox. | Resultado |

|---|---|---|

| Ice `#E6EEF0` | ~15:1 | AAA |

| Teal `#3FE0C5` | ~11:1 | AAA |

| Amber `#F2A93B` | ~9:1 | AAA |

| Steel `#8A9BA3` | ~6.5:1 | AA (texto normal) |

| Coral `#FF5A6E` | ~5.8:1 | AA (texto normal) |

  

---

  

## 5. Tipografia

  

Duas famílias. Nenhuma a mais.

  

### 5.1 Famílias

| Família | Papel | Pesos |

|---|---|---|

| **Space Grotesk** | Display e títulos: logo, "SEÑAL INTERCEPTADA", CALL/PUT, títulos de seção | 500, 700 |

| **JetBrains Mono** | Dados e interface: preços, contagem, payout, ativo, rótulos, logs, checklist | 400, 500, 700 |

  

> Na extensão as fontes são **empacotadas localmente** (`.woff2` dentro da extensão). Nunca carregar do Google Fonts: o CSP da corretora pode bloquear e isso também vaza requisições.

  

### 5.2 Escala (painel de 320px)

| Estilo | Família | Tamanho / altura de linha | Peso | Tracking | Uso |

|---|---|---|---|---|---|

| `signal-xl` | Space Grotesk | 48 / 52 | 700 | -1% | `CALL ▲` / `PUT ▼` |

| `state-lg` | Space Grotesk | 20 / 26 | 500 | +4%, caixa alta | "SEÑAL INTERCEPTADA", "ESCANEANDO" |

| `timer` | JetBrains Mono | 22 / 26 | 500 | 0, tabular | `0:05` no anel |

| `value-md` | JetBrains Mono | 18 / 24 | 500 | 0, tabular | Preço, payout |

| `body` | JetBrains Mono | 14 / 21 | 400 | 0 | Checklist, textos |

| `label` | JetBrains Mono | 11 / 16 | 500 | +18%, caixa alta | Rótulos ("PRECIO ACTUAL", "FEED") |

| `whisper` | JetBrains Mono | 12 / 18 | 400 | +8% | "Ruido de mercado.", rodapé |

  

Regras:

- Todos os números usam `font-variant-numeric: tabular-nums` (não "tremem" quando mudam).

- Nada abaixo de **11px** (e só rótulos em caixa alta chegam a 11px). Texto de leitura: mínimo 14px.

- Frases de "voz" da marca terminam com ponto final: `Frecuencia fijada.` Isso dá o tom seco e militar.

- Títulos de marketing (landing, anúncios) usam o estilo espaçado da prancha: Space Grotesk 500, caixa alta, tracking +30%.

  

---

  

## 6. Elemento assinatura: A ONDA

  

A onda é o que torna a Inflitrus reconhecível. **Ela explica o estado do mercado sem que o usuário precise ler nada.**

  

### 6.1 Os 3 estados da onda

| Estado | Visual | Cor | Texto acima |

|---|---|---|---|

| **RUIDO** | Onda caótica, alta amplitude, frequência irregular | Steel 60% | `Ruido de mercado.` |

| **ANÁLISIS** | Onda amortecendo, amplitude caindo, ritmo regular | Transição Steel → Teal | `Analizando…` |

| **FRECUENCIA FIJADA** | Linha reta estável com leve brilho | Teal + glow | `Frecuencia fijada.` |

  

Na prancha, a onda mostra os três estados na mesma linha, da esquerda para a direita, separados por uma **linha vertical de interceptação** (o cursor). Esse é o layout padrão do cabeçalho do núcleo.

  

### 6.2 Especificação

- Altura da área da onda: **72px** no painel padrão, **24px** na pílula mini

- Traço: **1.5px**, pontas arredondadas

- Linha de interceptação: 1px Teal, altura total da área, com um brilho de 6px

- Glow da frequência fixada: `drop-shadow(0 0 6px rgba(63,224,197,0.5))`

- Renderização: `<canvas>` ou SVG com no máximo 60 pontos; atualizar a no máximo **30fps**

- Fonte de dados: a onda pode ser **simbólica** (não precisa ser o preço real), mas a amplitude deve refletir o estado real do sistema

  

### 6.3 Movimento reduzido

Com `prefers-reduced-motion: reduce`, a onda vira um **desenho estático** do estado atual, sem animação.

  

### 6.4 Onde a onda aparece

Núcleo do painel, pílula mini, popup, ícone animado da notificação, landing page (hero), anúncios, vídeos e loading.

  

---

  

## 7. Iconografia

  

- Estilo: **linha**, traço 1.5px, cantos levemente arredondados, grid de 24px (usar em 16 ou 20)

- Biblioteca base recomendada: Lucide (consistente com esse estilo)

- Cor padrão: Steel. Ativo: Teal. Alerta: Amber.

- Nunca ícones preenchidos, coloridos, 3D ou emoji.

  

Ícones do produto:

| Função | Ícone |

|---|---|

| Registro | documento com linhas |

| Mercado | barras verticais |

| Sistema / configurações | engrenagem |

| Condição cumprida | check `✓` Teal |

| Condição pendente | círculo vazio `○` Steel |

| Condição falhou | `×` Coral |

| Status | ponto 8px (Teal / Amber / Coral) |

| Minimizar | traço horizontal |

| Som | alto-falante |

| Direção | triângulos sólidos `▲` `▼` (única exceção preenchida) |

  

---

  

## 8. Layout, grid e forma

  

### 8.1 Painel padrão (barra lateral)

- Largura: **320px** (mín. 288px, máx. 360px)

- Altura: conteúdo, máximo `100vh - 32px`, rolagem interna só nas abas

- Posição: encaixada à direita (padrão) ou à esquerda, arrastável, **sem cobrir os controles de ordem da corretora**

- Padding interno: **16px**

- Espaçamento entre blocos: **12px**

- Grid base: **4px**

  

### 8.2 Forma

| Elemento | Raio |

|---|---|

| Painel | 16px |

| Cartões internos | 10px |

| Chips e botões | 8px |

| Pílula mini | 999px (totalmente arredondada) |

| Anel do timer | círculo |

  

### 8.3 Bordas e profundidade

- Borda padrão: **1px** `--ifx-border`

- Sem sombras pesadas. Painel flutuante: `0 12px 40px rgba(0,0,0,0.45)`

- **Glow só em 3 lugares:** linha de frequência fixada, direção do sinal (`CALL ▲` / `PUT ▼`) e anel do timer durante um sinal ativo. Em nenhum outro lugar.

  

### 8.4 Textura de fundo

- Linhas de varredura horizontais muito sutis (`--ifx-scanline`, 1px a cada 3px)

- Uma retícula de radar (círculo + cruz) em Steel 6% pode aparecer atrás do núcleo quando estiver **ESCANEANDO**

- Nunca: bolhas, orbes, gradientes roxos, "chuva Matrix"

  

---

  

## 9. Componentes da interface

  

### 9.1 Header (48px)

`[pulso] INFLITRUS SIGNALS` · `● AUDCAD_OTC · M1` · `[engrenagem]` `[minimizar]`

- O **ativo e o timeframe aparecem só aqui** (nunca repetidos no painel)

- Ponto de status: Teal = estável, Amber = calibrando/instável, Coral = erro

  

### 9.2 Núcleo (herói, único elemento grande)

1. Onda com a linha de interceptação (72px)

2. Frase-sussurro: `Transmisión interceptada.` (Teal, `whisper`)

3. Estado: `SEÑAL INTERCEPTADA` (Ice, `state-lg`)

4. Direção: `CALL ▲` (Teal) ou `PUT ▼` (Coral), `signal-xl` com glow

5. Validade: `Válida por 0:05` (valor em Teal)

6. **Anel de contagem** à direita: 72px, traço 4px, trilha Steel 20%, progresso Teal (Amber nos últimos 2s), número no centro

  

### 9.3 Checklist de condições

Cartão `surface-1`, 3 linhas com ícone + texto:

```

✓  EMA 9 cruzó EMA 21

✓  RSI > 50

○  Vela confirmada

```

Um mini-gráfico de velas em Steel 40% pode ficar à direita, puramente ilustrativo e discreto.

Para PUT: `EMA 9 cruzó bajo EMA 21` · `RSI < 50` · `Vela confirmada`.

  

### 9.4 Linha de contexto

Um cartão com 3 colunas separadas por divisórias de 1px:

`PRECIO ACTUAL 0.89421` | `PAYOUT 92%` | `FEED ● Estable`

- Rótulo em `label` Steel, valor em `value-md` Ice (payout em Teal)

  

### 9.5 Abas recolhidas

`[doc] Registro ⌄` · `[barras] Mercado ⌄` · `[engrenagem] Sistema ⌄`

- **Registro:** histórico de sinais (hora, direção, resultado WIN/LOSS), taxa de acerto

- **Mercado:** EMA 9, EMA 21, RSI 14, último candle, idade do último dado

- **Sistema:** WebSocket, histórico (velas), gaps, estado técnico, logs, botões Copiar/Limpiar

- Só uma aba aberta por vez (acordeão)

  

### 9.6 Rodapé (fixo)

`Inflitrus detecta. Tú decides.`, em `whisper` Steel, centralizado, tracking +20%.

  

### 9.7 Pílula mini

- 240 × 56px, raio total

- `[pulso] AUDCAD_OTC · M1 ●` + `CALL ▲` + anel de 32px

- Sem sinal: mostra a mini-onda no lugar da direção

- Clique = expande para o painel padrão

  

### 9.8 Popup do ícone (360 × ~420px)

- Logo, status (`● Activo · Escuchando el mercado…`), mini-onda

- Ativo atual, estado dos dados (`● Datos estables`)

- Liga/desliga, som, notificações, licença

- **O sinal nunca aparece no popup.** Ele vive só no painel.

  

### 9.9 Ícone da extensão

- Símbolo de pulso Teal sobre um quadrado Petroleum com raio de 22%

- Tamanhos: 16, 32, 48, 128px (no de 16px o pulso fica mais grosso para manter a leitura)

- Estado com badge: ponto Teal = sinal ativo, ponto Amber = dados instáveis

  

### 9.10 Notificação do Chrome

- Título: `Señal interceptada · CALL ▲`

- Corpo: `AUDCAD_OTC · M1 · Válida por 5s`

- Ícone: símbolo de pulso 128px

- Sinal atrasado **não** gera notificação

  

---

  

## 10. Estados do sistema → visual e texto

  

Os 14 estados técnicos do PRD viram **5 estados visíveis**:

  

| Estado visível | Estados técnicos | Ponto | Onda | Texto principal | Sussurro |

|---|---|---|---|---|---|

| **CONECTANDO** | BOOTING, WAITING_FOR_FRAME, CONNECTING | Amber pulsando | Plana Steel, tracejada | `INFILTRÁNDOSE` | `Buscando la transmisión…` |

| **CALIBRANDO** | SYNCING_HISTORY, SYNCING_REALTIME | Amber | Ruído baixo | `CALIBRANDO` | `97/150 velas sincronizadas.` + barra de progresso Amber |

| **ESCANEANDO** | READY, CANDLE_UPDATING (sem sinal) | Teal | Ruído (Steel) + retícula de radar | `ESCANEANDO` | `Ruido de mercado. Sin señal.` |

| **SEÑAL INTERCEPTADA** | CANDLE_CLOSED + estratégia confirmada | Teal | Frequência fixada (Teal + glow) | `SEÑAL INTERCEPTADA` + `CALL ▲` / `PUT ▼` | `Transmisión interceptada.` |

| **BLOQUEADO** | STALE, DATA_GAP, INVALID_DATA, FORMAT_CHANGED, RECONNECTING, ERROR | Amber (Coral em ERROR) | Linha quebrada / interrompida | `SEÑAL BLOQUEADA` | Motivo em 1 linha (ver abaixo) |

  

Motivos do BLOQUEADO (sussurro):

| Técnico | Texto |

|---|---|

| STALE | `Datos congelados. No operar.` |

| DATA_GAP | `Faltan velas. Recalibrando…` |

| INVALID_DATA | `Datos inválidos detectados.` |

| FORMAT_CHANGED | `La plataforma cambió. Revisando…` |

| RECONNECTING | `Señal perdida. Reconectando…` |

| ERROR | `Error interno. Revisa Sistema.` |

  

Subestados do sinal:

| Momento | Visual | Texto |

|---|---|---|

| **Pré-alerta** (últimos segundos da vela) | Onda começa a amortecer, borda Teal 20% | `Patrón detectado. Validando…` |

| **Liberado** | Sequência de revelação (seção 11.3) + som | `SEÑAL INTERCEPTADA` |

| **Expirado** | Tudo em Steel, direção riscada, sem glow | `Ventana cerrada.` |

| **Resultado** | Vai para o Registro | `WIN +0.8` (Teal) / `LOSS -1` (Coral) |

  

---

  

## 11. Movimento

  

### 11.1 Princípios

- O movimento **comunica estado**, nunca decora.

- Tudo é suave e "de instrumento": sem quicar, sem elástico.

- **Um único momento forte:** a revelação do sinal. O resto é quase imperceptível.

  

### 11.2 Tempos e curvas

| Token | Duração | Curva | Uso |

|---|---|---|---|

| `--ifx-fast` | 120ms | `cubic-bezier(0.2,0,0,1)` | Hover, cliques |

| `--ifx-base` | 220ms | `cubic-bezier(0.2,0,0,1)` | Abrir aba, trocar estado |

| `--ifx-reveal` | 600ms | `cubic-bezier(0.16,1,0.3,1)` | Revelação do sinal |

| `--ifx-wave` | contínua | linear | Onda (máx. 30fps) |

  

### 11.3 Sequência de revelação do sinal (a assinatura)

1. **0ms:** a onda colapsa de ruído para linha reta (300ms)

2. **200ms:** a linha de interceptação dispara um pulso vertical (o "I" do logo)

3. **300ms:** `SEÑAL INTERCEPTADA` aparece com fade + subida de 4px

4. **400ms:** `CALL ▲` surge com glow crescente (0 → 100%)

5. **500ms:** o anel de contagem começa a correr

6. A borda do painel muda para `--ifx-border-strong` enquanto o sinal vale

  

### 11.4 Movimento reduzido

Com `prefers-reduced-motion`: sem onda animada, sem pulso, sem subida. Só troca instantânea de estado e glow estático.

  

---

  

## 12. Som

  

Timbres curtos, eletrônicos e discretos, inspirados em rádio e sonar. Nada de moedas, sinos ou cassino.

| Evento | Som |

|---|---|

| Sinal interceptado | 2 bipes ascendentes curtos (tipo sonar), ~250ms |

| Pré-alerta (opcional, desligado por padrão) | 1 clique suave |

| Bloqueio | 1 tom grave curto |

| Conectado | estática curta que "limpa" |

  

- Volume padrão: 60%. Pode ser desligado.

- Se o navegador bloquear o áudio, o fallback é o glow + a borda do painel.

  

---

  

## 13. Voz e linguagem

  

### 13.1 Tom

Frases **curtas, secas, no presente, com ponto final.** Como um operador de rádio falando baixo.

  

### 13.2 Território verbal

`INTERCEPTADO · FRECUENCIA · SEÑAL · RUIDO · TRANSMISIÓN · ESCANEANDO · DETECTADO · VALIDADO · BLOQUEADO · FIJADO · INFILTRADO · CALIBRANDO · CONFIRMACIÓN · PATRÓN`

  

### 13.3 Frases oficiais

- `Ruido de mercado.`

- `Frecuencia fijada.`

- `Transmisión interceptada.`

- `Patrón detectado. Validando…`

- `Movimiento detectado. Señal todavía bloqueada.`

- `El mercado cambió. Inflitrus lo detectó.`

- `Menos ruido. Más lectura.`

- `No adivines la próxima vela. Lee lo que está ocurriendo.`

  

### 13.4 Faça / Não faça

| Faça | Não faça |

|---|---|

| `Señal interceptada.` | `¡¡SEÑAL GANADORA!!` |

| `Datos inestables. No operar.` | `Ups, algo salió mal 😅` |

| `Tú decides.` | `Gana dinero fácil` |

| `Posible CALL` (em comunicação externa) | `CALL seguro` / `100% de acierto` |

| Espanhol neutro LATAM | Misturar português e espanhol |

  

### 13.5 Aviso legal (obrigatório)

Em todo material externo e na primeira execução:

> Inflitrus Signals es una herramienta de análisis técnico. No ejecuta operaciones ni garantiza resultados. Operar implica riesgo de pérdida. Tú decides.

  

---

  

## 14. Imagem e fotografia de marca (marketing)

  

- **Temas:** radiotelescópios, antenas parabólicas, montanhas à noite, osciloscópios, salas de controle escuras, feixes de luz Teal no horizonte

- **Tratamento:** noite fria, sombras profundas levemente puxadas para o Petroleum, uma única fonte de luz Teal ou âmbar quente (janelas, instrumentos)

- **Composição:** muito espaço negativo, sujeito pequeno, sensação de escala e silêncio

- **Evitar:** pessoas comemorando, dinheiro, carros, cassino, gráficos genéricos de banco de imagem, hackers de capuz

  

---

  

## 15. Aplicações

  

### 15.1 Chrome Web Store

- Ícone: 128 × 128 (símbolo sobre Petroleum)

- Tile promocional pequeno: 440 × 280, com logo e a assinatura `Escucha el mercado. Encuentra la señal.`

- Screenshots: 1280 × 800, painel real sobre um gráfico escurecido, uma frase por screenshot:

  1. `Filtra el ruido.` (ESCANEANDO)

  2. `Intercepta la señal.` (SEÑAL INTERCEPTADA)

  3. `Entiende el porqué.` (checklist)

  4. `Bloquea datos malos.` (BLOQUEADO)

  5. `Tú decides.` (painel + pílula)

  

### 15.2 Landing page

- Hero: foto do radiotelescópio à noite + onda animada atravessando a tela (ruído → frequência fixada) + `El mercado habla. Nosotros escuchamos distinto.`

- Seções: `Filtra · Analiza · Intercepta` → como funciona (os 3 estados da onda) → o painel → disciplina (bloqueio de dados ruins) → aviso legal

- Títulos em caixa alta espaçada, corpo em JetBrains Mono

  

### 15.3 Anúncios e redes

- Formato base: fundo Petroleum, onda Teal, uma frase do território verbal, logo no canto

- Vídeo curto (6–15s): ruído → interceptação → `CALL ▲` → `Inflitrus detecta. Tú decides.`

- Avatar: símbolo de pulso centralizado

  

---

  

## 16. Regras técnicas para a extensão

  

- **Shadow DOM** obrigatório: o painel é isolado do CSS da corretora e vice-versa

- Todos os tokens com prefixo `--ifx-` definidos no `:host`

- Fontes `.woff2` locais, com `font-display: swap`

- `z-index` alto, mas o painel **nunca** cobre os controles de ordem (detectar e se reposicionar)

- Se a página remover o painel, recriá-lo mantendo o estado

- Respeitar `prefers-reduced-motion`

- Animações só com `transform` e `opacity` (performance)

- Onda: pausar a animação quando a aba não estiver visível (`document.hidden`)

  

### 16.1 Tokens (referência para implementação)

```css

:host {

  /* núcleo */

  --ifx-petroleum: #0B1A1F;

  --ifx-teal: #3FE0C5;

  --ifx-steel: #8A9BA3;

  --ifx-amber: #F2A93B;

  /* funcionais */

  --ifx-ice: #E6EEF0;

  --ifx-coral: #FF5A6E;

  /* superfícies */

  --ifx-surface-0: #0B1A1F;

  --ifx-surface-1: rgba(138,155,163,0.06);

  --ifx-surface-2: rgba(138,155,163,0.10);

  --ifx-border: rgba(138,155,163,0.18);

  --ifx-border-strong: rgba(63,224,197,0.35);

  --ifx-teal-soft: rgba(63,224,197,0.12);

  --ifx-amber-soft: rgba(242,169,59,0.12);

  --ifx-coral-soft: rgba(255,90,110,0.12);

  --ifx-scanline: rgba(63,224,197,0.03);

  --ifx-glow-teal: 0 0 6px rgba(63,224,197,0.5);

  /* semântica */

  --ifx-call: var(--ifx-teal);

  --ifx-put: var(--ifx-coral);

  --ifx-warn: var(--ifx-amber);

  --ifx-text: var(--ifx-ice);

  --ifx-text-muted: var(--ifx-steel);

  /* tipografia */

  --ifx-font-display: 'Space Grotesk', system-ui, sans-serif;

  --ifx-font-mono: 'JetBrains Mono', ui-monospace, monospace;

  /* forma */

  --ifx-radius-panel: 16px;

  --ifx-radius-card: 10px;

  --ifx-radius-chip: 8px;

  --ifx-space: 4px;

  /* movimento */

  --ifx-fast: 120ms;

  --ifx-base: 220ms;

  --ifx-reveal: 600ms;

  --ifx-ease: cubic-bezier(0.2,0,0,1);

  --ifx-ease-reveal: cubic-bezier(0.16,1,0.3,1);

}

```

  

---

  

## 17. Checklist de consistência (antes de entregar qualquer tela)

  

- [ ] Só 1 elemento grande na tela (o núcleo)

- [ ] O ativo aparece apenas no header

- [ ] Direção sempre com cor + seta + palavra

- [ ] Glow só na frequência fixada, na direção e no anel

- [ ] Teal ocupa menos de 10% da tela

- [ ] Nenhuma cor fora das 6 oficiais

- [ ] Só Space Grotesk + JetBrains Mono

- [ ] Números com `tabular-nums`

- [ ] Todo o texto em espanhol, sem mistura com português

- [ ] Rodapé `Inflitrus detecta. Tú decides.` presente

- [ ] Estados técnicos traduzidos para os 5 estados visíveis

- [ ] Funciona com `prefers-reduced-motion`

- [ ] Contraste AA no mínimo

- [ ] O painel não cobre os controles de ordem da corretora
![[Pasted image 20260922222149.png]]