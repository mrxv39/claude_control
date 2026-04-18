# electron-monitor — Arquitectura detallada

## Estructura de módulos

| Archivo | Líneas | Responsabilidad |
|---------|--------|-----------------|
| `main.js` | ~490 | App lifecycle, IPC wiring, window management, auto-tile |
| `index.html` | ~100 | Renderer shell: bar + panel, carga módulos de `renderer/` |
| `renderer/*.js` | ~1600 | bar, panel-core, tabs (health/queue/log/stats/auto), common |
| `styles.css` | ~240 | CSS con custom properties (`:root` vars) |
| `lib/win32.js` | ~140 | koffi FFI bindings, enumWtWindows, focusWindow |
| `lib/overlay-manager.js` | ~320 | Overlay BrowserWindows sobre cada WT |
| `lib/notifications.js` | ~175 | Toast + chime + status change tracking |
| `lib/orchestrator-store.js` | ~260 | Persistencia: orchestrator.json + log JSONL |
| `lib/orchestrator.js` | ~260 | Lógica pura del orchestrator (enqueue, transitions) |
| `lib/scheduler.js` | ~550 | Pacing, auto-enqueue, tick loop |
| `lib/scheduler-priority.js` | ~120 | Lógica pura: priorización y selección de skills |
| `lib/executor.js` | ~425 | Spawn `claude --print`, branch management |
| `lib/skill-analyzer.js` | ~300 | Heuristic + Claude analysis de skills |
| `lib/token-monitor.js` | ~340 | Rate limits, pacing decisions |
| `lib/token-history.js` | ~130 | JSONL history por ciclo 5h |
| `lib/token-report.js` | ~220 | Agregación/ranking de ciclos para reports |
| `lib/stats-aggregator.js` | ~130 | Dashboard data aggregation |
| `lib/project-scanner.js` | ~145 | Discover projects in configured dirs |
| `lib/project-analyzer.js` | ~180 | Health checks (git, deps, tests) |
| `lib/git-status.js` | ~70 | Branch + dirty count per CWD |
| `lib/conversation-reader.js` | ~200 | Read Claude JSONL for log display |
| `lib/statusline-writer.js` | ~100 | Write rate-limits.json for statusLine |
| `lib/license.js` | ~225 | First-run gate: machineId, register/validate, cache |
| `lib/telemetry.js` | ~285 | Event batching, heartbeat, offline queue JSONL |
| `lib/startup-helpers.js` | ~75 | resolveScript, checkForUpdates, setupStatusLine, hook check |
| `lib/autonomous-orchestrator.js` | ~155 | Loop F1+ dry-run (observa, planifica, decide) |
| `lib/autonomous-store.js` | ~230 | Persistencia sistema autónomo: config + projects + events JSONL |
| `lib/planner.js` | ~350 | Planner LLM: convierte objetivo+estado en acciones |
| `lib/planner-learner.js` | ~180 | Retroalimentación del planner tras resultados |
| `lib/planner-pending.js` | ~165 | Cola pendiente del planner entre ticks |
| `lib/evaluator.js` | ~150 | Evalúa resultados vs objetivo del proyecto |
| `lib/forecast.js` | ~205 | Previsión de tokens por día/ciclo |
| `lib/goals.js` | ~340 | Plantillas de objetivo (production-ready, MVP, etc.) + checks |
| `lib/goal-suggester.js` | ~285 | Heurística local + Claude Haiku para sugerir plantilla |
| `lib/digest.js` | ~225 | Resumen Claude del estado del sistema autónomo |
| `lib/auto-pr.js` | ~225 | Integración con `gh pr create` post-ejecución |
| `lib/undo.js` | ~200 | Deshacer última ejecución autónoma |
| `lib/circuit-breaker.js` | ~105 | Corta ejecuciones repetidas que fallan |
| `lib/telegram-bot.js` | ~190 | Hooks de notificación Telegram (opt-in) |
| `lib/utils.js` | ~12 | Helpers compartidos (escapeHtml) |
| `lib/ipc/*.js` | ~540 | Handlers IPC agrupados: window, orchestrator, autonomous |
| `activation.html` | ~235 | First-run modal: machineId + email + activate |

## Tests

- Framework: **vitest** (`npm test` = `vitest run`)
- 757 tests en 36 archivos (ver `tests/*.test.js`)
- Solo módulos de lógica pura (sin FFI/Electron)

## IPC Channels (main ↔ renderer)

