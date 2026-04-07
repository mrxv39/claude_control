# Test: verificar qué tab index corresponde a cada sesión
# y si wt focus-tab funciona correctamente

Import-Module "$PSScriptRoot\SessionMonitor.psm1" -Force

$sessions = Get-TerminalSessions
Write-Host "`nSesiones detectadas (orden por CreationDate = orden de pestañas asumido):" -ForegroundColor Cyan
Write-Host "=" * 70

foreach ($s in $sessions) {
    $color = switch ($s.Status) {
        'BUSY'    { 'Red' }
        'WAITING' { 'Yellow' }
        default   { 'Green' }
    }
    Write-Host ("  Tab {0}  [{1,-8}]  {2,-20}  {3}" -f $s.TabIndex, $s.Status, $s.Project, $s.CWD) -ForegroundColor $color
}

Write-Host "`n" + "=" * 70
Write-Host "`nAhora vamos a probar: escribe el numero de tab (1-9) para cambiar a esa pestaña."
Write-Host "Escribe 'q' para salir.`n"

while ($true) {
    $input = Read-Host "Tab number"
    if ($input -eq 'q') { break }

    $tabNum = [int]$input
    $tabIdx = $tabNum - 1  # wt usa 0-based

    Write-Host "Ejecutando: wt -w 0 focus-tab -t $tabIdx" -ForegroundColor Yellow
    Start-Process 'wt.exe' -ArgumentList "-w 0 focus-tab -t $tabIdx" -WindowStyle Hidden

    Start-Sleep -Seconds 2
    Write-Host "¿Cambió a la pestaña correcta? (s/n)" -ForegroundColor Cyan
}
