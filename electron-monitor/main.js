const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, shell } = require('electron');
const { execSync, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('./lib/orchestrator-store');
const scanner = require('./lib/project-scanner');
const analyzer = require('./lib/project-analyzer');
const scheduler = require('./lib/scheduler');
const executor = require('./lib/executor');
const tokenHistory = require('./lib/token-history');
const gitStatus = require('./lib/git-status');
const conversationReader = require('./lib/conversation-reader');
const statsAggregator = require('./lib/stats-aggregator');
const win32 = require('./lib/win32');
const overlayManager = require('./lib/overlay-manager');
const notifications = require('./lib/notifications');

// Destructure win32 for direct use
const {
  FindWindowA, ShowWindow, IsIconic, IsWindow, MoveWindow,
  GetWindowRect, IsWindowVisible, keybd_event, enumWtWindows, focusWindow,
  registerAppBar, unregisterAppBar
} = win32;

const SW_MINIMIZE = 6;
const SW_RESTORE = 9;

let mainWindow;
let tray = null;
let userPosition = null;   // { x, y } — set when user drags the bar
let isSettingBounds = false; // suppress 'move' during programmatic setBounds
let isQuitting = false;

function appBarRegister() { try { registerAppBar(mainWindow.getNativeWindowHandle().readInt32LE(0), BAR_H); } catch (e) { console.error('appBarRegister failed:', e.message); } }
function appBarUnregister() { try { unregisterAppBar(mainWindow.getNativeWindowHandle().readInt32LE(0)); } catch (e) { console.error('appBarUnregister failed:', e.message); } }

function createWindow() {
  const { screen } = require('electron');
  const bounds = screen.getPrimaryDisplay().bounds;
  const initW = 300;
  const initX = Math.round((bounds.width - initW) / 2) + bounds.x;

  mainWindow = new BrowserWindow({
    width: initW, height: 48, x: initX, y: bounds.y,
    frame: false, transparent: false,
    alwaysOnTop: true, skipTaskbar: false, resizable: false,
    backgroundColor: '#181825',
    // Security note: contextIsolation:false is intentional — this is a local-only app
    // that never loads remote content. nodeIntegration is needed for IPC in the renderer.
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });

  // Only save user position on real drag (not programmatic moves at startup)
  let moveReady = false;
  setTimeout(() => { moveReady = true; }, 3000);
  mainWindow.on('move', () => {
    if (isSettingBounds || !moveReady) return;
    const [x] = mainWindow.getPosition();
    userPosition = { x };
  });
}

function createTray() {
  const { nativeImage } = require('electron');
  let icon;
  const customIcon = path.join(__dirname, 'icon.png');
  if (fs.existsSync(customIcon)) {
    icon = nativeImage.createFromPath(customIcon);
  } else {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4, 0);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - 7.5, dy = y - 7.5;
        if (dx*dx + dy*dy <= 49) {
          const i = (y * size + x) * 4;
          buf[i] = 122; buf[i+1] = 162; buf[i+2] = 247; buf[i+3] = 255;
        }
      }
    }
    icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  }
  tray = new Tray(icon);
  tray.setToolTip('Claudio Control');
  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar', click: () => {
      mainWindow.show(); mainWindow.setAlwaysOnTop(true, 'screen-saver');
      if (!panelOpen) appBarRegister();
    } },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// ---- Shared helpers ----

/** Collect visible, non-minimized WT window handles from enumWtWindows() result. */
function getVisibleWtHwnds(wtWindows) {
  const hwnds = [];
  for (const [, wins] of wtWindows) {
    for (const w of wins) {
      if (w.hwnd && IsWindow(w.hwnd) && IsWindowVisible(w.hwnd) && !IsIconic(w.hwnd)) {
        hwnds.push(w.hwnd);
      }
    }
  }
  return hwnds;
}

/** Compute grid layout and place windows. singleFull=true fills one window fully. */
function tileHwnds(hwnds, { singleFull = false } = {}) {
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const n = hwnds.length;
  if (n === 0) return;

  let cols, rows;
  if (n === 1)      { cols = singleFull ? 1 : 2; rows = 1; }
  else if (n === 2) { cols = 2; rows = 1; }
  else if (n === 3) { cols = 3; rows = 1; }
  else if (n === 4) { cols = 2; rows = 2; }
  else { cols = Math.ceil(Math.sqrt(n)); rows = Math.ceil(n / cols); }

  const cellW = Math.floor(wa.width / cols);
  const cellH = Math.floor(wa.height / rows);

  hwnds.forEach((h, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    ShowWindow(h, SW_RESTORE);
    MoveWindow(h, wa.x + c * cellW, wa.y + r * cellH, cellW, cellH, true);
  });
}

// ---- IPC: bar management ----
ipcMain.handle('hide-bar', () => {
  if (!mainWindow) return;
  appBarUnregister();
  mainWindow.hide();
});

