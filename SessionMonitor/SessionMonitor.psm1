<#
.SYNOPSIS
    Monitor de sesiones de terminal - barra superior estilo taskbar.

.DESCRIPTION
    Barra fina anclada en la parte superior de la pantalla que muestra todas
    las sesiones de terminal abiertas con su estado (BUSY/IDLE) como chips
    horizontales con color. Siempre visible, siempre encima.
#>

# ============================================================================
# C# helper: lee el Current Working Directory de un proceso via PEB
# ============================================================================

$cwdHelperSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CwdHelper
{
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength,
        out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(
        IntPtr hProcess, IntPtr lpBaseAddress,
        byte[] lpBuffer, int dwSize, out int lpNumberOfBytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    public static string GetCurrentDirectory(int processId)
    {
        IntPtr hProcess = IntPtr.Zero;
        try
        {
            hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, processId);
            if (hProcess == IntPtr.Zero)
                return null;

            var pbi = new PROCESS_BASIC_INFORMATION();
            int returnLength;
            int status = NtQueryInformationProcess(hProcess, 0, ref pbi, Marshal.SizeOf(pbi), out returnLength);
            if (status != 0)
                return null;

            byte[] buffer = new byte[8];
            int bytesRead;
            if (!ReadProcessMemory(hProcess, IntPtr.Add(pbi.PebBaseAddress, 0x20), buffer, 8, out bytesRead))
                return null;
            IntPtr processParametersPtr = (IntPtr)BitConverter.ToInt64(buffer, 0);

            byte[] unicodeStringBuf = new byte[16];
            if (!ReadProcessMemory(hProcess, IntPtr.Add(processParametersPtr, 0x38), unicodeStringBuf, 16, out bytesRead))
                return null;

            ushort length = BitConverter.ToUInt16(unicodeStringBuf, 0);
            IntPtr bufferPtr = (IntPtr)BitConverter.ToInt64(unicodeStringBuf, 8);

            if (length == 0 || bufferPtr == IntPtr.Zero)
                return null;

            byte[] pathBuf = new byte[length];
            if (!ReadProcessMemory(hProcess, bufferPtr, pathBuf, length, out bytesRead))
                return null;

            string path = Encoding.Unicode.GetString(pathBuf, 0, bytesRead);
            if (path.Length > 3 && path.EndsWith("\\"))
                path = path.TrimEnd('\\');
            return path;
        }
        catch
        {
            return null;
        }
        finally
        {
            if (hProcess != IntPtr.Zero)
                CloseHandle(hProcess);
        }
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'CwdHelper').Type) {
    Add-Type -TypeDefinition $cwdHelperSource -Language CSharp
}

# ============================================================================
# C# helper: traer ventana al frente y enviar teclas
# ============================================================================

$windowHelperSource = @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;

public static class WindowHelper
{
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION union;
    }

    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_MENU = 0x12;

    private static INPUT MakeKey(ushort vk, bool up)
    {
        var input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.union.ki.wVk = vk;
        input.union.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        return input;
    }

    public static IntPtr FindWT()
    {
        Process[] procs = Process.GetProcessesByName("WindowsTerminal");
        if (procs.Length == 0) return IntPtr.Zero;
        return procs[0].MainWindowHandle;
    }

    public static string SwitchToTab(int tabNumber)
    {
        IntPtr hWnd = FindWT();
        if (hWnd == IntPtr.Zero) return "ERROR: No WT";
        if (tabNumber < 1 || tabNumber > 9) return "ERROR: Bad tab number";

        // Bring WT to front
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
        SetForegroundWindow(hWnd);

        // Wait until WT is foreground
        for (int i = 0; i < 20; i++)
        {
            Thread.Sleep(50);
            if (GetForegroundWindow() == hWnd) break;
            SetForegroundWindow(hWnd);
        }

        if (GetForegroundWindow() != hWnd)
            return "ERROR: Could not bring WT to foreground";

        // Send Ctrl+Alt+N via SendInput
        ushort vkNumber = (ushort)(0x30 + tabNumber);
        INPUT[] inputs = new INPUT[]
        {
            MakeKey(VK_CONTROL, false),
            MakeKey(VK_MENU, false),
            MakeKey(vkNumber, false),
            MakeKey(vkNumber, true),
            MakeKey(VK_MENU, true),
            MakeKey(VK_CONTROL, true),
        };

        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        return string.Format("OK: sent={0}/6 tab={1}", sent, tabNumber);
    }
}
'@

if (-not ([System.Management.Automation.PSTypeName]'WindowHelper').Type) {
    Add-Type -TypeDefinition $windowHelperSource -Language CSharp
}

