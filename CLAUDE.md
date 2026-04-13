# claudio_control

Monitor visual de sesiones Claude Code corriendo en Windows Terminal. Barra siempre-encima en la parte superior de la pantalla con un chip por sesión, overlays flotantes con el nombre del proyecto pegados a cada ventana WT, focus por click, multi-select para tile. Notificaciones sonoras (ding-dong) cuando Claude termina. System tray. Auto-update. Single instance.

## Componentes

- **`electron-monitor/`** — app Electron principal (la barra + overlays + tile + tray + notificaciones).
  - `main.js` — proceso principal. Win32 vía koffi (`user32.dll`). Maneja IPC: `get-sessions`, `focus-wt`, `tile-windows`, `resize-bar`, `hide-bar`, `run-setup-hook`. Loop de 100ms reposiciona overlays (con guard `isQuitting` y `isDestroyed()` para evitar crash al cerrar). Enumera ventanas WT con `FindWindowExA` para asignar HWNDs a sesiones sin hook. La barra arranca centrada y recuerda posición. **Single instance** vía `requestSingleInstanceLock()`: si ya hay una instancia corriendo, la segunda se cierra y muestra la existente. **System tray**: el botón ✕ esconde la barra, click/derecho en tray muestra menú (Mostrar/Salir). **Notificaciones**: toast custom (BrowserWindow) + chime WAV generado programáticamente (E6→B5) cuando una sesión pasa de BUSY→WAITING. **Auto-update**: consulta GitHub Releases API al arrancar y cada 6h; si hay versión nueva, envía `update-available` al renderer. **Auto-setup**: comprueba si `~/.claude/settings.json` contiene el hook; si no, envía `hook-missing` al renderer.
  - `index.html` — renderer de la barra. Renderiza chips, gestiona selección multi (Ctrl+click), pide resize (debounced, 100ms) a main. Agrupa sesiones por `cwd`: sesiones Claude + servicios con mismo directorio se fusionan en un solo chip con badges clickables debajo. Tooltips con nombre, cwd, estado, PID. Nombres largos truncados con `text-overflow: ellipsis` (max 160px). Escucha eventos IPC: `update-available` (chip amarillo "Update vX.X"), `hook-missing` (chip amarillo "Configurar hook" con un click).
  - `get-sessions.ps1` — enumera shells hijos de `WindowsTerminal.exe`, detecta Claude, lee estado del hook. Lee `cwd` real vía PEB walk (`NtQueryInformationProcess` + `ReadProcessMemory`). **Fallback CWD**: si la shell reporta `$USERPROFILE`, lee CWD del proceso hijo. **State file lookup**: escanea TODOS los state files cuyo `cwd` sea el directorio de la shell O un subdirectorio suyo, y usa el más reciente (fix: Claude a veces reporta subcarpetas como `project/src-tauri`). **Nombres descriptivos**: `npm run X` → `npm:X`, `tauri dev/build` → `tauri dev`, `cargo run/build/test` → `cargo run`.
  - `claude-state-hook.ps1` — hook de Claude Code. Escribe `~/.claude/claudio-state/<sha1(cwd)>.json`. Solo en `BUSY` captura `GetForegroundWindow()` + verifica `ClassName == 'CASCADIA_HOSTING_WINDOW_CLASS'`. Cachea HWND 5 min.
  - `setup-hook.ps1` — configura hooks en `~/.claude/settings.json` automáticamente. Idempotente (no duplica si ya existe `claude-state-hook` en el comando). Se ejecuta desde el chip amarillo del renderer o manualmente.

- **`SessionMonitor/`**, **`ClaudeSession/`** — módulos PowerShell antiguos importados desde `$PROFILE`. (Versión previa.)

- **`instrucciones.html`** — manual de usuario HTML standalone para usuarios no técnicos.

## Estados y colores

| Status   | Color | Significado                          |
|----------|-------|--------------------------------------|
| BUSY     | Verde | Claude procesando un prompt          |
| WAITING  | Rojo  | Sesión Claude abierta, sin prompt    |
| IDLE     | Rojo  | Shell sin Claude (o esperando input) |

