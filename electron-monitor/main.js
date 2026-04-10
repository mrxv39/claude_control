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
const MoveWindow = user32.func('bool __stdcall MoveWindow(intptr h, int x, int y, int w, int hh, bool repaint)');
const RECT = koffi.struct('RECT', { left:'int32', top:'int32', right:'int32', bottom:'int32' });
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr h, _Out_ RECT *r)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr h)');
const POINT = koffi.struct('POINT', { x:'int32', y:'int32' });
const WindowFromPoint = user32.func('intptr __stdcall WindowFromPoint(POINT p)');
const GetAncestor = user32.func('intptr __stdcall GetAncestor(intptr h, uint flags)');
const keybd_event = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint flags, uintptr extra)');
const FindWindowExA = user32.func('intptr __stdcall FindWindowExA(intptr parent, intptr after, str cls, str title)');
const GetWindowThreadProcessId = user32.func('uint __stdcall GetWindowThreadProcessId(intptr h, _Out_ uint32 *pid)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr h, uint16 *buf, int max)');

// Enumerate all WT windows, returns Map<wtPid, [{hwnd, title}]>
function enumWtWindows() {
  const map = new Map();
  let h = 0;
  while (true) {
    h = FindWindowExA(0, h, 'CASCADIA_HOSTING_WINDOW_CLASS', null);
    if (!h) break;
    const pidBuf = [0];
    GetWindowThreadProcessId(h, pidBuf);
    const pid = pidBuf[0];
    const titleBuf = new Uint16Array(512);
    GetWindowTextW(h, titleBuf, 512);
    // Decode UTF-16 title
    let title = '';
    for (let i = 0; i < titleBuf.length && titleBuf[i]; i++) title += String.fromCharCode(titleBuf[i]);
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push({ hwnd: Number(h), title });
  }
  return map;
}

function focusWindow(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
  // Alt trick: simular Alt para desbloquear SetForegroundWindow
  keybd_event(0x12, 0, 0, 0);
  keybd_event(0x12, 0, 2, 0);
  SetForegroundWindow(hwnd);
}

let mainWindow;
let userPosition = null;   // { x, y } — set when user drags the bar
let isSettingBounds = false; // suppress 'move' during programmatic setBounds