ipcMain.handle('minimize-all-wt', () => {
  const visible = getVisibleWtHwnds(enumWtWindows());
  visible.forEach(h => ShowWindow(h, SW_MINIMIZE));
  return visible;
});

ipcMain.handle('restore-wt', (ev, hwnds) => {
  for (const hwnd of hwnds) {
    if (IsWindow(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  }
});

ipcMain.handle('resize-bar', (event, w) => {
  if (!mainWindow) return;
  const n = Number(w);
  if (!Number.isFinite(n)) return;
  const { screen } = require('electron');
  const bounds = screen.getPrimaryDisplay().bounds;
  const width = Math.max(180, Math.min(Math.ceil(n), bounds.width));
  const [, h] = mainWindow.getSize();

  // Bar always stays at top of screen (y=0), only x changes
  const x = userPosition
    ? Math.max(bounds.x, Math.min(userPosition.x, bounds.x + bounds.width - width))
    : Math.round((bounds.width - width) / 2) + bounds.x;

  isSettingBounds = true;
  mainWindow.setBounds({ x, y: bounds.y, width, height: h });
  isSettingBounds = false;
});

// ---- IPC: window focus ----
let lastFocusedViaChip = 0;

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
        ShowWindow(targetHwnd, SW_MINIMIZE);
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
      ShowWindow(hwnd, SW_MINIMIZE);
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

// ---- IPC: tile windows ----
ipcMain.handle('tile-windows', async (event, hwnds) => {
  try {
    if (!Array.isArray(hwnds)) return 'BAD_INPUT';
    const valid = hwnds.map(Number).filter(h => h && IsWindow(h));
    if (valid.length === 0) return 'NO_HWNDS';
    tileHwnds(valid, { singleFull: true });
    valid.forEach(h => focusWindow(h));
    return 'OK';
  } catch (e) { return 'ERROR:' + e.message; }
});

// ---- Auto-tile ----
let prevAutoTileHwnds = [];

function autoTile(hwnds) {
  const sorted = [...hwnds].sort((a, b) => a - b);
  if (sorted.length === prevAutoTileHwnds.length &&
      sorted.every((h, i) => h === prevAutoTileHwnds[i])) return;
  prevAutoTileHwnds = sorted;
  if (sorted.length === 0) return;
  tileHwnds(sorted);
}

// ---- Get sessions (with HWND resolution + overlays + auto-tile) ----
function getSessions() {
  return new Promise((resolve) => {
    const script = resolveScript('get-sessions.ps1');
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { encoding: 'utf-8', timeout: 15000 }, (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          const p = JSON.parse(stdout.trim());
          resolve(Array.isArray(p) ? p : [p]);
        } catch { resolve([]); }
      });
  });
}

