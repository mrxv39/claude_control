<#
.SYNOPSIS
    Instala claudio_control en el perfil de PowerShell.

.DESCRIPTION
    Agrega Import-Module para ClaudeSession y SessionMonitor al $PROFILE.
    Es idempotente: si ya están las líneas, no las duplica.

.EXAMPLE
    .\Install.ps1
#>

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$claudeSessionModule = Join-Path $scriptDir 'ClaudeSession\ClaudeSession.psm1'
$sessionMonitorModule = Join-Path $scriptDir 'SessionMonitor\SessionMonitor.psm1'

# Verificar que los módulos existen
if (-not (Test-Path $claudeSessionModule)) {
    Write-Error "No se encontró ClaudeSession.psm1 en: $claudeSessionModule"
    return
}
if (-not (Test-Path $sessionMonitorModule)) {
    Write-Error "No se encontró SessionMonitor.psm1 en: $sessionMonitorModule"
    return
}

# Líneas a agregar al perfil
$importLines = @(
    "",
    "# claudio_control - Monitor y control de sesiones Claude",
    "Import-Module `"$claudeSessionModule`"",
    "Import-Module `"$sessionMonitorModule`""
)

# Crear $PROFILE si no existe
if (-not (Test-Path $PROFILE)) {
    $profileDir = Split-Path -Parent $PROFILE
    if (-not (Test-Path $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    }
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    Write-Host "[OK] Creado perfil de PowerShell: $PROFILE" -ForegroundColor Green
}

# Leer contenido actual
$profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
if (-not $profileContent) { $profileContent = '' }

# Verificar si ya está instalado
if ($profileContent -match 'claudio_control') {
    Write-Host "[INFO] claudio_control ya está en el perfil. No se realizaron cambios." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Para reinstalar, elimina las líneas de claudio_control de: $PROFILE"
    return
}

# Agregar al perfil
$importBlock = $importLines -join "`n"
Add-Content -Path $PROFILE -Value $importBlock

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  claudio_control instalado con éxito" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Comandos disponibles (en nuevas ventanas de PowerShell):" -ForegroundColor White
Write-Host ""
Write-Host "  claude-session [ruta]    Lanza Claude con título del proyecto" -ForegroundColor Green
Write-Host "  cs [ruta]               Alias corto de claude-session" -ForegroundColor Green
Write-Host "  Start-SessionMonitor    Dashboard de sesiones en tiempo real" -ForegroundColor Green
Write-Host "  Get-TerminalSessions    Lista sesiones (para scripts)" -ForegroundColor Green
Write-Host ""
Write-Host "Ejemplo:" -ForegroundColor Yellow
Write-Host "  cs C:\Projects\miproyecto          # Tab: `u{1F916} miproyecto"
Write-Host "  Start-SessionMonitor               # Abre el dashboard"
Write-Host ""
Write-Host "Perfil modificado: $PROFILE" -ForegroundColor DarkGray
Write-Host "Para cargar ahora sin reiniciar:  . `$PROFILE" -ForegroundColor DarkGray