function createWindow() {
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const initW = 300;
  const initX = Math.round((wa.width - initW) / 2) + wa.x;

  mainWindow = new BrowserWindow({
    width: initW, height: 48, x: initX, y: wa.y,
    frame: false, transparent: false,
    alwaysOnTop: true, skipTaskbar: false, resizable: false,
    backgroundColor: '#181825',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // Detect user dragging the bar
  mainWindow.on('move', () => {
    if (isSettingBounds) return;
    const [x, y] = mainWindow.getPosition();
    userPosition = { x, y };
  });
}

ipcMain.handle('resize-bar', (event, w) => {
  if (!mainWindow) return;
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.max(180, Math.min(Math.ceil(w), wa.width));
  const [, h] = mainWindow.getSize();

  let x, y;
  if (userPosition) {
    // Keep user-chosen position, clamp to screen bounds
    x = Math.max(wa.x, Math.min(userPosition.x, wa.x + wa.width - width));
    y = Math.max(wa.y, Math.min(userPosition.y, wa.y + wa.height - h));
  } else {
    // Center horizontally at top
    x = Math.round((wa.width - width) / 2) + wa.x;
    y = wa.y;
  }

  isSettingBounds = true;
  mainWindow.setBounds({ x, y, width, height: h });
  isSettingBounds = false;
});

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

// Tile a set of HWNDs across the primary work area (below the always-on-top bar)
ipcMain.handle('tile-windows', async (event, hwnds) => {
  try {
    if (!Array.isArray(hwnds)) return 'BAD_INPUT';
    const valid = hwnds.map(Number).filter(h => h && IsWindow(h));
    if (valid.length === 0) return 'NO_HWNDS';

    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    const BAR_H = 48;
    const x0 = wa.x;
    const y0 = wa.y + BAR_H;
    const w0 = wa.width;
    const h0 = wa.height - BAR_H;

    const n = valid.length;
    let cols, rows;
    if (n === 1)      { cols = 1; rows = 1; }
    else if (n === 2) { cols = 2; rows = 1; }
    else if (n === 3) { cols = 3; rows = 1; }
    else if (n === 4) { cols = 2; rows = 2; }
    else { cols = Math.ceil(Math.sqrt(n)); rows = Math.ceil(n / cols); }

    const cellW = Math.floor(w0 / cols);
    const cellH = Math.floor(h0 / rows);

    valid.forEach((h, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      if (IsIconic(h)) ShowWindow(h, 9);
      else ShowWindow(h, 9); // SW_RESTORE: unmaximize if needed
      MoveWindow(h, x0 + c * cellW, y0 + r * cellH, cellW, cellH, true);
    });

    // Bring them all to front in order, last one ends up focused
    valid.forEach(h => focusWindow(h));
    return 'OK';
  } catch (e) { return 'ERROR:' + e.message; }
});

// ---- Title overlays: small frameless windows pinned to each WT window ----
const overlays = new Map(); // hwnd -> { win, label }
const OVERLAY_W = 220;
const OVERLAY_H = 22;

function overlayHtml(label) {
  const safe = String(label).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:'Segoe UI',sans-serif;">
<div style="background:#7aa2f7;color:#1a1b26;font-size:11px;font-weight:600;padding:3px 10px;border-radius:0 0 6px 6px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:16px;">${safe}</div>
</body></html>`);
}

function createOverlay(hwnd, label) {
  const win = new BrowserWindow({
    width: OVERLAY_W, height: OVERLAY_H,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false,
    hasShadow: false, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.setIgnoreMouseEvents(true);
  win.loadURL(overlayHtml(label));
  win.setAlwaysOnTop(true, 'screen-saver');
  return win;
}

function syncOverlays(sessions) {
  const live = new Map();
  for (const s of sessions) {
    if (s.hwnd && IsWindow(s.hwnd)) live.set(Number(s.hwnd), s.project || '?');
  }
  // Remove dead overlays
  for (const [h, info] of overlays) {
    if (!live.has(h)) { try { info.win.destroy(); } catch {} overlays.delete(h); }
  }
  // Create or update
  for (const [h, label] of live) {
    let info = overlays.get(h);
    if (!info) {
      const win = createOverlay(h, label);
      info = { win, label };
      overlays.set(h, info);
    } else if (info.label !== label) {
      info.win.loadURL(overlayHtml(label));
      info.label = label;
    }
  }
}

function repositionOverlays() {
  for (const [h, info] of overlays) {
    if (!IsWindow(h) || !IsWindowVisible(h) || IsIconic(h)) {
      if (info.win.isVisible()) info.win.hide();
      continue;
    }
    const r = {};
    if (!GetWindowRect(h, r)) continue;
    const wWidth = r.right - r.left;
    const wHeight = r.bottom - r.top;
    // Hit-test: probe a point inside the WT window's title area; if the topmost
    // window there isn't this WT window (or one of its children), it's occluded.
    // Probe a point clearly inside WT's client area, away from where our own
    // overlay sits (centered top), to avoid hitting the overlay itself.
    const probeX = r.left + 20;
    const probeY = r.top + 50;
    let occluded = false;
    try {
      const hit = WindowFromPoint({ x: probeX, y: probeY });
      if (hit) {
        const root = GetAncestor(hit, 2 /* GA_ROOT */) || hit;
        if (Number(root) !== Number(h)) occluded = true;
      } else {
        occluded = true;
      }
    } catch {}
    if (occluded) {
      if (info.win.isVisible()) info.win.hide();
      continue;
    }
    const x = r.left + Math.floor((wWidth - OVERLAY_W) / 2);
    const y = r.top + 4;
    info.win.setBounds({ x, y, width: OVERLAY_W, height: OVERLAY_H });
    if (!info.win.isVisible()) info.win.showInactive();
  }
}

let overlayPollTimer = null;
function startOverlayLoop() {
  if (overlayPollTimer) return;
  overlayPollTimer = setInterval(repositionOverlays, 100);
}

// Resolve script paths: packaged app puts them in resources/, dev uses __dirname
function resolveScript(name) {
  const dev = path.join(__dirname, name);
  if (require('fs').existsSync(dev)) return dev;
  return path.join(process.resourcesPath, name);
}

// Sync overlays whenever renderer fetches sessions
const _origGetSessions = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get('get-sessions');
ipcMain.removeHandler('get-sessions');
ipcMain.handle('get-sessions', async () => {
  try {
    const r = execSync(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${resolveScript('get-sessions.ps1')}"`,
      { encoding: 'utf-8', timeout: 15000 }
    ).trim();
    if (!r) { syncOverlays([]); return []; }
    const p = JSON.parse(r);
    const arr = Array.isArray(p) ? p : [p];

    // Fill in missing HWNDs using WT window enumeration from Electron context
    const needHwnd = arr.filter(s => !s.hwnd);
    if (needHwnd.length > 0) {
      const wtWindows = enumWtWindows();
      // Collect all known HWNDs (from hook)
      const knownHwnds = new Set(arr.filter(s => s.hwnd).map(s => Number(s.hwnd)));
      // Find unassigned WT windows
      const unassigned = [];
      for (const [, wins] of wtWindows) {
        for (const w of wins) {
          if (!knownHwnds.has(w.hwnd)) unassigned.push(w);
        }
      }
      // Try to match unassigned windows to sessions by title containing project name or cwd
      for (const s of needHwnd) {
        const proj = (s.project || '').toLowerCase();
        const cwdLeaf = s.cwd ? s.cwd.split('\\').pop().toLowerCase() : '';
        for (let i = 0; i < unassigned.length; i++) {
          const title = unassigned[i].title.toLowerCase();
          if ((proj && proj !== '?' && title.includes(proj)) ||
              (cwdLeaf && title.includes(cwdLeaf))) {
            s.hwnd = unassigned[i].hwnd;
            unassigned.splice(i, 1);
            break;
          }
        }
        // If still no match and only one unassigned window left, use it
        if (!s.hwnd && unassigned.length === 1 && needHwnd.length === 1) {
          s.hwnd = unassigned[0].hwnd;
          unassigned.splice(0, 1);
        }
      }
    }

    syncOverlays(arr);
    return arr;
  } catch (e) { return []; }
});

app.whenReady().then(() => { createWindow(); startOverlayLoop(); });
app.on('window-all-closed', () => app.quit());