# ============================================================================
# Get-TerminalSessions
# ============================================================================

function Get-TerminalSessions {
    [CmdletBinding()]
    param()

    $allProcs = Get-CimInstance Win32_Process -Property Name, ProcessId, ParentProcessId, CommandLine, CreationDate

    $terminalPids = @($allProcs |
        Where-Object { $_.Name -eq 'WindowsTerminal.exe' } |
        ForEach-Object { $_.ProcessId })

    # Encontrar shells cuyo padre es Windows Terminal, ordenados por creación (= orden de pestañas)
    $shells = @($allProcs | Where-Object {
        $_.Name -match '^(powershell|pwsh|cmd)\.exe$' -and
        $_.ParentProcessId -in $terminalPids
    } | Sort-Object CreationDate)

    $myPid = $PID
    $tabIndex = 0

    foreach ($shell in $shells) {
        $tabIndex++
        $shellPid = $shell.ProcessId

        # Hijos directos del shell (excluyendo conhost)
        $children = @($allProcs | Where-Object {
            $_.ParentProcessId -eq $shellPid -and
            $_.Name -ne 'conhost.exe'
        })

        # Detectar si algún hijo es Claude
        $claudeProcs = @($children | Where-Object {
            $_.Name -match 'claude' -or
            ($_.CommandLine -and $_.CommandLine -match 'claude')
        })
        $isClaude = $claudeProcs.Count -gt 0

        # Determinar estado BUSY/IDLE:
        # - Sin hijos = IDLE (shell esperando input)
        # - Con hijos pero es solo Claude sin subprocesos propios = WAITING (Claude espera input del usuario)
        # - Con hijos y Claude tiene subprocesos = BUSY (Claude está trabajando)
        # - Con hijos no-Claude = BUSY (otro proceso ejecutándose)

        $status = 'IDLE'
        $runningProcs = '-'

        if ($children.Count -gt 0) {
            if ($isClaude) {
                # Claude está corriendo - verificar si Claude tiene hijos propios (está trabajando)
                $claudeChildren = @()
                foreach ($cp in $claudeProcs) {
                    $claudeChildren += @($allProcs | Where-Object {
                        $_.ParentProcessId -eq $cp.ProcessId -and
                        $_.Name -ne 'conhost.exe'
                    })
                }
                # También buscar nietos (claude -> node -> child processes)
                $nodeChildren = @($children | Where-Object { $_.Name -eq 'node.exe' })
                foreach ($nc in $nodeChildren) {
                    $claudeChildren += @($allProcs | Where-Object {
                        $_.ParentProcessId -eq $nc.ProcessId -and
                        $_.Name -ne 'conhost.exe'
                    })
                }

                if ($claudeChildren.Count -gt 0) {
                    $status = 'BUSY'
                    $runningProcs = 'claude (working)'
                } else {
                    $status = 'WAITING'
                    $runningProcs = 'claude (idle)'
                }
            } else {
                $status = 'BUSY'
                $runningProcs = ($children | ForEach-Object { $_.Name -replace '\.exe$', '' }) -join ', '
            }
        }

        # Obtener CWD via P/Invoke
        $cwd = try {
            [CwdHelper]::GetCurrentDirectory([int]$shellPid)
        } catch {
            $null
        }

        # Nombre del proyecto: usar las últimas 2 carpetas si el leaf es genérico
        $project = '?'
        if ($cwd) {
            $leaf = Split-Path $cwd -Leaf
            $genericNames = @('Usuario', 'Users', 'Desktop', 'Documents', 'Home', 'user', 'home')
            if ($leaf -in $genericNames) {
                # Mostrar las últimas 2 partes de la ruta
                $parts = $cwd -split '\\'
                if ($parts.Count -ge 2) {
                    $project = $parts[-2] + '\' + $parts[-1]
                } else {
                    $project = $leaf
                }
            } else {
                $project = $leaf
            }
        }

        $shellName = $shell.Name -replace '\.exe$', ''

        [PSCustomObject]@{
            PID         = $shellPid
            Shell       = $shellName
            Status      = $status
            Project     = $project
            CWD         = if ($cwd) { $cwd } else { 'N/A' }
            Running     = $runningProcs
            IsClaude    = $isClaude
            IsSelf      = ($shellPid -eq $myPid)
            TabIndex    = $tabIndex
            TerminalPid = $shell.ParentProcessId
        }
    }
}

# ============================================================================
# Start-SessionMonitor: barra superior estilo taskbar
# ============================================================================

