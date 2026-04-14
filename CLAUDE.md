# claudio_control

Monitor visual de sesiones Claude Code corriendo en Windows Terminal. Barra siempre-encima en la parte superior de la pantalla con un chip por sesión, overlays flotantes con el nombre del proyecto pegados a cada ventana WT, focus por click, multi-select para tile. Notificaciones sonoras (ding-dong) cuando Claude termina. System tray. Auto-update. Single instance.

## Componentes

- **`electron-monitor/`** — app Electron principal (barra + overlays + tile + tray + notificaciones + auto-update)
- **`SessionMonitor/`**, **`ClaudeSession/`** — módulos PowerShell antiguos (versión previa)
- **`instrucciones.html`** — manual de usuario HTML standalone

Arquitectura detallada en los CLAUDE.md de cada subcarpeta.

## Estados y colores

| Status   | Color | Significado                          |
|----------|-------|--------------------------------------|
| BUSY     | Verde | Claude procesando un prompt          |
| WAITING  | Rojo  | Sesión Claude abierta, sin prompt    |
| IDLE     | Rojo  | Shell sin Claude (o esperando input) |

(Verde = trabajando, rojo = no trabajando. Inversión histórica del 2026-04-09.)

## Convenciones del proyecto

- **No hay tests automatizados** en este proyecto. La verificación es manual: reiniciar la app y observar.
- **Reiniciar la app**: `Get-Process electron | Stop-Process -Force` y luego lanzar `npx electron .` desde `electron-monitor/`. Cuidado: `cmd /c` como padre muere si la shell padre cierra → usar `run_in_background` o `Start-Process` desacoplado.
- **state files**: `~/.claude/claudio-state/<sha1-16char>.json`. Se pueden borrar para forzar re-captura del HWND.
- **chime.wav**: se genera automáticamente en `~/.claude/claudio-state/chime.wav`. Borrar para regenerar.
- **Hook config**: en `~/.claude/settings.json`, eventos `UserPromptSubmit` (BUSY) y `Stop`/`SessionStart` (WAITING). Se configura automáticamente con `setup-hook.ps1` o desde el chip amarillo.

## Pendientes / cosas frágiles

- HWND de Claude solo se captura en eventos `BUSY`. Para servicios, match por título de ventana; si no coincide, fallback por posición horizontal.
- Si el usuario mueve una sesión Claude a otra ventana WT (drag tab out), el HWND cacheado queda obsoleto hasta que pasen 5 min o se borre el state file.
- El toggle minimize usa `lastFocusedViaChip` (último HWND enfocado por click en chip), no `GetForegroundWindow` (que siempre devuelve la barra Electron por ser always-on-top).
- CWD fallback a proceso hijo solo se activa si el CWD de la shell es exactamente `$USERPROFILE`.
- State file lookup escanea subdirectorios del cwd, lo que añade I/O. Con muchos state files (50+) podría ralentizar el refresh.
- El chime se reproduce con `powershell.exe` síncrono — bloquea el main process ~0.5s. Si molesta, considerar reproducción asíncrona.