function resolveHwnds(arr, wtWindows) {
  // Clear stale HWNDs that no longer point to a valid window
  for (const s of arr) {
    if (s.hwnd && !IsWindow(s.hwnd)) s.hwnd = 0;
  }
  const needHwnd = arr.filter(s => !s.hwnd);
  if (needHwnd.length === 0) return;
  const knownHwnds = new Set(arr.filter(s => s.hwnd).map(s => Number(s.hwnd)));
  const unassigned = [];
  for (const [, wins] of wtWindows) {
    for (const w of wins) {
      if (!knownHwnds.has(w.hwnd)) unassigned.push(w);
    }
  }

  // Match by title containing project name or cwd leaf
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

  // Fallback: assign by screen position (left-to-right)
  const stillNeed = needHwnd.filter(s => !s.hwnd);
  if (stillNeed.length > 0 && unassigned.length > 0) {
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

ipcMain.handle('get-sessions', async () => {
  try {
    const arr = await getSessions();
    if (arr.length === 0) { overlayManager.syncOverlays([]); return []; }

    const wtWindows = enumWtWindows();
    resolveHwnds(arr, wtWindows);
    overlayManager.syncOverlays(arr);

    // Sync skill recommendation buttons on overlays
    try {
      const config = store.load();
      const recs = {};
      for (const [name, proj] of Object.entries(config.projects || {})) {
        const rec = scheduler.getRecommendedSkill(name, proj);
        if (rec) recs[name] = { skill: rec.skill, projectPath: proj.path };
      }
      overlayManager.syncSkillButtons(arr, recs);
    } catch (skillErr) {
      console.error('skillButtons error:', skillErr);
    }

    notifications.checkStatusChanges(arr, ({ hwnd, tabIndex }) => {
      if (hwnd) focusWindow(hwnd);
    });

    autoTile(getVisibleWtHwnds(wtWindows));

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

// ---- Resolve script paths ----
function resolveScript(name) {
  const dev = path.join(__dirname, name);
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, name);
}

// ---- Auto-setup statusLine ----
function setupStatusLine() {
  try {
    const settingsPath = path.join(process.env.USERPROFILE, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (settings.statusLine && settings.statusLine.includes('statusline-writer') && !settings.statusLine.includes('\\\\\\\\')) return;
    const scriptPath = resolveScript('lib/statusline-writer.js');
    settings.statusLine = `node "${scriptPath}"`;
    const tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(tmp, settingsPath);
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
const BAR_H = 48;

let barBoundsBeforePanel = null;

ipcMain.handle('toggle-panel', () => {
  if (!mainWindow) return;
  panelOpen = !panelOpen;
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;

  if (panelOpen) {
    appBarUnregister();

    const [bx, by] = mainWindow.getPosition();
    const [bw] = mainWindow.getSize();
    barBoundsBeforePanel = { x: bx, y: by, width: bw };

    const panelW = Math.min(Math.max(900, Math.round(wa.width * 0.7)), wa.width);
    const panelH = Math.min(Math.round(wa.height * 0.75), wa.height);
    const panelX = wa.x + Math.round((wa.width - panelW) / 2);
    const panelY = wa.y + Math.round((wa.height - panelH) / 2);
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setResizable(true);
    mainWindow.setBounds({ x: panelX, y: panelY, width: panelW, height: panelH });
    mainWindow.setResizable(false);
    mainWindow.focus();
  } else {
    const bounds = screen.getPrimaryDisplay().bounds;
    const b = barBoundsBeforePanel || { x: bounds.x, y: bounds.y, width: 600 };
    mainWindow.setResizable(true);
    mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: BAR_H });
    mainWindow.setResizable(false);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    barBoundsBeforePanel = null;
    appBarRegister();
  }
  return panelOpen;
});

ipcMain.handle('get-orchestrator-config', () => store.load());
ipcMain.handle('set-orchestrator-config', (ev, partial) => {
  const allowed = ['workHours', 'dailyBudgetUsd', 'blacklist', 'idleEnabled', 'idleMinutes', 'capacityEnabled', 'capacityThreshold', 'pacingEnabled', 'pacingMaxTarget', 'pacingExponent', 'timezone'];
  const safe = {};
  for (const k of allowed) if (k in partial) safe[k] = partial[k];
  return store.update(safe);
});

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

ipcMain.handle('get-scheduler-status', () => scheduler.getStatus());
ipcMain.handle('pause-scheduler', () => { scheduler.pause(); return true; });
ipcMain.handle('resume-scheduler', () => { scheduler.resume(); return true; });
ipcMain.handle('emergency-stop', () => { scheduler.pause(); return true; });

ipcMain.handle('get-token-history', () => tokenHistory.readHistory(50));
ipcMain.handle('get-token-history-stats', () => tokenHistory.getStats());

ipcMain.handle('get-dashboard-stats', () => statsAggregator.getDashboardStats());
ipcMain.handle('get-live-cycle', () => statsAggregator.getLiveCycle());

ipcMain.handle('add-to-queue', (ev, task) => store.enqueue(task));
ipcMain.handle('remove-from-queue', (ev, taskId) => { store.dequeue(taskId); return true; });
ipcMain.handle('get-skills', () => {
  return Object.entries(executor.SKILLS).map(([name, def]) => ({
    name,
    model: def.model,
    budgetUsd: def.budgetUsd
  }));
});

ipcMain.handle('set-project-priority', (ev, { name, priority }) => {
  const config = store.load();
  if (!config.priorityOverrides) config.priorityOverrides = {};
  if (priority === 'auto') {
    delete config.priorityOverrides[name];
  } else {
    config.priorityOverrides[name] = priority;
  }
  store.save(config);
  return true;
});

ipcMain.handle('get-project-priorities', () => {
  const config = store.load();
  const result = {};
  for (const [name, proj] of Object.entries(config.projects)) {
    result[name] = scheduler.getProjectPriority(name, proj, config);
  }
  return result;
});

// Dashboard IPC
ipcMain.handle('get-git-status', async (ev, cwd) => {
  try { return await gitStatus.getStatus(cwd); }
  catch { return { branch: null, dirty: 0, recentCommits: [] }; }
});
ipcMain.handle('get-session-log', (ev, cwd) => {
  try { return conversationReader.getConversationLog(cwd); }
  catch { return []; }
});

// ---- App lifecycle ----
app.setAppUserModelId('com.claudio.monitor');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show(); mainWindow.setAlwaysOnTop(true, 'screen-saver');
    if (!panelOpen) appBarRegister();
  }
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  overlayManager.startLoop();
  overlayManager.onSkillClick((project, skill, projectPath) => {
    store.enqueue({ project, skill, projectPath });
  });
  appBarRegister();
  mainWindow.webContents.on('did-finish-load', () => {
    checkHookSetup();
    setupStatusLine();
    checkForUpdates();
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
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
        try { return await getSessions(); }
        catch { return []; }
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
  appBarUnregister();
  overlayManager.setQuitting(true);
  scheduler.stop();
  overlayManager.stopLoop();
  overlayManager.destroyAll();
});
