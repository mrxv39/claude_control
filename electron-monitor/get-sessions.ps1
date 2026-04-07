Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CwdHelper {
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI pi, int l, out int rl);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint a, bool b, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int sz, out int read);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
    public static string GetCwd(int pid) {
        IntPtr h = OpenProcess(0x0410, false, pid);
        if (h == IntPtr.Zero) return null;
        try {
            var pbi = new PBI(); int rl;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out rl) != 0) return null;
            byte[] b8 = new byte[8]; int br;
            if (!ReadProcessMemory(h, IntPtr.Add(pbi.Peb, 0x20), b8, 8, out br)) return null;
            IntPtr pp = (IntPtr)BitConverter.ToInt64(b8, 0);
            byte[] us = new byte[16];
            if (!ReadProcessMemory(h, IntPtr.Add(pp, 0x38), us, 16, out br)) return null;
            ushort len = BitConverter.ToUInt16(us, 0);
            IntPtr buf = (IntPtr)BitConverter.ToInt64(us, 8);
            if (len == 0 || buf == IntPtr.Zero) return null;
            byte[] pb = new byte[len];
            if (!ReadProcessMemory(h, buf, pb, len, out br)) return null;
            string p = Encoding.Unicode.GetString(pb, 0, br);
            if (p.Length > 3 && p.EndsWith("\\")) p = p.TrimEnd('\\');
            return p;
        } finally { CloseHandle(h); }
    }
}
'@

$allProcs = Get-CimInstance Win32_Process -Property Name, ProcessId, ParentProcessId, CommandLine, CreationDate
$termPids = @($allProcs | Where-Object { $_.Name -eq 'WindowsTerminal.exe' } | ForEach-Object { $_.ProcessId })
$shells = @($allProcs | Where-Object {
    $_.Name -match '^(powershell|pwsh|cmd)\.exe$' -and $_.ParentProcessId -in $termPids
} | Sort-Object CreationDate)

$results = @()
$idx = 0
foreach ($s in $shells) {
    $idx++
    $children = @($allProcs | Where-Object { $_.ParentProcessId -eq $s.ProcessId -and $_.Name -ne 'conhost.exe' })
    $claudeProcs = @($children | Where-Object { $_.Name -match 'claude' -or ($_.CommandLine -and $_.CommandLine -match 'claude') })
    $isClaude = $claudeProcs.Count -gt 0

    $status = 'IDLE'
    $running = '-'
    if ($children.Count -gt 0) {
        if ($isClaude) {
            $cKids = @()
            foreach ($cp in $claudeProcs) {
                $cKids += @($allProcs | Where-Object { $_.ParentProcessId -eq $cp.ProcessId -and $_.Name -ne 'conhost.exe' })
            }
            $nodeKids = @($children | Where-Object { $_.Name -eq 'node.exe' })
            foreach ($nk in $nodeKids) {
                $cKids += @($allProcs | Where-Object { $_.ParentProcessId -eq $nk.ProcessId -and $_.Name -ne 'conhost.exe' })
            }
            if ($cKids.Count -gt 0) { $status = 'BUSY'; $running = 'claude (working)' }
            else { $status = 'WAITING'; $running = 'claude (idle)' }
        } else {
            $status = 'BUSY'
            $running = ($children | ForEach-Object { $_.Name -replace '\.exe$', '' }) -join ', '
        }
    }

    $cwd = try { [CwdHelper]::GetCwd([int]$s.ProcessId) } catch { $null }
    if (-not $cwd) { $cwd = 'N/A' }

    # Override status from hook state file (more reliable than process-tree heuristic)
    $hwnd = 0
    if ($isClaude -and $cwd -ne 'N/A') {
        try {
            $sha = [System.Security.Cryptography.SHA1]::Create()
            $hb  = [System.Text.Encoding]::UTF8.GetBytes($cwd.ToLower())
            $hash = ([BitConverter]::ToString($sha.ComputeHash($hb)) -replace '-','').Substring(0,16)
            $stateFile = Join-Path $env:USERPROFILE ".claude\claudio-state\$hash.json"
            if (Test-Path $stateFile) {
                $st = Get-Content $stateFile -Raw | ConvertFrom-Json
                # Stale-guard: ignore if older than 1 hour
                $age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$st.ts
                if ($age -lt 3600) {
                    $status = $st.status
                    if ($status -eq 'BUSY') { $running = 'claude (working)' }
                    elseif ($status -eq 'WAITING') { $running = 'claude (idle)' }
                }
                if ($st.hwnd) { $hwnd = [int64]$st.hwnd }
            }
        } catch {}
    }

    $leaf = Split-Path $cwd -Leaf
    $generic = @('Usuario', 'Users', 'Desktop', 'Documents', 'Home', 'user', 'home')
    $project = '?'
    if ($leaf -and $leaf -notin $generic) { $project = $leaf }
    elseif ($leaf) {
        $parts = $cwd -split '\\'
        if ($parts.Count -ge 2) { $project = $parts[-2] + '\' + $parts[-1] }
        else { $project = $leaf }
    }

    $results += [PSCustomObject]@{
        pid      = $s.ProcessId
        tabIndex = $idx
        hwnd     = $hwnd
        status   = $status
        project  = $project
        cwd      = $cwd
        running  = $running
        isClaude = $isClaude
        shell    = ($s.Name -replace '\.exe$', '')
    }
}

$results | ConvertTo-Json -Compress
