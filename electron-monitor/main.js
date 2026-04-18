const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog, shell } = require('electron');
const { execSync, execFile } = require('child_process');
const os = require('os');
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
const license = require('./lib/license');
const telemetry = require('./lib/telemetry');
const autonomousStore = require('./lib/autonomous-store');
const { AutonomousOrchestrator } = require('./lib/autonomous-orchestrator');
const tokenReport = require('./lib/token-report');
const goalSuggester = require('./lib/goal-suggester');

const {
  FindWindowA, ShowWindow, IsIconic, IsWindow, MoveWindow,
  GetWindowRect, IsWindowVisible, keybd_event, enumWtWindows, focusWindow,
  registerAppBar, unregisterAppBar
} = win32;

const SW_MINIMIZE = 6;
const SW_RESTORE = 9;

let mainWindow;
let tray = null;
let firstShowDone = false;   // bar created with show:false until first resize-bar
let autoOrchestrator = null; // AutonomousOrchestrator instance (starts in dry-run)

// Git cache for overlay titles (branch + dirty per cwd, 30s TTL)
const mainGitCache = {};     // cwd -> { branch, dirty }
const mainGitCacheTime = {}; // cwd -> timestamp
const MAIN_GIT_TTL = 30000;
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
    icon: path.join(__dirname, 'icon.ico'),
    // Hidden on creation; we show after the first resize-bar so the bar
    // doesn't visibly jump from initial 300px width to the real chip width.
    show: false,
    // Security note: contextIsolation:false is intentional — this is a local-only app
    // that never loads remote content. nodeIntegration is needed for IPC in the renderer.
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
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
      // Do NOT re-register AppBar here — re-registering on a visible bar
      // makes Windows reposition it from Y=0 into the workArea (Y=48). The
      // registration done at startup stays active across hide/show.
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
  // Keep AppBar reserved during hide. Unregistering + re-registering causes
  // Windows to relocate the bar to Y=BAR_H on the next show. The downside
  // (48px reserved strip while bar is invisible) is acceptable — apps still
  // respect the area, and on Mostrar the bar reappears exactly where it was.
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

  // Always center horizontally. We deliberately don't track user drags —
  // Windows DWM fires async 'move' events after AppBar/show operations that
  // are indistinguishable from real drags, polluting any position cache and
  // preventing the bar from re-centering when its width changes.
  const x = Math.round((bounds.width - width) / 2) + bounds.x;

  mainWindow.setBounds({ x, y: bounds.y, width, height: h });
  // First resize after startup: window was created with show:false to avoid
  // a visible jump from initial 300px to the real chip width. Show it now
  // that it's at the correct position. After this, hide-bar / Mostrar
  // control visibility — don't auto-show on subsequent resizes.
  if (!firstShowDone) {
    firstShowDone = true;
    mainWindow.show();
  }
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

    // Refresh git cache for overlay titles (non-blocking, 30s TTL)
    const now = Date.now();
    const cwds = new Set(arr.filter(s => s.cwd && s.cwd !== 'N/A').map(s => s.cwd));
    for (const cwd of cwds) {
      if (!mainGitCacheTime[cwd] || now - mainGitCacheTime[cwd] > MAIN_GIT_TTL) {
        mainGitCacheTime[cwd] = now;
        gitStatus.getStatus(cwd).then(g => { mainGitCache[cwd] = g; }).catch(() => {});
      }
    }
    // Enrich sessions with git data for overlays
    for (const s of arr) {
      const g = s.cwd ? mainGitCache[s.cwd] : null;
      s.gitBranch = g ? g.branch : null;
      s.gitDirty = g ? g.dirty : 0;
    }

    overlayManager.syncOverlays(arr);

    // Sync skill recommendation buttons on overlays
    try {
      const config = store.load();
      const recentLog = store.readLog(100);
      const recs = {};
      for (const [name, proj] of Object.entries(config.projects || {})) {
        const rec = scheduler.getRecommendedSkill(name, proj, { config, recentLog });
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
      telemetry.trackEvent('update_available', { from: PKG_VERSION, to: latest });
    }
  } catch {}
}

