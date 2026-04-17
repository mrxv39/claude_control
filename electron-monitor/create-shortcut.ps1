$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Claudio Control.lnk'
$target = 'C:\Users\Usuario\Documents\Claude\Projects\claudio_control\electron-monitor\dist\ClaudioControl.exe'
$icon = 'C:\Users\Usuario\Documents\Claude\Projects\claudio_control\electron-monitor\icon.ico'

if (-not (Test-Path $target)) { Write-Error "Target missing: $target"; exit 1 }
if (-not (Test-Path $icon))   { Write-Error "Icon missing: $icon"; exit 1 }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $target
$sc.WorkingDirectory = Split-Path $target
$sc.IconLocation = "$icon,0"
$sc.Description = 'Claudio Control - Monitor de sesiones Claude Code'
$sc.Save()

if (Test-Path $lnk) {
    $info = Get-Item $lnk
    Write-Host "OK: $lnk ($($info.Length) bytes)"
} else {
    Write-Error "Shortcut not created"
    exit 1
}
