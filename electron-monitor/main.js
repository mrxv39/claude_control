const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, shell } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('./lib/orchestrator-store');
const scanner = require('./lib/project-scanner');
const analyzer = require('./lib/project-analyzer');
const scheduler = require('./lib/scheduler');
const executor = require('./lib/executor');
const koffi = require('koffi');

// Win32
const user32 = koffi.load('user32.dll');
const FindWindowA = user32.func('intptr __stdcall FindWindowA(str cls, str title)');
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
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
const GetClassNameA = user32.func('int __stdcall GetClassNameA(intptr h, uint8 *buf, int max)');

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
let tray = null;
let userPosition = null;   // { x, y } — set when user drags the bar
let isSettingBounds = false; // suppress 'move' during programmatic setBounds
let isQuitting = false;

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

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });

  // Detect user dragging the bar
  mainWindow.on('move', () => {
    if (isSettingBounds) return;
    const [x, y] = mainWindow.getPosition();
    userPosition = { x, y };
  });
}

function createTray() {
  // Generate a simple tray icon using nativeImage
  const { nativeImage } = require('electron');
  let icon;
  const customIcon = path.join(__dirname, 'icon.png');
  if (fs.existsSync(customIcon)) {
    icon = nativeImage.createFromPath(customIcon);
  } else {
    // Create a 16x16 icon: green circle on transparent background
    const size = 16;
    const buf = Buffer.alloc(size * size * 4, 0);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - 7.5, dy = y - 7.5;
        if (dx*dx + dy*dy <= 49) { // radius 7
          const i = (y * size + x) * 4;
          buf[i] = 122; buf[i+1] = 162; buf[i+2] = 247; buf[i+3] = 255; // #7aa2f7
        }
      }
    }
    icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  }
  tray = new Tray(icon);
  tray.setToolTip('Claudio Control');
  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar', click: () => { mainWindow.show(); mainWindow.setAlwaysOnTop(true, 'screen-saver'); } },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// IPC: hide bar (from ✕ button)
ipcMain.handle('hide-bar', () => { if (mainWindow) mainWindow.hide(); });

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
      if (lastFocusedViaChip === targetHwnd && !IsIconic(targetHwnd)) {
        ShowWindow(targetHwnd, 6); // SW_MINIMIZE
        lastFocusedViaChip = 0;
        return 'MINIMIZED';
      }
      focusWindow(targetHwnd);
      lastFocusedViaChip = targetHwnd;
      return 'OK_HWND';
    }

    const hwnd = FindWindowA('CASCADIA_HOSTING_WINDOW_CLASS', null);
    if (!hwnd) return 'NO_WINDOW';
    if (lastFocusedViaChip === Number(hwnd) && !IsIconic(hwnd)) {
      ShowWindow(hwnd, 6); // SW_MINIMIZE
      lastFocusedViaChip = 0;
      return 'MINIMIZED';
    }
    focusWindow(hwnd);
    lastFocusedViaChip = Number(hwnd);

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
const overlays = new Map(); // hwnd -> { win, label, status, occludedCount }
const OVERLAY_H = 33;
const OVERLAY_BTN_MARGIN = 140; // space for WT minimize/maximize/close buttons

