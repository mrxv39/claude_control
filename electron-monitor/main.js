const { app, BrowserWindow, ipcMain } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const koffi = require('koffi');

// Win32
const user32 = koffi.load('user32.dll');
const FindWindowA = user32.func('intptr __stdcall FindWindowA(str cls, str title)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr h, int c)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr h)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr h)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr h)');
const keybd_event = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint flags, uintptr extra)');

function focusWindow(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
  // Alt trick: simular Alt para desbloquear SetForegroundWindow
  keybd_event(0x12, 0, 0, 0);
  keybd_event(0x12, 0, 2, 0);
  SetForegroundWindow(hwnd);
}

let mainWindow;

function createWindow() {
  const { screen } = require('electron');
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width, height: 48, x: 0, y: 0,
    frame: false, transparent: false,
    alwaysOnTop: true, skipTaskbar: false, resizable: false,
    backgroundColor: '#181825',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

// Get sessions
ipcMain.handle('get-sessions', async () => {
  try {
    const r = execSync(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, 'get-sessions.ps1')}"`,
      { encoding: 'utf-8', timeout: 15000 }
    ).trim();
    if (!r) return [];
    const p = JSON.parse(r);
    return Array.isArray(p) ? p : [p];
  } catch (e) { return []; }
});

// Focus a session: prefer HWND from hook state file; fallback to first WT window + Ctrl+Alt+N
ipcMain.handle('focus-wt', async (event, payload) => {
  try {
    let targetHwnd = 0;
    let tabIndex = 0;
    if (typeof payload === 'object' && payload !== null) {
      targetHwnd = Number(payload.hwnd) || 0;
      tabIndex = Number(payload.tabIndex) || 0;
    } else {
      tabIndex = Number(payload) || 0;
    }

    if (targetHwnd && IsWindow(targetHwnd)) {
      focusWindow(targetHwnd);
      return 'OK_HWND';
    }

    const hwnd = FindWindowA('CASCADIA_HOSTING_WINDOW_CLASS', null);
    if (!hwnd) return 'NO_WINDOW';
    focusWindow(hwnd);

    if (tabIndex >= 1 && tabIndex <= 9) {
      setTimeout(() => {
        const VK_CONTROL = 0x11, VK_MENU = 0x12;
        const vkNum = 0x30 + tabIndex;
        keybd_event(VK_CONTROL, 0, 0, 0);
        keybd_event(VK_MENU, 0, 0, 0);
        keybd_event(vkNum, 0, 0, 0);
        keybd_event(vkNum, 0, 2, 0);
        keybd_event(VK_MENU, 0, 2, 0);
        keybd_event(VK_CONTROL, 0, 2, 0);
      }, 150);
    }
    return 'OK_FALLBACK';
  } catch (e) { return 'ERROR'; }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