// ---- Resolve script paths ----
function resolveScript(name) {
  const dev = path.join(__dirname, name);
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, name);
}

const CLAUDE_SETTINGS_PATH = path.join(process.env.USERPROFILE, '.claude', 'settings.json');

// ---- Auto-setup statusLine ----
function setupStatusLine() {
  try {
    const settingsPath = CLAUDE_SETTINGS_PATH;
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
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) { mainWindow.webContents.send('hook-missing'); return; }
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
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
let panelWindow = null;
const BAR_H = 48;

ipcMain.handle('toggle-panel', () => {
  // Close existing panel window
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.close();
    return false;
  }

  // Open panel as a SEPARATE window so the bar stays at its original
  // position/size. Loads index.html with hash '#panel' — the renderer hides
  // the bar and shows the panel full-window when it detects that hash.
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const panelW = Math.min(Math.max(900, Math.round(wa.width * 0.7)), wa.width);
  const panelH = Math.round(wa.height * 0.85);
  const panelX = wa.x + Math.round((wa.width - panelW) / 2);
  const panelY = wa.y;

  panelWindow = new BrowserWindow({
    width: panelW, height: panelH, x: panelX, y: panelY,
    frame: false, transparent: false,
    skipTaskbar: false, resizable: true,
    backgroundColor: '#181825',
    parent: mainWindow,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  panelWindow.loadFile('index.html', { hash: 'panel' });
  panelWindow.once('ready-to-show', () => panelWindow.show());
  panelWindow.on('closed', () => {
    panelWindow = null;
    panelOpen = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('panel-closed');
    }
  });

  panelOpen = true;
  return true;
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
ipcMain.handle('pause-scheduler', () => { scheduler.pause(); telemetry.trackEvent('scheduler_pause', {}); return true; });
ipcMain.handle('resume-scheduler', () => { scheduler.resume(); telemetry.trackEvent('scheduler_resume', {}); return true; });
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

// ---- License activation IPC ----
ipcMain.handle('get-machine-id', async () => {
  try { return await license.getMachineId(); }
  catch { return ''; }
});

ipcMain.handle('activate', async (_ev, { email, name }) => {
  try {
    if (!email || typeof email !== 'string') return { ok: false, error: 'Email requerido' };
    const machineId = await license.getMachineId();
    const info = {
      machineId,
      email: email.trim(),
      name: (name || '').trim() || null,
      hostname: os.hostname(),
      username: os.userInfo().username,
      appVersion: PKG_VERSION
    };
    const res = await license.register(info);
    if (!res) {
      // v1: fall back to local-only activation so users can still run offline
      // during early beta. Backend picks them up on next online validation.
      license.saveLocalLicense({
        machineId, email: info.email, name: info.name,
        status: 'active', plan: 'beta',
        registeredAt: new Date().toISOString(),
        lastValidatedAt: new Date().toISOString(),
        appVersion: PKG_VERSION,
        offlineActivation: true
      });
      ipcMain.emit('activation-result', null, true);
      return { ok: true, offline: true };
    }
    if (res.status === 'active' || res.status === 'trial' || !res.status) {
      license.saveLocalLicense({
        machineId, email: info.email, name: info.name,
        status: 'active',
        plan: res.plan || 'beta',
        registeredAt: new Date().toISOString(),
        lastValidatedAt: new Date().toISOString(),
        appVersion: PKG_VERSION
      });
      ipcMain.emit('activation-result', null, true);
      return { ok: true };
    }
    return { ok: false, error: res.message || 'Registro rechazado' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: autonomous orchestrator (new system, F1+) ----

ipcMain.handle('auto:get-config', () => autonomousStore.getConfig());
ipcMain.handle('auto:update-config', (_ev, partial) => autonomousStore.updateConfig(partial));
ipcMain.handle('auto:get-project', (_ev, name) => autonomousStore.getProject(name));
ipcMain.handle('auto:update-project', (_ev, name, patch) => autonomousStore.updateProject(name, patch));
ipcMain.handle('auto:toggle-active', (_ev, name, active) => autonomousStore.toggleActive(name, active));
ipcMain.handle('auto:set-objective', (_ev, name, objective) => autonomousStore.setObjective(name, objective));
ipcMain.handle('auto:get-events', (_ev, n) => autonomousStore.readEvents(n || 200));

ipcMain.handle('auto:get-status', () => {
  if (!autoOrchestrator) return { running: false, dryRun: true };
  return {
    running: autoOrchestrator.isRunning(),
    dryRun: autoOrchestrator.isDryRun(),
    lastTickAt: autoOrchestrator.getLastTickAt(),
    lastTickResult: autoOrchestrator.getLastTickResult(),
  };
});

ipcMain.handle('auto:set-dry-run', (_ev, dryRun) => {
  if (!autoOrchestrator) return false;
  autoOrchestrator.setDryRun(!!dryRun);
  return true;
});

ipcMain.handle('auto:tick-now', async () => {
  if (!autoOrchestrator) return { action: 'skip', reason: 'orchestrator not running' };
  return autoOrchestrator.runTickNow();
});

ipcMain.handle('auto:start', () => {
  if (!autoOrchestrator) return false;
  autoOrchestrator.start();
  return true;
});

ipcMain.handle('auto:stop', () => {
  if (!autoOrchestrator) return false;
  autoOrchestrator.stop();
  return true;
});

ipcMain.handle('auto:token-report', (_ev, opts) => {
  const entries = tokenHistory.readHistory(500);
  const events = autonomousStore.readEvents(2000);
  return {
    summary: tokenReport.summarize(entries, opts),
    byDay: tokenReport.bucketByDay(entries),
    rankedCycles: tokenReport.rankCycles(entries, events, { limit: 30 }),
  };
});

ipcMain.handle('auto:token-avg', (_ev, windowDays) => {
  const entries = tokenHistory.readHistory(500);
  return tokenReport.computeAverage(entries, { windowDays: windowDays || 7 });
});

// Reads project files + git log for the detail drawer.
ipcMain.handle('auto:get-project-info', async (_ev, name) => {
  const project = autonomousStore.getProject(name);
  if (!project || !project.path) return { name, error: 'no-path' };
  const p = project.path;
  const out = { name, path: p, stack: project.stack, score: project.score };

  // README preview (first 2000 chars)
  const readmeCandidates = ['README.md', 'README.MD', 'Readme.md', 'readme.md', 'README'];
  for (const f of readmeCandidates) {
    try {
      const full = path.join(p, f);
      if (fs.existsSync(full)) {
        out.readme = fs.readFileSync(full, 'utf-8').slice(0, 2000);
        break;
      }
    } catch {}
  }

  // CLAUDE.md preview
  try {
    const claudeMd = path.join(p, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      out.claudeMd = fs.readFileSync(claudeMd, 'utf-8').slice(0, 2000);
    }
  } catch {}

  // package.json or Cargo.toml summary
  try {
    const pkg = path.join(p, 'package.json');
    const cargo = path.join(p, 'Cargo.toml');
    if (fs.existsSync(pkg)) {
      out.packageManifest = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
    } else if (fs.existsSync(cargo)) {
      out.packageManifest = { name: require('path').basename(p), _source: 'Cargo.toml' };
    }
  } catch {}

  // Recent git info
  try {
    out.lastCommitDays = await new Promise(resolve => {
      execFile('git', ['log', '-1', '--format=%ct'], { cwd: p, timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve(null);
        const ts = parseInt(stdout.trim(), 10);
        if (isNaN(ts)) return resolve(null);
        resolve(Math.floor((Date.now() / 1000 - ts) / 86400));
      });
    });
  } catch {}

  try {
    out.recentCommits = await new Promise(resolve => {
      execFile('git', ['log', '--since=14.days', '--oneline'], { cwd: p, timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(0);
        resolve(stdout.trim().split('\n').filter(Boolean).length);
      });
    });
  } catch {}

  try {
    out.recentCommitsList = await new Promise(resolve => {
      execFile('git', ['log', '-5', '--format=%h %s'], { cwd: p, timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(stdout.trim().split('\n').filter(Boolean).slice(0, 5));
      });
    });
  } catch {}

  return out;
});

// Analiza un proyecto con Claude Haiku — resumen humano de qué es.
// ~1-2k tokens por llamada. Es tirar tokens a propósito para ayudar al usuario
// a recordar/entender proyectos que tiene abandonados.
ipcMain.handle('auto:analyze-project', async (_ev, name) => {
  const project = autonomousStore.getProject(name);
  if (!project?.path) return { error: 'no-path' };
  const p = project.path;

  // Recolecta señales
  const parts = [];
  parts.push(`# Proyecto: ${name}`);
  parts.push(`Path: ${p}`);
  parts.push(`Stack detectado: ${project.stack || 'unknown'}`);

  const addFileIf = (relPath, header) => {
    try {
      const f = path.join(p, relPath);
      if (fs.existsSync(f)) {
        const content = fs.readFileSync(f, 'utf-8').slice(0, 3000);
        parts.push(`\n## ${header} (${relPath})\n${content}`);
      }
    } catch {}
  };
  addFileIf('README.md', 'README');
  addFileIf('CLAUDE.md', 'CLAUDE.md');
  addFileIf('package.json', 'package.json');
  addFileIf('Cargo.toml', 'Cargo.toml');
  addFileIf('pyproject.toml', 'pyproject.toml');

  // Estructura de top level (archivos + dirs de nivel 1)
  try {
    const entries = fs.readdirSync(p).slice(0, 40);
    parts.push(`\n## Archivos en raíz\n${entries.join('\n')}`);
  } catch {}

  // Últimos commits
  const recentLog = await new Promise(resolve => {
    execFile('git', ['log', '-10', '--format=%h %ci %s'], { cwd: p, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
  if (recentLog) parts.push(`\n## Últimos 10 commits\n${recentLog}`);

  const context = parts.join('\n').slice(0, 15000);
  const prompt = `Analiza este proyecto y escríbeme 3-4 frases MUY concretas en español respondiendo:

1. ¿Qué hace este proyecto? (o qué pretendía hacer si está abandonado)
2. ¿En qué estado está? (vivo, dormido, abandonado, experimento)
3. ¿Vale la pena activarlo en un orquestador autónomo? Recomendación clara:
   - activar con plantilla X (nombre concreto: production-ready | MVP-lanzable | mantenimiento | explorar-idea | seguro-y-testeado)
   - ignorar / pausar (razón breve)

SÉ DIRECTO. Sin preámbulos. Sin markdown. Prosa natural corta.

---

${context}`;

  return new Promise((resolve) => {
    const args = [
      '--print', '-p', prompt,
      '--model', 'haiku',
      '--max-turns', '1',
      '--output-format', 'text',
      '--dangerously-skip-permissions',
    ];
    const proc = require('child_process').spawn('claude', args, {
      cwd: p, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    proc.stdin.end();
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve({ error: 'timeout' }); }, 60000);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => { clearTimeout(timer); resolve({ error: e.message }); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ error: `exit ${code}: ${err.slice(0, 200)}` });
      resolve({ summary: out.trim() });
    });
  });
});

// Heurística local (sin LLM) para sugerir plantilla. Rápida y gratis.
ipcMain.handle('auto:suggest-goal', async (_ev, name) => {
  try {
    const info = await (async () => {
      // Reuse the same logic as get-project-info by calling the handler's work directly
      const p = autonomousStore.getProject(name);
      return {
        name,
        stack: p.stack,
        score: p.score,
        readme: null,  // will be filled below
        packageManifest: null,
        recentCommits: 0,
        lastCommitDays: null,
        checks: p.checks || {},
      };
    })();
    // Enrich with file reads
    const project = autonomousStore.getProject(name);
    if (project.path) {
      try {
        const readme = path.join(project.path, 'README.md');
        if (fs.existsSync(readme)) info.readme = fs.readFileSync(readme, 'utf-8').slice(0, 2000);
      } catch {}
      try {
        const pkg = path.join(project.path, 'package.json');
        if (fs.existsSync(pkg)) info.packageManifest = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
      } catch {}
    }
    // Heurística local (no LLM) por ahora — instantánea
    return goalSuggester.heuristicSuggest(info);
  } catch (e) {
    return { template: 'MVP-lanzable', confidence: 0.2, reasoning: `error: ${e.message}`, source: 'heuristic' };
  }
});

ipcMain.handle('track', (_ev, type, payload) => {
  try { telemetry.trackEvent(type, payload || {}); }
  catch {}
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

// Shown once on first run (or when cache is invalid). Modal BrowserWindow that
// posts credentials back via the 'activate' IPC handler, then self-closes.
function showActivationWindow() {
  return new Promise(resolve => {
    const w = new BrowserWindow({
      width: 500, height: 560,
      frame: false, resizable: false,
      backgroundColor: '#181825',
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    let activated = false;
    w.on('close', () => resolve({ ok: activated }));
    ipcMain.once('activation-result', (_e, ok) => { activated = !!ok; });
    w.loadFile('activation.html');
    w.once('ready-to-show', () => { w.center(); w.show(); });
  });
}

app.whenReady().then(async () => {
  // ---- License gate (runs before any UI) ----
  const gate = await license.checkLicenseGate();

  if (gate.revoked) {
    dialog.showErrorBox('Acceso revocado',
      `Tu acceso a Claudio Control ha sido revocado.\n\nMotivo: ${gate.reason || 'sin detalles'}\n\nContacta: xavieeee@gmail.com`);
    app.quit();
    return;
  }

  if (gate.needsActivation || gate.needsReconnect) {
    const title = gate.needsReconnect ? 'Reconexión necesaria' : 'Activar Claudio Control';
    const result = await showActivationWindow();
    if (!result.ok) { app.quit(); return; }
    // Re-read the just-written license
    const fresh = license.getLocalLicense();
    if (!fresh) { app.quit(); return; }
    gate.machineId = fresh.machineId;
  }

  // ---- Normal startup ----
  createWindow();
  createTray();
  overlayManager.startLoop();
  overlayManager.onSkillClick((project, skill, projectPath) => {
    store.enqueue({ project, skill, projectPath });
    telemetry.trackEvent('skill_enqueue', { skill, source: 'manual' });
  });
  appBarRegister();

  telemetry.startSession(gate.machineId, PKG_VERSION);
  telemetry.trackEvent('app_start', { version: PKG_VERSION });

  mainWindow.webContents.on('did-finish-load', () => {
    checkHookSetup();
    setupStatusLine();
    checkForUpdates();
    setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
    // Periodic license re-validation (revoke detection).
    setInterval(async () => {
      const res = await license.validate(gate.machineId, PKG_VERSION);
      if (res && res.status === 'revoked') {
        dialog.showErrorBox('Acceso revocado',
          `Tu acceso a Claudio Control ha sido revocado.\n\nMotivo: ${res.revokedReason || 'sin detalles'}\n\nContacta: xavieeee@gmail.com`);
        isQuitting = true;
        app.quit();
      }
    }, 6 * 60 * 60 * 1000);
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

    // Start the autonomous orchestrator (goal-driven, LLM planner).
    // Starts in DRY-RUN mode — it observes and decides, but does NOT execute.
    // Coexists safely with the queue-based scheduler above. Toggle with
    // `auto:set-dry-run` IPC once the new UI is wired.
    autoOrchestrator = new AutonomousOrchestrator({
      getConfig: async () => autonomousStore.getConfig(),
      analyze: async (project) => analyzer.analyze(project),
      updateProject: async (name, patch) => autonomousStore.updateProject(name, patch),
      dryRun: true,
      onEvent: (event) => {
        autonomousStore.appendEvent(event);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auto:event', event);
        }
      },
    });
    autoOrchestrator.start();
  });
});
app.on('window-all-closed', () => { /* don't quit — tray keeps running */ });
app.on('before-quit', async () => {
  isQuitting = true;
  try { telemetry.trackEvent('app_stop', {}); } catch {}
  try { await telemetry.endSession(); } catch {}
  appBarUnregister();
  overlayManager.setQuitting(true);
  scheduler.stop();
  try { if (autoOrchestrator) autoOrchestrator.stop(); } catch {}
  overlayManager.stopLoop();
  overlayManager.destroyAll();
});
