<#
.SYNOPSIS
    Configura el hook de Claude Code para Claudio Control.
    Ejecutar una vez despues de instalar.
#>

$ErrorActionPreference = 'Stop'

# Find the hook script: next to this script, or in resources folder
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hookScript = Join-Path $scriptDir 'claude-state-hook.ps1'
if (-not (Test-Path $hookScript)) {
    # Try parent/resources (packaged app)
    $hookScript = Join-Path (Split-Path $scriptDir) 'resources\claude-state-hook.ps1'
}
if (-not (Test-Path $hookScript)) {
    Write-Host "[ERROR] No se encontro claude-state-hook.ps1" -ForegroundColor Red
    Write-Host "Asegurate de ejecutar este script desde la carpeta de Claudio Control."
    pause
    exit 1
}

$hookPath = $hookScript -replace '\\', '\\'
$settingsFile = Join-Path $env:USERPROFILE '.claude\settings.json'
$settingsDir = Split-Path $settingsFile

# Create .claude dir if needed
if (-not (Test-Path $settingsDir)) {
    New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null
}

# Build hook entries
$hookCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$hookPath`""

$busyHook = @{ type = "command"; command = "$hookCmd -Status BUSY" }
$waitHook = @{ type = "command"; command = "$hookCmd -Status WAITING" }

# Load or create settings
$settings = @{}
if (Test-Path $settingsFile) {
    try {
        $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json -AsHashtable
    } catch {
        $settings = @{}
    }
}

if (-not $settings.ContainsKey('hooks')) { $settings['hooks'] = @{} }
$hooks = $settings['hooks']

# Helper: add hook if not already present (check by substring match on hook script name)
function Add-HookIfMissing($eventName, $hookObj) {
    if (-not $hooks.ContainsKey($eventName)) { $hooks[$eventName] = @() }
    $existing = $hooks[$eventName]
    $already = $false
    foreach ($h in $existing) {
        if ($h.command -and $h.command -match 'claude-state-hook') { $already = $true; break }
    }
    if (-not $already) {
        $hooks[$eventName] = @($existing) + @($hookObj)
    }
}

Add-HookIfMissing 'UserPromptSubmit' $busyHook
Add-HookIfMissing 'Stop' $waitHook
Add-HookIfMissing 'SessionStart' $waitHook

$settings['hooks'] = $hooks

# Write settings
$settings | ConvertTo-Json -Depth 10 | Set-Content -Path $settingsFile -Encoding UTF8

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  Claudio Control - Hook configurado OK" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Se ha configurado el hook en:" -ForegroundColor White
Write-Host "  $settingsFile" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Ya puedes:" -ForegroundColor White
Write-Host "  1. Abrir sesiones de Claude Code en Windows Terminal" -ForegroundColor Cyan
Write-Host "  2. Ejecutar ClaudioControl.exe" -ForegroundColor Cyan
Write-Host ""
pause
