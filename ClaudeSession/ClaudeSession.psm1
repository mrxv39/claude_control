<#
.SYNOPSIS
    Wrapper para Claude Code que fija el título del tab con el nombre del proyecto.

.DESCRIPTION
    Módulo que exporta Invoke-ClaudeSession (alias: claude-session, cs).
    Fija el título del tab de Windows Terminal al nombre de la carpeta del proyecto,
    impide que Claude Code lo sobreescriba, y lo restaura al salir.
#>

function Invoke-ClaudeSession {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$Path,

        [string]$Prefix = "`u{1F916}",

        [switch]$NoRestore,

        [Parameter(ValueFromRemainingArguments)]
        [string[]]$ClaudeArgs
    )

    # Determinar si el primer argumento es una ruta o un argumento de claude
    $targetPath = $null
    $extraArgs = @()

    if ($Path) {
        if (Test-Path $Path -PathType Container) {
            $targetPath = $Path
        } else {
            # No es una carpeta, tratar como argumento de claude
            $extraArgs += $Path
        }
    }

    if ($ClaudeArgs) {
        $extraArgs += $ClaudeArgs
    }

    # Resolver nombre del proyecto
    if ($targetPath) {
        $resolvedPath = Resolve-Path $targetPath
    } else {
        $resolvedPath = Get-Location
    }
    $projectName = Split-Path $resolvedPath -Leaf

    # Guardar título original
    $originalTitle = $Host.UI.RawUI.WindowTitle

    # Fijar título del tab
    $newTitle = "$Prefix $projectName"
    $Host.UI.RawUI.WindowTitle = $newTitle
    [Console]::Write("`e]0;$newTitle`a")

    # Prevenir que Claude sobreescriba el título
    $hadEnvVar = Test-Path Env:\CLAUDE_CODE_DISABLE_TERMINAL_TITLE
    $oldEnvVal = $env:CLAUDE_CODE_DISABLE_TERMINAL_TITLE
    $env:CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1"

    try {
        if ($targetPath) {
            Push-Location $resolvedPath
        }

        # Lanzar claude pasando todos los argumentos
        if ($extraArgs.Count -gt 0) {
            & claude @extraArgs
        } else {
            & claude
        }
    }
    finally {
        if ($targetPath) {
            Pop-Location
        }

        # Restaurar título
        if ($NoRestore) {
            $doneTitle = "$Prefix $projectName (done)"
            $Host.UI.RawUI.WindowTitle = $doneTitle
            [Console]::Write("`e]0;$doneTitle`a")
        } else {
            $Host.UI.RawUI.WindowTitle = $originalTitle
            [Console]::Write("`e]0;$originalTitle`a")
        }

        # Restaurar variable de entorno
        if ($hadEnvVar) {
            $env:CLAUDE_CODE_DISABLE_TERMINAL_TITLE = $oldEnvVal
        } else {
            Remove-Item Env:\CLAUDE_CODE_DISABLE_TERMINAL_TITLE -ErrorAction SilentlyContinue
        }
    }
}

Set-Alias -Name claude-session -Value Invoke-ClaudeSession
Set-Alias -Name cs -Value Invoke-ClaudeSession

Export-ModuleMember -Function Invoke-ClaudeSession -Alias claude-session, cs