function Start-SessionMonitor {
    [CmdletBinding()]
    param(
        [int]$RefreshSeconds = 3,
        [int]$BarHeight = 48
    )

    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName PresentationCore
    Add-Type -AssemblyName WindowsBase
    Add-Type -AssemblyName System.Windows.Forms

    # Obtener ancho de pantalla
    $screenWidth = [System.Windows.SystemParameters]::PrimaryScreenWidth

    $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Session Monitor"
        Height="$BarHeight" Width="$screenWidth"
        Left="0" Top="0"
        WindowStyle="None" AllowsTransparency="True"
        Background="Transparent"
        ResizeMode="NoResize"
        Topmost="True"
        ShowInTaskbar="True">

    <Border Background="#E6181825" CornerRadius="0,0,10,10" BorderThickness="0,0,0,1"
            BorderBrush="#33565f89">
        <Grid Margin="12,0">
            <Grid.ColumnDefinitions>
                <ColumnDefinition Width="Auto"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
                <ColumnDefinition Width="Auto"/>
            </Grid.ColumnDefinitions>

            <!-- Logo / Title -->
            <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center"
                        Margin="0,0,15,0">
                <TextBlock Text="&#x1F4CB;" FontSize="16" VerticalAlignment="Center" Margin="0,0,6,0"/>
                <TextBlock Text="Sessions" FontSize="13" FontWeight="SemiBold"
                           Foreground="#7aa2f7" VerticalAlignment="Center"/>
            </StackPanel>

            <!-- Session chips -->
            <ScrollViewer Grid.Column="1" HorizontalScrollBarVisibility="Auto"
                          VerticalScrollBarVisibility="Disabled"
                          VerticalAlignment="Center">
                <StackPanel Name="chipPanel" Orientation="Horizontal"/>
            </ScrollViewer>

            <!-- Stats -->
            <StackPanel Grid.Column="2" Orientation="Horizontal" VerticalAlignment="Center"
                        Margin="15,0,10,0">
                <TextBlock Name="txtStats" FontSize="11" Foreground="#565f89"
                           VerticalAlignment="Center"/>
            </StackPanel>

            <!-- Close button -->
            <Border Grid.Column="3" Background="#22ffffff" CornerRadius="4"
                    Padding="6,2" VerticalAlignment="Center" Cursor="Hand"
                    Name="btnClose" MouseLeftButtonDown="Close_Click">
                <TextBlock Text="&#x2715;" FontSize="11" Foreground="#565f89"
                           VerticalAlignment="Center"/>
            </Border>
        </Grid>
    </Border>
</Window>
"@

    # Workaround: remove event handler from XAML (add via code)
    $xaml = $xaml -replace ' MouseLeftButtonDown="Close_Click"', ''

    $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($xaml))
    $window = [System.Windows.Markup.XamlReader]::Load($reader)

    $chipPanel = $window.FindName('chipPanel')
    $txtStats = $window.FindName('txtStats')
    $btnClose = $window.FindName('btnClose')

    # Close button
    $btnClose.Add_MouseLeftButtonDown({ $window.Close() })

    # Drag to move
    $window.Add_MouseLeftButtonDown({
        $window.DragMove()
    })

    # Function to create a session chip
    $createChip = {
        param($session)

        $chip = New-Object System.Windows.Controls.Border
        $chip.CornerRadius = [System.Windows.CornerRadius]::new(6)
        $chip.Padding = [System.Windows.Thickness]::new(10, 4, 10, 4)
        $chip.Margin = [System.Windows.Thickness]::new(0, 0, 6, 0)
        $chip.VerticalAlignment = 'Center'
        $chip.Cursor = 'Hand'

        $stack = New-Object System.Windows.Controls.StackPanel
        $stack.Orientation = 'Horizontal'

        # Status dot
        $dot = New-Object System.Windows.Shapes.Ellipse
        $dot.Width = 8
        $dot.Height = 8
        $dot.VerticalAlignment = 'Center'
        $dot.Margin = [System.Windows.Thickness]::new(0, 0, 6, 0)

        $bc = [System.Windows.Media.BrushConverter]::new()
        if ($session.Status -eq 'BUSY') {
            $chip.Background = $bc.ConvertFrom('#33f7768e')
            $chip.BorderBrush = $bc.ConvertFrom('#44f7768e')
            $chip.BorderThickness = [System.Windows.Thickness]::new(1)
            $dot.Fill = $bc.ConvertFrom('#f7768e')
        } elseif ($session.Status -eq 'WAITING') {
            # Claude abierto pero esperando input del usuario — amarillo
            $chip.Background = $bc.ConvertFrom('#33e0af68')
            $chip.BorderBrush = $bc.ConvertFrom('#44e0af68')
            $chip.BorderThickness = [System.Windows.Thickness]::new(1)
            $dot.Fill = $bc.ConvertFrom('#e0af68')
        } else {
            # IDLE — sin nada corriendo — verde
            $chip.Background = $bc.ConvertFrom('#339ece6a')
            $chip.BorderBrush = $bc.ConvertFrom('#449ece6a')
            $chip.BorderThickness = [System.Windows.Thickness]::new(1)
            $dot.Fill = $bc.ConvertFrom('#9ece6a')
        }

        $stack.Children.Add($dot) | Out-Null

        # Icon for Claude sessions
        if ($session.IsClaude) {
            $icon = New-Object System.Windows.Controls.TextBlock
            $icon.Text = [System.Char]::ConvertFromUtf32(0x1F916)
            $icon.FontSize = 12
            $icon.VerticalAlignment = 'Center'
            $icon.Margin = [System.Windows.Thickness]::new(0, 0, 4, 0)
            $stack.Children.Add($icon) | Out-Null
        }

        # Project name
        $projText = New-Object System.Windows.Controls.TextBlock
        $projText.Text = $session.Project
        $projText.FontSize = 12
        $projText.FontWeight = 'Medium'
        $projText.VerticalAlignment = 'Center'
        $projText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#c0caf5')
        $stack.Children.Add($projText) | Out-Null

        # Running process info
        if ($session.Running -ne '-') {
            $runText = New-Object System.Windows.Controls.TextBlock
            $runText.Text = " [$($session.Running)]"
            $runText.FontSize = 10
            $runText.VerticalAlignment = 'Center'
            $runText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#565f89')
            $stack.Children.Add($runText) | Out-Null
        }

        $chip.Child = $stack

        # Tooltip con info completa (usar TextBlock para mejor render)
        $tooltipBlock = New-Object System.Windows.Controls.TextBlock
        $tooltipBlock.Text = "$($session.Project)`nStatus: $($session.Status)`nRunning: $($session.Running)`nCWD: $($session.CWD)`nShell: $($session.Shell)`nPID: $($session.PID)"
        $tooltipBlock.FontFamily = [System.Windows.Media.FontFamily]::new('Segoe UI')
        $tooltipBlock.FontSize = 12
        $chip.ToolTip = $tooltipBlock

        # Guardar tab index (0-based para wt) como string para evitar problemas con WPF Tag
        $chip.Tag = [string]($session.TabIndex - 1)

        # Click: cambiar pestaña
        $chip.Tag = [string]$session.TabIndex

        $chip.Add_MouseLeftButtonDown({
            param($sender, $e)
            try {
                $tabNum = [int]$sender.Tag
                $result = [WindowHelper]::SwitchToTab($tabNum)
                $log = "C:\Users\Usuario\Documents\Claude\Projects\claudio_control\SessionMonitor\click_log.txt"
                Add-Content -Path $log -Value "$(Get-Date -Format 'HH:mm:ss') tab=$tabNum result=$result"
            } catch {}
            $e.Handled = $true
        })

        return $chip
    }

    # Refresh function
    $refreshAction = {
        $sessions = @(Get-TerminalSessions | Where-Object { -not $_.IsSelf })
        $sessions = @($sessions | Sort-Object @{Expression={$_.Status}; Descending=$true}, Project)

        $busyCount = @($sessions | Where-Object { $_.Status -eq 'BUSY' }).Count
        $waitCount = @($sessions | Where-Object { $_.Status -eq 'WAITING' }).Count
        $idleCount = @($sessions | Where-Object { $_.Status -eq 'IDLE' }).Count

        $txtStats.Text = "$($sessions.Count)T  $busyCount" + [char]0x25CF + "  $waitCount" + [char]0x25C9 + "  $idleCount" + [char]0x25CB

        $chipPanel.Children.Clear()

        foreach ($s in $sessions) {
            $card = & $createChip $s
            $chipPanel.Children.Add($card) | Out-Null
        }

        if ($sessions.Count -eq 0) {
            $emptyText = New-Object System.Windows.Controls.TextBlock
            $emptyText.Text = "No sessions detected"
            $emptyText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFrom('#565f89')
            $emptyText.FontSize = 11
            $emptyText.VerticalAlignment = 'Center'
            $emptyText.FontStyle = 'Italic'
            $chipPanel.Children.Add($emptyText) | Out-Null
        }
    }

    # Timer for auto-refresh
    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromSeconds($RefreshSeconds)
    $timer.Add_Tick({ & $refreshAction })

    $window.Add_Loaded({
        & $refreshAction
        $timer.Start()
    })

    $window.Add_Closed({
        $timer.Stop()
    })

    $window.ShowDialog() | Out-Null
}

Export-ModuleMember -Function Get-TerminalSessions, Start-SessionMonitor
