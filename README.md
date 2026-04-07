# claudio_control

Monitor y control de sesiones de Claude Code para Windows Terminal.

## Problema

Cuando tienes varias pestañas de Windows Terminal con Claude Code, todas muestran "Claude Code" como título — imposible saber cuál es cuál. Tampoco hay forma de ver de un vistazo qué consolas están trabajando y cuáles esperan input.

## Solución

Dos herramientas PowerShell sin dependencias externas:

### 1. `claude-session` — Título de pestaña inteligente

Wrapper que lanza Claude Code fijando el título del tab al nombre del proyecto.

```powershell
# Lanza Claude en la carpeta indicada — tab muestra "🤖 ipokertools"
claude-session C:\Projects\ipokertools

# Desde el directorio actual
cs

# Pasa argumentos a Claude
cs --dangerously-skip-permissions
cs -p "explica este código"
```

### 2. `Start-SessionMonitor` — Dashboard de sesiones

TUI que muestra todas las pestañas de terminal abiertas con su estado en tiempo real.

```
╔══════════════════════════════════════════════════════════════════════╗
║  TERMINAL SESSION MONITOR                     Updated: 15:42:03    ║
╠══════════════════════════════════════════════════════════════════════╣
║  #   STATUS     PROJECT              RUNNING           SHELL       ║
╠══════════════════════════════════════════════════════════════════════╣
║  1   🔴 BUSY    🤖 ipokertools       claude             powershell ║
║  2   🟢 IDLE    claudio_control      -                  powershell ║
║  3   🔴 BUSY    mysite               node               pwsh       ║
╠══════════════════════════════════════════════════════════════════════╣
║  3 sessions | 2 busy | 1 idle              [Q] Quit  [R] Refresh  ║
╚══════════════════════════════════════════════════════════════════════╝
```

- Refresco cada 2 segundos sin parpadeo
- Detecta automáticamente sesiones de Claude (icono 🤖)
- `Q` para salir, `R` para refresh inmediato

```powershell
# Abrir en una pestaña dedicada
Start-SessionMonitor

# Refresh cada 5 segundos
Start-SessionMonitor -RefreshSeconds 5

# Incluir la propia pestaña del monitor
Start-SessionMonitor -IncludeSelf
```

## Instalación

```powershell
cd C:\Users\Usuario\Documents\Claude\Projects\claudio_control
.\Install.ps1
```

Esto agrega los módulos al perfil de PowerShell. Para cargar sin reiniciar:

```powershell
. $PROFILE
```

## Requisitos

- Windows 10/11
- Windows Terminal
- PowerShell 5.1+ o PowerShell 7+
- Claude Code CLI instalado

## Cómo funciona

**ClaudeSession**: Fija el título del tab via `$Host.UI.RawUI.WindowTitle` + secuencias de escape OSC, y usa la variable `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` para impedir que Claude lo sobreescriba. Restaura el título al salir.

**SessionMonitor**: Usa `Get-CimInstance Win32_Process` para detectar shells cuyo proceso padre es Windows Terminal. Clasifica como BUSY si tienen procesos hijos (excluyendo conhost.exe). Obtiene el directorio de trabajo de cada shell leyendo el PEB del proceso via P/Invoke (`NtQueryInformationProcess` + `ReadProcessMemory`).
