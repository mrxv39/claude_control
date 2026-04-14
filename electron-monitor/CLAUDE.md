# electron-monitor — Arquitectura detallada

## Mecanismo HWND (importante)

WT puede tener **múltiples ventanas en un único proceso** `WindowsTerminal.exe`. La solución:

1. El hook captura `GetForegroundWindow` cuando se dispara con `BUSY` (= el usuario acaba de mandar un prompt → esa ventana WT está en foreground).
2. El HWND se persiste en el state file por cwd.
3. `get-sessions.ps1` lo expone; `index.html` lo manda a `focus-wt`; `main.js` valida `IsWindow(hwnd)` y hace `SetForegroundWindow` directo.

Sesiones sin HWND (no han disparado BUSY, o son servicios):
- `main.js` enumera ventanas WT con `FindWindowExA` y hace match por título de ventana vs nombre de proyecto.
- Si hay match, asigna el HWND.
- **Fallback por posición**: si quedan N sesiones sin HWND y N ventanas WT sin asignar, se emparejan por posición horizontal (izquierda a derecha vía `GetWindowRect`).
- Para servicios agrupados, fallback al HWND de la sesión Claude del mismo grupo.

## Overlays de título

`main.js` crea un `BrowserWindow` por sesión (frame:false, transparent:true, alwaysOnTop, focusable:false, ignoreMouseEvents, show:false) y un loop de 33ms:

- Espera `ready-to-show` antes de mostrar (evita flash de ventana vacía).
- Ocupa todo el ancho de la ventana WT menos 140px a la derecha (no tapa botones min/max/cerrar).
- **Colores por estado**: fondo verde sólido (BUSY) o rojo sólido (WAITING/IDLE), texto oscuro contrastante.
- `GetWindowRect` para reposicionar el overlay pegado a la barra de título de cada WT.
- **Occlusion test**: hit-test en el **centro** de la ventana WT con `WindowFromPoint` + `GetAncestor(GA_ROOT)`. Si otra ventana tapa ese punto, el overlay se oculta. Probar en el centro evita falsos positivos con la barra Claudio (always-on-top en la parte superior).
- Si `IsIconic` o `!IsWindowVisible` → `hide()`.
- Guard: si `isQuitting` o `win.isDestroyed()`, skip/delete del Map.

## Auto-tile

Las ventanas WT se redistribuyen automáticamente cuando el set de ventanas visibles cambia (nueva ventana aparece o una se cierra/minimiza). No requiere interacción del usuario.

- 1: 50% izquierda · 2: 50%+50% lado a lado · 3: 33%×3 · 4: 2×2 · N≥5: `cols=ceil(sqrt(N))`, `rows=ceil(N/cols)`
- Origen `y = workArea.y + 48` para no taparse con la barra siempre-encima.
- `ShowWindow(h, 9)` (SW_RESTORE) antes de mover por si está maximizada.
- Solo re-tile cuando el set de HWNDs cambia (`prevAutoTileHwnds`), no en cada refresh.
- Enumera todas las ventanas WT visibles con `enumWtWindows()` (no depende de HWNDs de sesión).

## Tile manual

Ctrl+click en chips los añade/quita de un `Set` de selección. En cuanto hay 2+, se llama `tile-windows` con los HWNDs seleccionados.

## Agrupado de sesiones por proyecto

Sesiones con el mismo `cwd` se agrupan en un solo chip:
- Línea principal: estado Claude (dot + nombre + `[claude (working)]`)
- Línea secundaria: badges de servicio clickables (`⚙ tauri dev`)

Click en badge enfoca ventana del servicio. Click en zona principal enfoca sesión Claude.

## System tray

- El botón ✕ del renderer llama `hide-bar` (IPC) → `mainWindow.hide()`.
- `mainWindow.on('close')` previene cierre real (solo hide) excepto si `isQuitting=true`.
- Icono de tray con menú contextual: "Mostrar" y "Salir".
- Click en tray muestra el menú (tanto click izquierdo como derecho).
- "Salir" activa `isQuitting=true` → para overlay loop → destruye overlays → `app.quit()`.

## Detección de estado (BUSY/WAITING)

La detección NO depende de hooks ni process tree — lee el **contenido del JSONL** de conversación directamente. Sin delays ni timeouts.

`get-sessions.ps1` lee los últimos 4KB del JSONL y busca la última línea con `stop_reason`:
- `"stop_reason":"end_turn"` → **WAITING** (Claude terminó su turno)
- `"stop_reason":"tool_use"` → **BUSY** (Claude a mitad de turno, esperando resultado de herramienta)
- Última línea es `"type":"user"` → **BUSY** (Claude procesando mensaje/tool_result)
- Fallback si JSONL no legible: usa el estado del hook state file.

