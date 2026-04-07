# Switch-Tab.ps1 - Cambia a una pestaña de Windows Terminal
param([int]$TabIndex)

if ($TabIndex -lt 1 -or $TabIndex -gt 9) { exit 1 }

$logFile = "C:\Users\Usuario\Documents\Claude\Projects\claudio_control\SessionMonitor\switch_log.txt"

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;

public static class TabSwitcher
{
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP = 0x0101;
    private const uint WM_SYSKEYDOWN = 0x0104;
    private const uint WM_SYSKEYUP = 0x0105;

    public static string Switch(int tabNumber)
    {
        Process[] procs = Process.GetProcessesByName("WindowsTerminal");
        if (procs.Length == 0) return "ERROR: No WT process";

        IntPtr hWnd = procs[0].MainWindowHandle;
        if (hWnd == IntPtr.Zero) return "ERROR: No WT handle";

        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        SetForegroundWindow(hWnd);
        Thread.Sleep(200);

        // Send Ctrl+Alt+N via PostMessage
        // Ctrl down
        PostMessage(hWnd, WM_KEYDOWN, (IntPtr)0x11, IntPtr.Zero);
        // Alt+N down (WM_SYSKEYDOWN because Alt is involved)
        PostMessage(hWnd, WM_SYSKEYDOWN, (IntPtr)0x12, (IntPtr)0x20000001);
        // Number key with Ctrl+Alt flags in lParam
        int vkNumber = 0x30 + tabNumber;
        PostMessage(hWnd, WM_SYSKEYDOWN, (IntPtr)vkNumber, (IntPtr)0x20000001);
        Thread.Sleep(50);
        // Release
        PostMessage(hWnd, WM_SYSKEYUP, (IntPtr)vkNumber, (IntPtr)0xE0000001);
        PostMessage(hWnd, WM_SYSKEYUP, (IntPtr)0x12, (IntPtr)0xC0000001);
        PostMessage(hWnd, WM_KEYUP, (IntPtr)0x11, (IntPtr)0xC0000001);

        return string.Format("OK: PostMessage tab {0} to hwnd {1}", tabNumber, hWnd);
    }
}
'@

$ts = Get-Date -Format 'HH:mm:ss.fff'
$result = [TabSwitcher]::Switch($TabIndex)
Add-Content -Path $logFile -Value "$ts $result"
