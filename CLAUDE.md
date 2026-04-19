# claudio_control

Monitor visual + orquestador autónomo de sesiones Claude Code en Windows Terminal. Barra siempre-encima con chips de estado por sesión, overlays flotantes, focus por click, multi-select para tile, notificaciones sonoras. Panel desplegable con análisis de salud de proyectos, cola de tareas autónomas, y log de conversación. Ejecución programada de skills fuera de horario laboral.

## Componentes

- **`electron-monitor/`** — app Electron principal (barra + overlays + tile + tray + notificaciones + auto-update + license gate). Módulos `lib/` documentados en `electron-monitor/CLAUDE.md`.
- **`supabase/functions/`** — edge functions para licencias/telemetría (`cc-register`, `cc-validate`, `cc-heartbeat`, `cc-events`) desplegadas en proyecto Supabase compartido.
- **`SessionMonitor/`**, **`ClaudeSession/`** — módulos PowerShell antiguos (versión previa).
- **`instrucciones.html`** — manual de usuario HTML standalone.

Arquitectura detallada en los CLAUDE.md de cada subcarpeta.

## Estados y colores

| Status   | Color | Significado                          |
|----------|-------|--------------------------------------|
| BUSY     | Verde | Claude procesando un prompt          |
| WAITING  | Rojo  | Sesión Claude abierta, sin prompt    |
| IDLE     | Rojo  | Shell sin Claude (o esperando input) |

(Verde = trabajando, rojo = no trabajando. Inversión histórica del 2026-04-09.)

## Convenciones del proyecto

- **Tests**: `npm test` (vitest) en `electron-monitor/` — 757 tests en 36 archivos. Módulos con FFI/Electron se verifican manualmente reiniciando la app.
- **Reiniciar la app**: `Get-Process electron | Stop-Process -Force` y luego lanzar `npx electron .` desde `electron-monitor/`. Cuidado: `cmd /c` como padre muere si la shell padre cierra → usar `run_in_background` o `Start-Process` desacoplado.
- **state files**: `~/.claude/claudio-state/<sha1-16char>.json`. Se pueden borrar para forzar re-captura del HWND.
- **chime.wav**: se genera automáticamente en `~/.claude/claudio-state/chime.wav`. Borrar para regenerar.
- **Hook config**: en `~/.claude/settings.json`, eventos `UserPromptSubmit` (BUSY) y `Stop`/`SessionStart` (WAITING). Se configura automáticamente con `setup-hook.ps1` o desde el chip amarillo.
- **orchestrator.json**: `~/.claude/claudio-state/orchestrator.json` — config del orquestador (projectDirs, workHours, budget, proyectos, cola).
- **orchestrator-log.jsonl**: historial de ejecuciones autónomas (append-only).
- **runs/**: `~/.claude/claudio-state/runs/<id>.log` — output de cada ejecución.
- **token-history.jsonl**: `~/.claude/claudio-state/token-history.jsonl` — historial de uso por ciclo 5h (append-only).

## Orquestador autónomo

- **Panel**: botón ⚙ en la barra abre panel de 400px con tabs Salud/Cola/Log/Stats.
- **Stats tab**: gráfico de uso por ciclo 5h, costes (hoy/semana/mes), actividad por skill, heatmap de proyectos.
- **Salud**: escanea `Desktop/proyectos`, score 1-10, checks locales gratis. Score se re-calcula tras cada tarea.
- **Cola**: scheduler ejecuta skills en paralelo (2-3 tareas simultáneas en proyectos distintos), siempre en rama `claudio/auto/*`.
- **15 Skills**: audit-claude-md, security-review, dep-update, simplify, add-tests, git-cleanup, ui-polish, supabase-audit, perf-audit, fix-types + 5 community (webapp-testing, frontend-design, trailofbits-security, pdf, ccusage).
- **Modelos**: opus (security-review, simplify, add-tests, supabase-audit), sonnet (audit, dep-update, git-cleanup, ui-polish, perf-audit, fix-types).
- **Pacing**: curva `progress^0.6 × 95%` para maximizar tokens del ciclo de 5h. Modos: burst (15s), accelerate (30s), pace (60s), coast (120s).
- **Prioridades**: high (≤7d), medium (8-30d), low (31-90d, solo si high/medium no tienen skills disponibles), ignored (>90d).
- **Per-project busy**: el scheduler ejecuta tareas en proyectos donde el usuario NO tiene sesión Claude activa. No bloquea todo por una sesión.
- **Timezone**: usa `config.timezone` (default `Europe/Madrid`) en vez de hora del sistema (que está en UTC+7).
- **Timeouts**: idle timeout 120s (sin output = hung), watchdog 8 min, retry automático 1 vez en timeout.
- **Seguridad**: nunca toca master, nunca push. Sin budget artificial (Max plan).
- **statusLine hook**: `~/.claude/settings.json` → escribe `rate-limits.json` con rate limits, contexto, coste.
- **Git badges**: rama + dirty count + contexto % en el overlay de título de cada ventana WT (no en los chips).

## Pendientes / cosas frágiles

- HWND de Claude solo se captura en eventos `BUSY`. Para servicios, match por título de ventana; si no coincide, fallback por posición horizontal.
- Si el usuario mueve una sesión Claude a otra ventana WT (drag tab out), el HWND cacheado queda obsoleto hasta que pasen 5 min o se borre el state file.
- El toggle minimize usa `lastFocusedViaChip` (último HWND enfocado por click en chip), no `GetForegroundWindow` (que siempre devuelve la barra Electron por ser always-on-top).
- CWD fallback a proceso hijo solo se activa si el CWD de la shell es exactamente `$USERPROFILE`.
- State file lookup escanea subdirectorios del cwd, lo que añade I/O. Con muchos state files (50+) podría ralentizar el refresh.
- La barra se registra como AppBar (SHAppBarMessage) — apps maximizadas no la tapan. Se desregistra al ocultar/abrir panel.
