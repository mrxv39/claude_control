# claudio_control

Monitor visual de sesiones Claude Code corriendo en Windows Terminal. Barra siempre-encima en la parte superior de la pantalla con un chip por sesión, overlays flotantes con el nombre del proyecto pegados a cada ventana WT, focus por click, multi-select para tile.

## Componentes

- **`electron-monitor/`** — app Electron principal (la barra + overlays + tile).
  - `main.js` — proceso principal. Win32 vía koffi (`user32.dll`). Maneja IPC: `get-sessions`, `focus-wt`, `tile-windows`, `resize-bar`. Loop de 100ms reposiciona overlays. Enumera ventanas WT con `FindWindowExA` para asignar HWNDs a sesiones sin hook (servicios). La barra arranca centrada horizontalmente y recuerda la posición si el usuario la arrastra.
  - `index.html` — renderer de la barra. Renderiza chips, gestiona selección multi (Ctrl+click), pide resize a main tras cada render. Agrupa sesiones por `cwd`: si una sesión Claude y una shell de servicio (ej: `npm run tauri dev`) comparten directorio, se fusionan en un solo chip con badges de servicio clickables debajo.
  - `get-sessions.ps1` — enumera shells (powershell/pwsh/cmd) hijos de `WindowsTerminal.exe`, detecta si están corriendo Claude, lee el estado del state file del hook, devuelve JSON con `pid, hwnd, status, project, cwd, running, isClaude, shell`. Lee `cwd` real del proceso shell vía `NtQueryInformationProcess` + `ReadProcessMemory` (PEB walk). Fallback: si el CWD de la shell es genérico (user home), lee el CWD del proceso hijo. Para sesiones no-Claude, intenta extraer nombres descriptivos del command line (ej: `tauri dev` en vez de `node`).
  - `claude-state-hook.ps1` — hook de Claude Code (configurado en `~/.claude/settings.json`). Recibe el evento por stdin, escribe `~/.claude/claudio-state/<sha1(cwd)>.json` con `{status, cwd, ts, sessionId, hwnd, hwndTs}`. **Solo en `Status=BUSY`** captura `GetForegroundWindow()` y verifica `ClassName == 'CASCADIA_HOSTING_WINDOW_CLASS'` para mapear la sesión a su HWND de WT. Cachea HWND 5 min.

- **`SessionMonitor/`**, **`ClaudeSession/`** — módulos PowerShell antiguos importados desde `$PROFILE`. (Versión previa de la lógica de detección.)

## Estados y colores

| Status   | Color | Significado                          |
|----------|-------|--------------------------------------|
| BUSY     | Verde | Claude procesando un prompt          |
| WAITING  | Rojo  | Sesión Claude abierta, sin prompt    |
| IDLE     | Rojo  | Shell sin Claude (o esperando input) |

(Verde = trabajando, rojo = no trabajando. Inversión histórica del 2026-04-09.)

## Mecanismo HWND (importante)

WT puede tener **múltiples ventanas en un único proceso** `WindowsTerminal.exe`. `FindWindowA('CASCADIA_HOSTING_WINDOW_CLASS', null)` solo devuelve la primera, así que **no se puede usar tab index** para enfocar — los chips colisionarían. La solución:

1. El hook captura `GetForegroundWindow` cuando se dispara con `BUSY` (= el usuario acaba de mandar un prompt → esa ventana WT está en foreground).
2. El HWND se persiste en el state file por cwd.
3. `get-sessions.ps1` lo expone; `index.html` lo manda a `focus-wt`; `main.js` valida `IsWindow(hwnd)` y hace `SetForegroundWindow` directo.

Sesiones que aún no han disparado un BUSY post-instalación tendrán `hwnd=0` → `main.js` intenta asignar HWND enumerando ventanas WT (`FindWindowExA`) y haciendo match por título de ventana vs nombre de proyecto. Fallback final: método antiguo (no fiable con 2+ ventanas WT).

## Overlays de título