| Channel | Dirección | Descripción |
|---------|-----------|-------------|
| `hide-bar` | renderer→main | Ocultar barra (botón ✕) |
| `resize-bar` | renderer→main | Ajustar ancho de barra |
| `get-sessions` | renderer→main | Obtener sesiones + sync overlays + auto-tile |
| `focus-wt` | renderer→main | Enfocar ventana WT por HWND |
| `tile-windows` | renderer→main | Tile manual de HWNDs seleccionados |
| `toggle-panel` | renderer→main | Abrir/cerrar panel orquestador |
| `get-orchestrator-config` | renderer→main | Leer config |
| `set-orchestrator-config` | renderer→main | Actualizar config parcial |
| `run-project-scan` | renderer→main | Escanear proyectos |
| `get-project-analysis` | renderer→main | Proyectos analizados |
| `get-queue` | renderer→main | Cola de tareas |
| `add-to-queue` / `remove-from-queue` | renderer→main | Gestión de cola |
| `get-scheduler-status` | renderer→main | Estado del scheduler |
| `pause-scheduler` / `resume-scheduler` | renderer→main | Control scheduler |
| `get-skills` | renderer→main | Lista de skills disponibles |
| `get-git-status` | renderer→main | Branch + dirty per CWD |
| `get-session-log` | renderer→main | Conversation log for display |
| `get-dashboard-stats` / `get-live-cycle` | renderer→main | Stats tab data |
| `get-token-history` / `get-token-history-stats` | renderer→main | Token usage history |
| `run-setup-hook` | renderer→main | Ejecutar setup-hook.ps1 |
| `hook-missing` | main→renderer | Notificar que falta el hook |
| `update-available` | main→renderer | Nueva versión disponible |
| `scheduler-status` | main→renderer | Status update del scheduler |

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

`lib/overlay-manager.js` crea un `BrowserWindow` por sesión (frame:false, transparent:true, alwaysOnTop, focusable:false, ignoreMouseEvents, show:false) y un loop de 60ms (~17fps):

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
- `activation.html` se empaqueta en `build.files` junto a `index.html`.
- `resolveScript(name)` busca scripts en `__dirname` (dev) o `process.resourcesPath` (empaquetado).
- Release en GitHub: `gh release create vX.X.X dist/ClaudioControl.exe`.

## License gate + telemetría

Al arrancar, `app.whenReady` llama a `license.checkLicenseGate()` ANTES de crear la barra:

- **Machine ID**: se lee de `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` (fallback SHA256(hostname+username)).
- **license.json** en `~/.claude/claudio-state/license.json` cachea `{machineId, email, name, status, plan, registeredAt, lastValidatedAt}`.
- **Flujo**:
  - Primera ejecución (sin `license.json`) o copia-pega (machineId no coincide) → abre `activation.html` (modal 500×560).
  - Usuario introduce email (obligatorio) + nombre (opcional) → handler `activate` hace POST a `cc-register` en Supabase → si backend responde `status:'active'` escribe `license.json` y arranca la barra. Si backend inalcanzable, activación local offline como fallback (se re-registra en próxima validación online).
  - Si `status='revoked'` en cache o en respuesta online → `dialog.showErrorBox` + `app.quit`.
  - Re-validación cada 6h (`setInterval` paralelo a `checkForUpdates`). Si entre tanto pasa a `revoked`, cierra la app con mensaje.
  - Offline grace period: 7 días con cache vieja. Más allá → pide reconexión.

**Backend (Supabase `hyydkyhvgcekvtkrnspf`)**:
- Tablas: `cc_installations`, `cc_sessions`, `cc_events` (prefijo `cc_` para aislamiento en proyecto compartido).
- Edge functions: `cc-register`, `cc-validate`, `cc-heartbeat`, `cc-events`.
- Revocar un usuario: `UPDATE cc_installations SET status='revoked', revoked_reason='…' WHERE machine_id='…'` en Supabase Studio.
- **Lightning ready**: campos `lightning_address` y `subscription_expires` reservados en `cc_installations` para cobro futuro vía BOLT11 (fuera de scope v1).