Esto cubre todos los casos problemáticos:
- Plan confirmation menus → end_turn → WAITING ✓
- Permission prompts → end_turn → WAITING ✓
- Internal tools (Edit, Read, Write) sin child processes → tool_use → BUSY ✓
- Long-running bash commands → tool_use (hasta que el resultado vuelve) → BUSY ✓
- Approving a plan (no UserPromptSubmit fires) → user message written → BUSY ✓

**Importante**: Los `FileStream` usan `FileShare.ReadWrite` para evitar deadlocks con Claude escribiendo al JSONL simultáneamente.

## Notificaciones

Cuando una sesión pasa de BUSY → WAITING:
- `checkStatusChanges()` compara estado actual vs `prevStatus` Map.
- **Debounce**: requiere 3 polls consecutivos (~9s) de WAITING antes de notificar, para evitar falsos positivos por gaps momentáneos entre tool calls.
- `showToast(message)`: crea un `BrowserWindow` transparente (320×60) abajo a la derecha, auto-destruye en 5s.
- `playChime()`: genera un WAV de dos tonos (E6 1319Hz → B5 988Hz, con envelope) en `~/.claude/claudio-state/chime.wav` (lazy, solo la primera vez). Lo reproduce con `Media.SoundPlayer` vía PowerShell.

## Auto-update

- Al arrancar y cada 6h, `checkForUpdates()` consulta `https://api.github.com/repos/mrxv39/claude_control/releases/latest`.
- Compara `tag_name` con `package.json` version.
- Si hay nueva versión, envía `update-available` al renderer → chip amarillo "Update vX.X" con link de descarga.

## Barra autoajustable

Arranca centrada horizontalmente. Si el usuario la arrastra, recuerda la posición (`userPosition`). El auto-resize (debounced, solo si el ancho cambió) mantiene esa posición (clamped a bordes). Refresh cada 3s.

## Single instance

`requestSingleInstanceLock()` al arrancar. Si no obtiene el lock → `process.exit(0)`. Si otra instancia intenta abrir → evento `second-instance` muestra la barra existente.

## Build y distribución

- `npm run build` genera `dist/ClaudioControl.exe` (portable, ~80MB).
- Usa `electron-builder` con target `portable` y sin code signing.
- Los `.ps1` se incluyen como `extraResources` → quedan en `resources/` del empaquetado.
- `resolveScript(name)` busca scripts en `__dirname` (dev) o `process.resourcesPath` (empaquetado).
- Release en GitHub: `gh release create vX.X.X dist/ClaudioControl.exe`.

## Smart Pacing (scheduler.js + token-monitor.js)

El scheduler maximiza el uso de tokens en cada ciclo de 5 horas del rate limit.

- **Curva de pacing**: `targetUsage = progress^0.6 × maxTarget(95%)`. Compara uso real vs objetivo.
- **Acciones**: burst (delta>15, tick 15s, 3 tareas/tick), accelerate (delta>5, 30s), pace (delta>-5, 60s), coast (delta≤-5, 120s).
- **7-day guard**: coast forzado si 7d>80%, reduce maxTarget a 70% si 7d>60%.
- **Tick dinámico**: `setTimeout` encadenado (no `setInterval`) permite cambiar intervalo entre ticks.
- **Selección de tareas**: burst/accelerate → tareas caras (opus) primero. pace/coast → baratas primero.
- **Burst loop**: hasta 3 tareas por tick si cada una termina en <90s.
- **Stuck watchdog**: si una tarea lleva >6 min, `emergencyStop()` + reset de `running`.
- **Config**: `pacingEnabled`, `pacingMaxTarget`, `pacingExponent`, `sevenDayThrottle`, `sevenDayCaution` en orchestrator.json.
- **Kill switch**: `pacingEnabled: false` vuelve al threshold estático anterior.
- **statusLine hook**: formato objeto `{type:"command", command:"...", refreshInterval:10000}` en settings.json. Escribe `rate-limits.json` cada ~10s con fiveHour, sevenDay, contextWindow, cost.
- **Indicador**: barra muestra `5h:XX%→YY% ACTION MODE` (ej: `5h:14%→40% BURST CAP`).

## Degradación de contexto

Cada chip Claude muestra un badge con el % de contexto usado (de 1M tokens) y una barra de progreso (3px).

- **Fuente**: `get-sessions.ps1` lee los últimos 32KB del JSONL de conversación (`~/.claude/projects/<cwd-dashes>/<sessionId>.jsonl`), extrae `cache_read_input_tokens + cache_creation_input_tokens + input_tokens` del último mensaje assistant.
- **Cálculo**: `total_tokens / 10000` = % de 1M.
- **Path del JSONL**: cwd con `:\` → `--`, `\` y `/` → `-`, `_` → `-` (ej: `C:\Users\foo\bar_baz` → `C--Users-foo-bar-baz`).
- **Colores**: verde (<50%), amarillo (50-80%), rojo (>80%).
- **Tooltip**: muestra `Contexto: X%`.