`main.js` crea un `BrowserWindow` por sesión (frame:false, transparent:true, alwaysOnTop, focusable:false, ignoreMouseEvents) y un loop de 100ms:

- `GetWindowRect` para reposicionar el overlay centrado en la barra de título de cada WT.
- Hit-test en `(left+20, top+50)` con `WindowFromPoint` + `GetAncestor(GA_ROOT)`: si la topmost en ese punto no es la WT, el overlay se oculta (oclusión por otra ventana).
- Si `IsIconic` o `!IsWindowVisible` → ocultar.

El probe **no** se hace en el centro top porque ahí está el propio overlay (provocaría auto-ocultado en bucle).

## Tile

Ctrl+click en chips los añade/quita de un `Set` de selección. En cuanto hay 2+, se llama `tile-windows` con los HWNDs y `MoveWindow` los reparte:

- 1: full · 2: 2x1 · 3: 3x1 · 4: 2x2 · N≥5: `cols=ceil(sqrt(N))`, `rows=ceil(N/cols)`
- Origen `y = workArea.y + 48` para no taparse con la barra siempre-encima.
- `ShowWindow(h, 9)` (SW_RESTORE) antes de mover por si está maximizada.

## Agrupado de sesiones por proyecto

Sesiones con el mismo `cwd` se agrupan en un solo chip. Si un proyecto tiene una sesión Claude Y una shell ejecutando un servicio (ej: `npm run tauri dev`, `cargo run`), el chip muestra:
- Línea principal: estado Claude (dot + nombre + `[claude (working)]`)
- Línea secundaria: badges de servicio clickables (`⚙ tauri dev`)

Click en el badge de servicio enfoca la ventana WT del servicio. Click en la zona principal enfoca la sesión Claude. Los badges usan el HWND propio del servicio (asignado por enumeración de ventanas WT en `main.js`) o el HWND de la sesión Claude del grupo como fallback.

`get-sessions.ps1` extrae nombres descriptivos del command line: `npm run X` → `npm:X`, `tauri dev/build` → `tauri dev`, `cargo run/build/test` → `cargo run`, `npx X` → `npx:X`.

## Barra autoajustable

Arranca centrada horizontalmente en la pantalla. Si el usuario la arrastra, recuerda la posición (variable `userPosition`). El auto-resize mantiene esa posición (clamped a los bordes). `html/body { width: max-content }` + `bar { display:inline-flex }`. El renderer mide `bar.scrollWidth` tras cada render y llama `resize-bar` (clamp 180–screenWidth). Refresh cada 3s.

## Convenciones del proyecto

- **No hay tests automatizados** en este proyecto. La verificación es manual: reiniciar la app y observar.
- **Reiniciar la app**: `Get-Process electron | Stop-Process -Force` y luego lanzar `npx electron .` desde `electron-monitor/`. Cuidado: `cmd /c` como padre muere si la shell padre cierra → usar `run_in_background` o `Start-Process` desacoplado.
- **state files**: `~/.claude/claudio-state/<sha1-16char>.json`. Se pueden borrar para forzar re-captura del HWND.
- **Hook config**: en `~/.claude/settings.json`, eventos `UserPromptSubmit` (BUSY) y `Stop`/`SessionStart` (WAITING).

## Pendientes / cosas frágiles

- HWND de Claude solo se captura en eventos `BUSY`. Para sesiones sin hook (servicios), `main.js` enumera ventanas WT y hace match por título; si el título no contiene el nombre del proyecto, el HWND queda en 0.
- Si el usuario mueve una sesión Claude a otra ventana WT (drag tab out), el HWND cacheado queda obsoleto hasta que pasen 5 min o se borre el state file.
- Los overlays asumen una pantalla principal (`getPrimaryDisplay`). Multi-monitor puede tener offsets raros.
- CWD fallback a proceso hijo solo se activa si el CWD de la shell es exactamente `$USERPROFILE`. Si la shell está en otro directorio genérico, no se activa.
