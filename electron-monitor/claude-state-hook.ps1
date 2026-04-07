param([Parameter(Mandatory=$true)][string]$Status)

$ErrorActionPreference = 'SilentlyContinue'

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$raw = $reader.ReadToEnd()
try { $data = $raw | ConvertFrom-Json } catch { exit 0 }

$cwd = $data.cwd
if (-not $cwd) { exit 0 }

$dir = Join-Path $env:USERPROFILE '.claude\claudio-state'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$sha = [System.Security.Cryptography.SHA1]::Create()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($cwd.ToLower())
$hash = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-','').Substring(0,16)

$file = Join-Path $dir "$hash.json"

# Try to reuse cached hwnd; only re-discover if missing or stale (every ~5 min)
$hwnd = 0
$needHwnd = $true
if (Test-Path $file) {
    try {
        $prev = Get-Content $file -Raw | ConvertFrom-Json
        if ($prev.hwnd -and [int64]$prev.hwnd -ne 0) {
            $hwnd = [int64]$prev.hwnd
            $age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$prev.hwndTs
            if ($age -lt 300) { $needHwnd = $false }
        }
    } catch {}
}

# Only try to capture HWND when this is a user-initiated event (BUSY = user just submitted)
# At that moment GetForegroundWindow points to the WT window hosting this session.
if ($needHwnd -and $Status -eq 'BUSY') {
    try {
        Add-Type -Namespace ClaudioU -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
'@ -ErrorAction SilentlyContinue
        $fg = [ClaudioU.Win]::GetForegroundWindow()
        if ($fg -ne [System.IntPtr]::Zero) {
            $sb = New-Object System.Text.StringBuilder 256
            [ClaudioU.Win]::GetClassName($fg, $sb, 256) | Out-Null
            if ($sb.ToString() -eq 'CASCADIA_HOSTING_WINDOW_CLASS') {
                $hwnd = [int64]$fg
            }
        }
    } catch {}
}

$obj = [PSCustomObject]@{
    status    = $Status
    cwd       = $cwd
    ts        = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    sessionId = $data.session_id
    hwnd      = $hwnd
    hwndTs    = if ($needHwnd -and $hwnd -ne 0) { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() } elseif ($prev) { $prev.hwndTs } else { 0 }
}
$obj | ConvertTo-Json -Compress | Set-Content -Path $file -Encoding UTF8
exit 0