(Verde = trabajando, rojo = no trabajando. Inversión histórica del 2026-04-09.)

## Mecanismo HWND (importante)

WT puede tener **múltiples ventanas en un único proceso** `WindowsTerminal.exe`. La solución:

1. El hook captura `GetForegroundWindow` cuando se dispara con `BUSY` (= el usuario acaba de mandar un prompt → esa ventana WT está en foreground).
2. El HWND se persiste en el state file por cwd.
3. `get-sessions.ps1` lo expone; `index.html` lo manda a `focus-wt`; `main.js` valida `IsWindow(hwnd)` y hace `SetForegroundWindow` directo.

Sesiones sin HWND (no han disparado BUSY, o son servicios):
- `main.js` enumera ventanas WT con `FindWindowExA` y hace match por título de ventana vs nombre de proyecto.
- Si hay match, asigna el HWND.
- Si no, fallback al método antiguo (no fiable con 2+ ventanas WT).
- Para servicios agrupados, fallback al HWND de la sesión Claude del mismo grupo.

## Overlays de título

`main.js` crea un `BrowserWindow` por sesión (frame:false, transparent:true, alwaysOnTop, focusable:false, ignoreMouseEvents) y un loop de 100ms:

- `GetWindowRect` para reposicionar el overlay centrado en la barra de título de cada WT.
- Hit-test en `(left+20, top+50)` con `WindowFromPoint` + `GetAncestor(GA_ROOT)`: si la topmost en ese punto no es la WT, el overlay se oculta.
- Si `IsIconic` o `!IsWindowVisible` → ocultar.
- Guard: si `isQuitting` o `win.isDestroyed()`, skip/delete del Map (evita crash al cerrar).

## Tile

Ctrl+click en chips los añade/quita de un `Set` de selección. En cuanto hay 2+, se llama `tile-windows` con los HWNDs y `MoveWindow` los reparte:

- 1: full · 2: 2x1 · 3: 3x1 · 4: 2x2 · N≥5: `cols=ceil(sqrt(N))`, `rows=ceil(N/cols)`
- Origen `y = workArea.y + 48` para no taparse con la barra siempre-encima.
- `ShowWindow(h, 9)` (SW_RESTORE) antes de mover por si está maximizada.

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

## Notificaciones

Cuando una sesión pasa de BUSY → WAITING:
- `checkStatusChanges()` compara estado actual vs `prevStatus` Map.
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

## Convenciones del proyecto

- **No hay tests automatizados** en este proyecto. La verificación es manual: reiniciar la app y observar.
- **Reiniciar la app**: `Get-Process electron | Stop-Process -Force` y luego lanzar `npx electron .` desde `electron-monitor/`. Cuidado: `cmd /c` como padre muere si la shell padre cierra → usar `run_in_background` o `Start-Process` desacoplado.
- **state files**: `~/.claude/claudio-state/<sha1-16char>.json`. Se pueden borrar para forzar re-captura del HWND.
- **chime.wav**: se genera automáticamente en `~/.claude/claudio-state/chime.wav`. Borrar para regenerar.
- **Hook config**: en `~/.claude/settings.json`, eventos `UserPromptSubmit` (BUSY) y `Stop`/`SessionStart` (WAITING). Se configura automáticamente con `setup-hook.ps1` o desde el chip amarillo.

## Pendientes / cosas frágiles

- HWND de Claude solo se captura en eventos `BUSY`. Para servicios, match por título de ventana; si no coincide, HWND queda en 0.
- Si el usuario mueve una sesión Claude a otra ventana WT (drag tab out), el HWND cacheado queda obsoleto hasta que pasen 5 min o se borre el state file.
- CWD fallback a proceso hijo solo se activa si el CWD de la shell es exactamente `$USERPROFILE`.
- State file lookup escanea subdirectorios del cwd, lo que añade I/O. Con muchos state files (50+) podría ralentizar el refresh.
- El chime se reproduce con `powershell.exe` síncrono — bloquea el main process ~0.5s. Si molesta, considerar reproducción asíncrona.