function overlayHtml(label, status) {
  const safe = String(label).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const bg = status === 'BUSY' ? 'rgba(158,206,106,1)' : 'rgba(247,118,142,1)';
  const border = status === 'BUSY' ? 'rgba(158,206,106,1)' : 'rgba(247,118,142,1)';
  const textColor = status === 'BUSY' ? '#1a2e0a' : '#3a0a12';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:'Segoe UI',sans-serif;">
<div style="background:${bg};border:1px solid ${border};border-top:none;color:${textColor};font-size:16px;font-weight:700;padding:5px 15px;border-radius:0 0 8px 8px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:22px;">${safe}</div>
</body></html>`);
}

function createOverlay(hwnd, label, status) {
  const win = new BrowserWindow({
    width: 400, height: OVERLAY_H,
    x: -9999, y: -9999,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false,
    hasShadow: false, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  win.setIgnoreMouseEvents(true);
  win.loadURL(overlayHtml(label, status));
  win.setAlwaysOnTop(true, 'screen-saver');
  win._ready = false;
  win.once('ready-to-show', () => { win._ready = true; win.showInactive(); });
  return win;
}

function syncOverlays(sessions) {
  const live = new Map();
  for (const s of sessions) {
    if (s.hwnd && IsWindow(s.hwnd)) live.set(Number(s.hwnd), { label: s.project || '?', status: s.status || 'IDLE' });
  }
  // Remove dead overlays
  for (const [h, info] of overlays) {
    if (!live.has(h)) { try { info.win.destroy(); } catch {} overlays.delete(h); }
  }
  // Create or update
  for (const [h, data] of live) {
    let info = overlays.get(h);
    if (!info) {
      const win = createOverlay(h, data.label, data.status);
      info = { win, label: data.label, status: data.status, offscreen: true };
      overlays.set(h, info);
    } else if (info.label !== data.label || info.status !== data.status) {
      info.win.loadURL(overlayHtml(data.label, data.status));
      info.label = data.label;
      info.status = data.status;
    }
  }
}

function repositionOverlays() {
  if (isQuitting) return;
  for (const [h, info] of overlays) {
    if (!info.win || info.win.isDestroyed()) { overlays.delete(h); continue; }
    if (!info.win._ready) continue; // wait for HTML to render
    try {
      if (!IsWindow(h) || !IsWindowVisible(h) || IsIconic(h)) {
        if (!info.offscreen) { info.win.hide(); info.offscreen = true; }
        continue;
      }
      const r = {};
      if (!GetWindowRect(h, r)) continue;
      const wWidth = r.right - r.left;
      const wHeight = r.bottom - r.top;
      // Occlusion: probe center of WT window (avoids hitting bar/overlays at top)
      const probeX = r.left + Math.floor(wWidth / 2);
      const probeY = r.top + Math.floor(wHeight / 2);
      let occluded = false;
      try {
        const hit = WindowFromPoint({ x: probeX, y: probeY });
        if (hit) {
          const root = GetAncestor(hit, 2) || hit;
          if (Number(root) !== Number(h)) occluded = true;
        } else {
          occluded = true;
        }
      } catch {}
      if (occluded) {
        if (!info.offscreen) { info.win.hide(); info.offscreen = true; }
        continue;
      }
      const overlayW = Math.max(100, wWidth - OVERLAY_BTN_MARGIN);
      info.win.setBounds({ x: r.left, y: r.top + 4, width: overlayW, height: OVERLAY_H });
      if (info.offscreen) { info.win.showInactive(); info.offscreen = false; }
    } catch {
      overlays.delete(h);
    }
  }
}

// ---- Auto-tile: reposition WT windows when the set of sessions changes ----
let prevAutoTileHwnds = []; // sorted array of hwnds from last auto-tile

function autoTile(hwnds) {
  const valid = hwnds.filter(h => h && IsWindow(h));
  // Sort for stable comparison
  const sorted = [...valid].sort((a, b) => a - b);
  // Only re-tile when the set of windows actually changes
  if (sorted.length === prevAutoTileHwnds.length &&
      sorted.every((h, i) => h === prevAutoTileHwnds[i])) return;
  prevAutoTileHwnds = sorted;

  if (sorted.length === 0) return;

  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const BAR_H = 48;
  const x0 = wa.x;
  const y0 = wa.y + BAR_H;
  const w0 = wa.width;
  const h0 = wa.height - BAR_H;

  const n = sorted.length;
  let cols, rows;
  if (n === 1)      { cols = 2; rows = 1; } // 1 window = 50% width (left half)
  else if (n === 2) { cols = 2; rows = 1; }
  else if (n === 3) { cols = 3; rows = 1; }
  else if (n === 4) { cols = 2; rows = 2; }
  else { cols = Math.ceil(Math.sqrt(n)); rows = Math.ceil(n / cols); }

  const cellW = Math.floor(w0 / cols);
  const cellH = Math.floor(h0 / rows);

  sorted.forEach((h, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    ShowWindow(h, 9); // SW_RESTORE: unmaximize if needed
    MoveWindow(h, x0 + c * cellW, y0 + r * cellH, cellW, cellH, true);
  });
}

// Track the last HWND focused via chip click (for toggle minimize)
let lastFocusedViaChip = 0;

let overlayPollTimer = null;
function startOverlayLoop() {
  if (overlayPollTimer) return;
  overlayPollTimer = setInterval(repositionOverlays, 33);
}

// ---- Status change notifications (custom toast window) ----
const prevStatus = new Map(); // cwd -> status
const waitingSince = new Map(); // cwd -> 'BUSY' if WAITING streak started from BUSY
const waitingCount = new Map(); // cwd -> consecutive WAITING polls (debounce)

function showToast(message) {
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 320, H = 60;
  const toast = new BrowserWindow({
    width: W, height: H,
    x: wa.x + wa.width - W - 16,
    y: wa.y + wa.height - H - 16,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  toast.setIgnoreMouseEvents(true);
  const safe = String(message).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  toast.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
<!DOCTYPE html><html><body style="margin:0;font-family:'Segoe UI',sans-serif;">
<div style="background:#1a1b26;border:1px solid #7aa2f7;border-radius:10px;padding:12px 18px;color:#c0caf5;font-size:13px;display:flex;align-items:center;gap:10px;height:100%;box-sizing:border-box;">
<span style="font-size:20px;">&#9989;</span>
<span>${safe}</span>
</div></body></html>`));
  toast.setAlwaysOnTop(true, 'screen-saver');
  toast.showInactive();
  // Play 7-Eleven chime
  playChime();
  setTimeout(() => { try { toast.destroy(); } catch {} }, 5000);
}

