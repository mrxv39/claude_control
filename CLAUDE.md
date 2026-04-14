# claudio_control

Monitor visual + orquestador autónomo de sesiones Claude Code en Windows Terminal. Barra siempre-encima con chips de estado por sesión, overlays flotantes, focus por click, multi-select para tile, notificaciones sonoras. Panel desplegable con análisis de salud de proyectos, cola de tareas autónomas, y log de conversación. Ejecución programada de skills fuera de horario laboral.

## Componentes

- **`electron-monitor/`** — app Electron principal (barra + overlays + tile + tray + notificaciones + auto-update)
- **`electron-monitor/lib/`** — módulos del orquestador:
  - `orchestrator-store.js` — persistencia en `~/.claude/claudio-state/orchestrator.json`
  - `project-scanner.js` — descubrimiento de proyectos en directorios configurados
  - `project-analyzer.js` — health checks locales (CLAUDE.md, tests, git, deps)
  - `executor.js` — ejecuta `claude --print` en ramas auto-creadas
  - `scheduler.js` — planificador autónomo fuera de horario laboral
  - `git-status.js` — rama y dirty count por proyecto
  - `conversation-reader.js` — lee JSONL de sesiones para log display
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
- **orchestrator.json**: `~/.claude/claudio-state/orchestrator.json` — config del orquestador (projectDirs, workHours, budget, proyectos, cola).
- **orchestrator-log.jsonl**: historial de ejecuciones autónomas (append-only).
- **runs/**: `~/.claude/claudio-state/runs/<id>.log` — output de cada ejecución.

## Orquestador autónomo

- **Panel**: botón ⚙ en la barra abre panel de 400px con tabs Salud/Cola/Log.
- **Salud**: escanea `Desktop/proyectos`, score 1-10, checks locales gratis.
- **Cola**: scheduler ejecuta skills, siempre en rama `claudio/auto/*`.
- **Skills**: audit-claude-md, security-review, dep-update, simplify, add-tests, git-cleanup.
- **Modelos**: opus (security-review, simplify, add-tests), sonnet (audit, dep-update, git-cleanup).
- **Pacing**: curva `progress^0.6 × 95%` para maximizar tokens del ciclo de 5h. Modos: burst (15s), accelerate (30s), pace (60s), coast (120s).
- **Prioridades**: high (≤7d), medium (8-30d), low (31-90d, solo si no hay high/medium), ignored (>90d).
- **Seguridad**: nunca toca master, nunca push. Sin budget artificial (Max plan).
- **statusLine hook**: `~/.claude/settings.json` → escribe `rate-limits.json` con rate limits, contexto, coste.
- **Git badges**: rama + dirty count + contexto % en cada chip de sesión.

## Pendientes / cosas frágiles

- HWND de Claude solo se captura en eventos `BUSY`. Para servicios, match por título de ventana; si no coincide, fallback por posición horizontal.
- Si el usuario mueve una sesión Claude a otra ventana WT (drag tab out), el HWND cacheado queda obsoleto hasta que pasen 5 min o se borre el state file.
- El toggle minimize usa `lastFocusedViaChip` (último HWND enfocado por click en chip), no `GetForegroundWindow` (que siempre devuelve la barra Electron por ser always-on-top).
- CWD fallback a proceso hijo solo se activa si el CWD de la shell es exactamente `$USERPROFILE`.
- State file lookup escanea subdirectorios del cwd, lo que añade I/O. Con muchos state files (50+) podría ralentizar el refresh.
- El chime se reproduce con `powershell.exe` síncrono — bloquea el main process ~0.5s. Si molesta, considerar reproducción asíncrona.
