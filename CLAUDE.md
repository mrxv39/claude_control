# claudio_control

Monitor visual de sesiones Claude Code corriendo en Windows Terminal. Barra siempre-encima en la parte superior de la pantalla con un chip por sesión, overlays flotantes con el nombre del proyecto pegados a cada ventana WT, focus por click, multi-select para tile.

## Componentes

- **`electron-monitor/`** — app Electron principal (la barra + overlays + tile).
  - `main.js` — proceso principal. Win32 vía koffi (`user32.dll`). Maneja IPC: `get-sessions`, `focus-wt`, `tile-windows`, `resize-bar`. Loop de 100ms reposiciona overlays.
  - `index.html` — renderer de la barra. Renderiza chips, gestiona selección multi (Ctrl+click), pide resize a main tras cada render.
  - `get-sessions.ps1` — enumera shells (powershell/pwsh/cmd) hijos de `WindowsTerminal.exe`, detecta si están corriendo Claude, lee el estado del state file del hook, devuelve JSON con `pid, hwnd, status, project, cwd, running, isClaude, shell`. Lee `cwd` real del proceso shell vía `NtQueryInformationProcess` + `ReadProcessMemory` (PEB walk).
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

Sesiones que aún no han disparado un BUSY post-instalación tendrán `hwnd=0` → fallback al método antiguo (no fiable con 2+ ventanas WT).

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

## Barra autoajustable

`html/body { width: max-content }` + `bar { display:inline-flex }`. El renderer mide `bar.scrollWidth` tras cada render y llama `resize-bar` (clamp 180–screenWidth). Refresh cada 3s.

## Convenciones del proyecto

- **No hay tests automatizados** en este proyecto. La verificación es manual: reiniciar la app y observar.
- **Reiniciar la app**: `Get-Process electron | Stop-Process -Force` y luego lanzar `npx electron .` desde `electron-monitor/`. Cuidado: `cmd /c` como padre muere si la shell padre cierra → usar `run_in_background` o `Start-Process` desacoplado.
- **state files**: `~/.claude/claudio-state/<sha1-16char>.json`. Se pueden borrar para forzar re-captura del HWND.
- **Hook config**: en `~/.claude/settings.json`, eventos `UserPromptSubmit` (BUSY) y `Stop`/`SessionStart` (WAITING).

## Pendientes / cosas frágiles

- HWND solo se captura en eventos `BUSY`. Si la primera vez que el usuario abre la app no ha mandado prompt aún, el chip cae al fallback y los clicks pueden colisionar entre ventanas WT.
- Si el usuario mueve una sesión Claude a otra ventana WT (drag tab out), el HWND cacheado queda obsoleto hasta que pasen 5 min o se borre el state file.
- Los overlays asumen una pantalla principal (`getPrimaryDisplay`). Multi-monitor puede tener offsets raros.