function checkStatusChanges(sessions) {
  for (const s of sessions) {
    if (!s.isClaude || !s.cwd) continue;
    const prev = prevStatus.get(s.cwd);
    prevStatus.set(s.cwd, s.status);
    if (s.status === 'WAITING') {
      const count = (waitingCount.get(s.cwd) || 0) + 1;
      waitingCount.set(s.cwd, count);
      // Remember if this WAITING streak started from BUSY
      if (count === 1) waitingSince.set(s.cwd, prev);
      // Require 3 consecutive WAITING polls (~9s) before notifying,
      // to avoid false alerts from brief pauses between tool calls.
      if (waitingSince.get(s.cwd) === 'BUSY' && count === 3) {
        showToast(`${s.project} termino — esperando tu input`);
      }
    } else {
      waitingCount.set(s.cwd, 0);
      waitingSince.delete(s.cwd);
    }
  }
}

// ---- 7-Eleven chime generator ----
function generateChimeWav() {
  const sampleRate = 22050;
  const tone1Freq = 1319; // E6
  const tone2Freq = 988;  // B5
  const tone1Dur = 0.35;
  const tone2Dur = 0.45;
  const pause = 0.08;
  const volume = 0.4;

  const totalSamples = Math.floor((tone1Dur + pause + tone2Dur) * sampleRate);
  const data = Buffer.alloc(totalSamples * 2); // 16-bit mono

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;
    if (t < tone1Dur) {
      const env = Math.min(1, t / 0.01) * Math.min(1, (tone1Dur - t) / 0.05);
      sample = Math.sin(2 * Math.PI * tone1Freq * t) * env * volume;
    } else if (t > tone1Dur + pause) {
      const t2 = t - tone1Dur - pause;
      const env = Math.min(1, t2 / 0.01) * Math.min(1, (tone2Dur - t2) / 0.08);
      sample = Math.sin(2 * Math.PI * tone2Freq * t2) * env * volume;
    }
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }

  // WAV header
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);       // chunk size
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

let chimePath = null;
function playChime() {
  try {
    if (!chimePath) {
      const tmpDir = path.join(process.env.USERPROFILE, '.claude', 'claudio-state');
      chimePath = path.join(tmpDir, 'chime.wav');
      if (!fs.existsSync(chimePath)) {
        fs.writeFileSync(chimePath, generateChimeWav());
      }
    }
    execSync(`powershell.exe -NoProfile -Command "(New-Object Media.SoundPlayer '${chimePath}').PlaySync()"`,
      { timeout: 5000 });
  } catch {}
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
      }
      // Fallback: assign remaining unassigned windows to remaining sessions by screen position
      const stillNeed = needHwnd.filter(s => !s.hwnd);
      if (stillNeed.length > 0 && unassigned.length > 0) {
        // Sort unassigned windows left-to-right by x position
        unassigned.sort((a, b) => {
          const ra = {}, rb = {};
          GetWindowRect(a.hwnd, ra); GetWindowRect(b.hwnd, rb);
          return (ra.left || 0) - (rb.left || 0);
        });
        for (let i = 0; i < Math.min(stillNeed.length, unassigned.length); i++) {
          stillNeed[i].hwnd = unassigned[i].hwnd;
        }
      }
    }

    syncOverlays(arr);
    checkStatusChanges(arr);

    // Auto-tile: use all visible WT windows (not just session-assigned HWNDs)
    const wtWindows2 = enumWtWindows();
    const allWtHwnds = [];
    for (const [, wins] of wtWindows2) {
      for (const w of wins) {
        if (w.hwnd && IsWindow(w.hwnd) && IsWindowVisible(w.hwnd) && !IsIconic(w.hwnd)) {
          allWtHwnds.push(w.hwnd);
        }
      }
    }
    autoTile(allWtHwnds);

    return arr;
  } catch (e) { return []; }
});

// ---- Auto-update checker ----
const PKG_VERSION = require('./package.json').version;

async function checkForUpdates() {
  try {
    const { net } = require('electron');
    const resp = await net.fetch('https://api.github.com/repos/mrxv39/claude_control/releases/latest');
    if (!resp.ok) return;
    const data = await resp.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    if (latest && latest !== PKG_VERSION) {
      const url = data.html_url || 'https://github.com/mrxv39/claude_control/releases/latest';
      mainWindow.webContents.send('update-available', latest, url);
    }
  } catch {}
}

