# Auditoría de la interfaz antes del rebranding

Fecha: 22 de septiembre de 2026

## Límites de seguridad verificados

1. La intervención solo lee el estado que ya produce `analyzer.js`; no escribe ni altera la plataforma.
2. No se añaden clics, llamadas de red ni comandos de compra/venta.
3. No se leen ni se muestran credenciales o payloads sensibles.
4. La interfaz conserva los bloqueos del motor y nunca calcula una señal propia.
5. Las claves existentes de storage, sesiones, activo y timeframe se conservan.
6. La validación incluye la suite existente y pruebas unitarias del adaptador visual.
7. Cualquier estado no reconocido se representa como bloqueado o conectando, nunca como señal.

## Inventario actual → destino Inflitrus

| Elemento actual | Archivo / línea original | Fuente del dato | Nuevo destino |
|---|---|---|---|
| Creación e inyección del panel | `src/content/panel.js:82-110` | Instancia `DiagnosticPanel` creada por `analyzer.js:81` | Host único `<inflitrus-panel>` en Shadow DOM cerrado |
| CSS y HTML del panel | `src/content/panel.js:208-894` | Template literal monolítico | `src/ui/tokens.css`, `src/ui/base.css` y componentes `src/ui/components/*` |
| Estado técnico | `src/content/analyzer.js:266-290`, `349-386`, `498-528` | `DataQualityTracker.getReport()` | `src/ui/view-model.js` → cinco estados visibles |
| Señal y motivos | `src/content/analyzer.js:292-332`, `378-381` | `quantPortfolio` y estrategia legada | Núcleo, checklist y onda; sin recalcular nada |
| Historial y win rate | `src/content/analyzer.js:346-376` | `signalAuditor.getSignals()` / `getStats()` | Acordeón **Registro** |
| Cinco motores | `src/content/analyzer.js:359-372` | `quantReport.strategiesResults` | Acordeón **Mercado** → `Motores (5)` |
| Probabilidad, edge, calidad, BE | `src/content/analyzer.js:360-369`, `373` | `quantReport` + payout existente | Acordeón **Mercado** → `Lectura cuantitativa` |
| Presión de ticks y régimen | `src/content/analyzer.js:367-372` | `quantReport.regime` / `intraminuteTracker` | Acordeón **Mercado** |
| Precio, payout y feed | `src/content/analyzer.js:349-373` | último candle, payout y `DataQualityTracker` | Línea de contexto |
| WebSocket, histórico, gaps | `src/content/analyzer.js:349-358` | observadores y `DataQualityTracker` | Chip de feed + acordeón **Sistema** |
| Logs técnicos | `src/content/panel.js:972-1048` | `logger` y `oracle_logs` | Acordeón **Sistema**, con `Copiar` / `Limpiar` |
| Contador de vela | `src/content/panel.js:27-32`, `1050-1097` | `candleTimer` | Anillo del núcleo; sin alterar el temporizador |
| Preferencia de sonido | `src/utils/audio-alerts.js` | `oracle_sound_enabled`, `oracle_sound_volume` | Menú del header; se preservan las claves |
| Posición, lado y minimizar | `src/content/panel.js:112-190` | Estado local del panel | Panel flotante/píldora con persistencia visual nueva |
| Popup | `src/popup/popup.html`, `popup.css`, `popup.js` | `oracleMarketState` y mensajes internos | Popup Inflitrus sin mostrar señales |
| Side panel nativo | `src/sidepanel/sidepanel.html`, `sidepanel.js` | `oracleMarketState`, `oracle_logs` | Vista técnica Inflitrus en español |
| Notificaciones | No implementadas; permiso ya existe en `manifest.json` | Señal válida ya emitida por el motor | `src/background/notifications.js`, sin notificar señales atrasadas |
| Manifest e iconos | `manifest.json:2-55`, `icons/*` | Metadatos de la extensión | Nombre, descripción, título e iconos Inflitrus |

## Textos visibles detectados

La interfaz actual contiene portugués y la marca anterior en `panel.js`, `popup.html`, `popup.js`, `sidepanel.html` y `sidepanel.js`: “Aguardar”, “Ativo”, “Preço”, “Próxima vela”, “Sinais gravados”, “Dados de mercado”, “Integridade”, “Copiar”, “Limpar”, “Barra Lateral Adaptada” y “Oracle Quant”. Todos se trasladan a español neutro y a la nueva arquitectura visual.

Los identificadores y claves internas `ORACLE_*` / `oracle_*` no son texto de interfaz. Se mantienen deliberadamente para no romper mensajes, preferencias ni historial del usuario.

## Datos no expuestos explícitamente

- No existe un campo de prealerta. La UI no lo deduce; el subestado se omite hasta que el motor lo exponga.
- No existe un TTL explícito de señal. El adaptador usa `recordedAt` del historial ya generado para presentar la ventana visual de cinco segundos, sin cambiar la decisión del motor.
- No hay selector DOM contractual para la zona de órdenes. La interfaz usa el Side Panel nativo de Chrome, que reserva espacio propio a la derecha y no cubre la plataforma.
