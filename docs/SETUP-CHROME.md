# Configurações Recomendadas do Google Chrome para Trading em Alta Frequência

Para garantir que a extensão **Inflitrus Signals / Oracle Quant** funcione sem atrasos, interrupções ou congelamento de abas quando minimizada ou em segundo plano, configure o Google Chrome conforme as diretrizes abaixo.

---

## 1. Desativar Throttling Intensivo de Timers em Background

O Chrome reduz a execução de timers JavaScript (`setInterval` / `setTimeout`) para 1 vez por minuto quando uma aba fica em segundo plano por mais de 5 minutos (Intensive Wake Up Throttling desde o Chrome 88).

1. Abra uma nova aba no Chrome e digite:
   ```text
   chrome://flags/#intensive-wake-up-throttling
   ```
2. Localize a opção:
   **"Throttle Javascript timers in background"** (ou **"Intensive Wake Up Throttling"**)
3. Altere o valor para: **`Disabled`**

---

## 2. Desativar Cálculo de Oclusão de Janelas no Windows

No Windows, o Chrome reduz drasticamente a taxa de atualização de abas cobertas por outras janelas através do cálculo de oclusão.

1. Digite na barra de endereços:
   ```text
   chrome://flags/#calculate-native-win-occlusion
   ```
2. Localize a opção:
   **"Calculate window occlusion on Windows"**
3. Altere o valor para: **`Disabled`**
4. Clique no botão **"Relaunch"** (Reiniciar) no canto inferior direito para aplicar as alterações das flags.

---

## 3. Isentar a B2Trading do Economizador de Memória

O Chrome possui um modo de "Economia de Memória" que descarta abas inativas. Para garantir que a corretora permaneça 100% ativa:

1. Acesse as configurações de desempenho do Chrome:
   ```text
   chrome://settings/performance
   ```
2. Na seção **"Sempre manter estes sites ativos"** (ou **"Sites a serem mantidos sempre ativos"**), clique em **"Adicionar"**.
3. Adicione a seguinte URL:
   ```text
   traderoom.b2trading.io
   ```
4. Clique em **Salvar**.

---

## 4. Proteções Nativas Integradas na Extensão

Mesmo caso essas flags não estejam configuradas, a extensão já inclui:
- **Offscreen Document com Áudio Silencioso (`OscillatorNode` 0Hz, gain 0):** Isenta a extensão do congelamento forçado do navegador.
- **Relógio Desacoplado via Web Worker:** Heartbeat contínuo de 1 segundo transmitido em background.
- **Detecção de Fechamento Baseada em Eventos (`CandleStore`):** O fechamento de velas (`closed=true`, `frozen=true`) é guiado estritamente pela chegada de dados do WebSocket, nunca pelo relógio do computador.
- **Rejeição Automática de Backlog (`TICK_REJECTED_BACKLOG`):** Mensagens atrasadas acumuladas durante minimização não recalculam sinais já emitidos nem causam repinte.
- **Supressão de Sinais Atrasados (`SIGNAL_LATE`):** Sinais originados de velas fechadas há mais de 65 segundos são gravados para histórico e auditoria, mas têm alertas visuais e sonoros suprimidos.