// ---- Auto-setup hook check ----
function checkHookSetup() {
  try {
    const settingsPath = path.join(process.env.USERPROFILE, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) { mainWindow.webContents.send('hook-missing'); return; }
    const content = fs.readFileSync(settingsPath, 'utf-8');
    if (!content.includes('claude-state-hook')) {
      mainWindow.webContents.send('hook-missing');
    }
  } catch { mainWindow.webContents.send('hook-missing'); }
}

ipcMain.handle('run-setup-hook', async () => {
  try {
    const script = resolveScript('setup-hook.ps1');
    execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}"`,
      { encoding: 'utf-8', timeout: 30000 });
    return true;
  } catch { return false; }
});

// ---- Orchestrator IPC handlers ----
let panelOpen = false;
const PANEL_H = 400;
const BAR_H = 48;

ipcMain.handle('toggle-panel', () => {
  if (!mainWindow) return;
  panelOpen = !panelOpen;
  const [w] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();

  if (panelOpen) {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setResizable(true);
    mainWindow.setBounds({ x, y, width: Math.max(w, 700), height: BAR_H + PANEL_H });
    mainWindow.setResizable(false);
  } else {
    mainWindow.setResizable(true);
    mainWindow.setBounds({ x, y, width: w, height: BAR_H });
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }
  return panelOpen;
});

ipcMain.handle('get-orchestrator-config', () => store.load());
ipcMain.handle('set-orchestrator-config', (ev, partial) => store.update(partial));

ipcMain.handle('get-project-analysis', () => store.getProjects());

ipcMain.handle('run-project-scan', async () => {
  const config = store.load();
  const projects = await scanner.scan(config.projectDirs);
  const analysis = await analyzer.analyzeAll(projects);
  store.setProjects(analysis);
  store.update({ lastFullScan: new Date().toISOString() });
  return analysis;
});

ipcMain.handle('get-queue', () => store.getQueue());
ipcMain.handle('get-execution-log', () => store.readLog(50));
ipcMain.handle('get-budget-status', () => {
  const config = store.load();
  return {
    todaySpent: config.todaySpentUsd,
    dailyBudget: config.dailyBudgetUsd,
    remaining: store.budgetRemaining()
  };
});

// Scheduler/executor IPC
ipcMain.handle('get-scheduler-status', () => scheduler.getStatus());
ipcMain.handle('pause-scheduler', () => { scheduler.pause(); return true; });
ipcMain.handle('resume-scheduler', () => { scheduler.resume(); return true; });
ipcMain.handle('emergency-stop', () => { scheduler.pause(); return true; });

ipcMain.handle('add-to-queue', (ev, task) => store.enqueue(task));
ipcMain.handle('remove-from-queue', (ev, taskId) => { store.dequeue(taskId); return true; });
ipcMain.handle('get-skills', () => {
  return Object.entries(executor.SKILLS).map(([name, def]) => ({
    name,
    model: def.model,
    budgetUsd: def.budgetUsd
  }));
});

app.setAppUserModelId('com.claudio.monitor');

// Single instance lock — if already running, focus the existing one
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.setAlwaysOnTop(true, 'screen-saver'); }
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  startOverlayLoop();
  // Check hook setup and updates after window loads
  mainWindow.webContents.on('did-finish-load', () => {
    checkHookSetup();
    checkForUpdates();
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000); // every 6h
    // Auto-scan projects if last scan > 24h ago
    const config = store.load();
    const lastScan = config.lastFullScan ? new Date(config.lastFullScan).getTime() : 0;
    if (Date.now() - lastScan > 24 * 60 * 60 * 1000) {
      scanner.scan(config.projectDirs).then(projects => {
        analyzer.analyzeAll(projects).then(analysis => {
          store.setProjects(analysis);
          store.update({ lastFullScan: new Date().toISOString() });
        });
      }).catch(() => {});
    }
    // Start the autonomous scheduler
    scheduler.start({
      getSessions: async () => {
        try {
          const r = execSync(
            `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${resolveScript('get-sessions.ps1')}"`,
            { encoding: 'utf-8', timeout: 15000 }
          ).trim();
          if (!r) return [];
          const p = JSON.parse(r);
          return Array.isArray(p) ? p : [p];
        } catch { return []; }
      },
      onStatus: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scheduler-status', status);
        }
      }
    });
  });
});
app.on('window-all-closed', () => { /* don't quit — tray keeps running */ });
app.on('before-quit', () => {
  isQuitting = true;
  scheduler.stop();
  // Stop the overlay loop BEFORE destroying windows to avoid accessing destroyed objects
  if (overlayPollTimer) { clearInterval(overlayPollTimer); overlayPollTimer = null; }
  // Destroy all overlays explicitly
  for (const [, info] of overlays) {
    try { if (info.win && !info.win.isDestroyed()) info.win.destroy(); } catch {}
  }
  overlays.clear();
});