**Telemetría** (`lib/telemetry.js`):
- `startSession(machineId, version)` al arrancar → UUID sessionId + heartbeat loop (60s) + flush loop (30s).
- `trackEvent(type, payload)` valida `type` contra whitelist y dropea desconocidos. `scrubPayload` quita campos sensibles (cwd, path, branch, prompt, content, output, token, apiKey) y anonimiza paths en stacks.
- Queue offline en `telemetry-queue.jsonl` (cap 1000 líneas, FIFO). Se drena al próximo flush con éxito.
- `endSession()` en `before-quit` hace flush final + heartbeat final.
- **Eventos whitelisted**: `app_start`, `app_stop`, `panel_toggle`, `panel_tab_view`, `skill_run`, `skill_enqueue`, `scheduler_pause`, `scheduler_resume`, `session_focus`, `session_idle`, `update_available`, `update_applied`, `error`.
- **Puntos de instrumentación**: `main.js` (app_start/stop, scheduler pause/resume, update_available, skill_enqueue manual), `executor.js:370` (skill_run), `notifications.js:88` (session_idle), `index.html` (panel_toggle, panel_tab_view, session_focus).

## Sistema autónomo F1+ (AutonomousOrchestrator)

Sistema paralelo al scheduler basado en **objetivo por proyecto + LLM planner**. Arranca en `app.whenReady` (`main.js:465`) en modo **dry-run por defecto** — observa y planifica, pero no ejecuta hasta que el usuario activa ejecución real desde la pestaña Autónomo.

- **AutonomousOrchestrator** (`lib/autonomous-orchestrator.js`): loop de ticks que para cada proyecto activo llama al planner, registra eventos y (si `dryRun=false`) ejecuta.
- **Planner** (`lib/planner.js` + `planner-pending.js` + `planner-learner.js`): convierte `{objetivo, estado actual, checks}` en acciones concretas. Mantiene una pending queue entre ticks para no duplicar planes. Aprende de resultados (`planner-learner`) para ajustar sugerencias.
- **Evaluator** (`lib/evaluator.js`): evalúa el resultado vs el objetivo del proyecto.
- **Goals** (`lib/goals.js`): 5 plantillas (`production-ready`, `MVP-lanzable`, `mantenimiento`, `explorar-idea`, `seguro-y-testeado`) con sus checks y criterios de éxito. Descritas en `renderer/tab-auto.js:TEMPLATE_DESCRIPTIONS`.
- **Goal suggester** (`lib/goal-suggester.js`): heurística local gratis + opcional Claude Haiku (~1-2k tokens) para sugerir plantilla a partir de README/CLAUDE.md/package.json/commits.
- **Circuit breaker** (`lib/circuit-breaker.js`): corta la ejecución en un proyecto si falla varias veces seguidas en poco tiempo.
- **Auto-PR** (`lib/auto-pr.js`): tras una ejecución con cambios, abre un PR vía `gh pr create` en una rama `claudio/auto/*`.
- **Undo** (`lib/undo.js`): deshace la última ejecución autónoma (reset de rama).
- **Forecast** (`lib/forecast.js`): proyecta uso esperado de tokens por día/ciclo.
- **Digest** (`lib/digest.js`): resumen Claude del estado del sistema autónomo (proyectos activos, eventos recientes, tokens).
- **Telegram bot** (`lib/telegram-bot.js`): notificaciones opt-in de eventos del sistema autónomo.

**Persistencia** (`lib/autonomous-store.js`):
- `~/.claude/claudio-state/autonomous-config.json` — config (dryRun, projects con `objective`, `active`, stack, score).
- `~/.claude/claudio-state/autonomous-events.jsonl` — append-only con todos los eventos (tick-start, plan, action, result, error).

**Tab Autónomo** (`renderer/tab-auto.js`):
- Header con indicador dry-run/real y botón tick-now.
- Fila por proyecto con toggle activar/pausar, stack, score, objetivo, snippet del último evento.
- Drawer de detalle: preview README/CLAUDE.md, análisis Claude Haiku bajo demanda, selector de plantilla.
- Stream `auto:event` (main→renderer) con refresh throttled solo cuando este tab está activo.

**IPC autónomo** (prefijo `auto:*`): `get-config`, `update-config`, `get-project`, `update-project`, `toggle-active`, `set-objective`, `get-events`, `get-status`, `set-dry-run`, `tick-now`, `start`, `stop`, `token-report`, `token-avg`, `get-project-info`, `analyze-project`, `suggest-goal`.

**Coexistencia con el scheduler clásico**: los dos sistemas conviven. El scheduler clásico sigue ejecutando la cola por prioridades/pacing sobre TODOS los proyectos del `orchestrator.json`. El autónomo F1+ sólo actúa en proyectos marcados `active=true` en `autonomous-config.json`.

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
