# Suspeitas e Anotações de Produção — Flight Recorder

Documento de registro de comportamentos suspeitos encontrados no código durante a instrumentação do Gravador de Voo.
Regra: NENHUM bug deve ser corrigido por hipótese aqui. Apenas anotado com `arquivo:linha` para posterior correlação com os dados do voo exportados.

---

### Registro Inicial de Suspeitas
1. **`src/sidepanel/sidepanel.js:355-408` (renderSignalsHistory) vs `renderSignalCard` (Multi-sinais aparentes)**
   - O histórico exibe até 20 sinais com badge de direção e resultado. Se o usuário estiver vendo os itens de histórico no mesmo painel enquanto o card principal está ativo, pode haver confusão sobre se são sinais concorrentes ou histórico de sinais passados. A confirmar com o log `RENDER` do Flight Recorder.
2. **`src/sidepanel/sidepanel.js:588-601` (updateBoundContext)**
   - O `boundTabId` depende de `chrome.tabs.query({ active: true, windowId: boundWindowId })`. Se o usuário tiver mais de uma aba aberta na mesma janela ou alternar entre janelas, há risco de o side panel re-vincular temporariamente a uma aba secundária se o evento `onActivated` demorar para responder.
3. **`src/sidepanel/sidepanel.js:735-743` (chrome.storage.onChanged)**
   - O Side Panel escuta `changes` em `chrome.storage.local`. Se duas janelas estiverem gravando estados em abas distintas (`ifx:tab:1:state` e `ifx:tab:2:state`), o filtro `k.startsWith(tabPrefix)` deveria isolar, mas é necessário verificar no `STORAGE_CHANGE` se algum evento de outra aba está disparando render na janela atual.
4. **`src/content/analyzer.js:726-765` (Reset para estado vazio quando canal é nulo)**
   - Quando `!this.currentSymbol`, `saveMarketStateToStorage` é chamado salvando um payload com `symbol: null, pair: null, action: "WAIT", signal: "WAIT"`. Se o `activeChannel` for resetado por um evento intermediário de unsubscribe ou recarga parcial de iframe, esse estado "vazio" pode sobrescrever um estado válido recém-gravado.
5. **`src/content/analyzer.js:1050-1080` (Debounce de 250ms em saveMarketStateToStorage)**
   - O `saveMarketStateToStorage` aplica debounce de 250ms quando `immediate: false`. Quando ocorrem chamadas consecutivas com `immediate: false` seguidas ou precedidas de `immediate: true` (como em `ENTRY_NOW` ou `SETTLED`), a fila assíncrona pode entregar estados fora de ordem relativa temporal ao background se o timeout disparar após outro save.
6. **`src/sidepanel/sidepanel.js:88-185` (updateClockOnlyUI vs activeSignalData)**
   - O `updateClockOnlyUI()` roda a cada 250ms com base em `activeSignalData?.lifecycle || lastLifecycle`. Se `activeSignalData` mudar de direção ou par, mas `lastLifecycle` retiver o snapshot anterior, durante os primeiros milissegundos pode haver oscilação momentânea de texto/ícone antes da reconciliação com o storage.
7. **`src/main/injected-main.js:142-265` (Multiplexação de ativos no WebSocket da corretora)**
   - A corretora envia cotações e candles de vários ativos pela mesma conexão WebSocket através de múltiplos sub-canais ou multiplexação. O Flight Recorder registrará todos os `WS_FRAME` para aferir se frames de ativos secundários chegam misturados aos do ativo primário.

