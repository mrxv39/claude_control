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

// Bounded-concurrency queue for git-status refreshes. Without this, if many
// stale cwds expire on the same tick, we'd spawn N git processes at once
// (each forks git + child_process overhead).
const GIT_REFRESH_CONCURRENCY = 3;
let gitRefreshInFlight = 0;
const gitRefreshQueue = [];

function runGitRefresh(cwd) {
  gitRefreshInFlight++;
  gitStatus.getStatus(cwd)
    .then(g => { mainGitCache[cwd] = g; })
    .catch(() => {})
    .finally(() => {
      gitRefreshInFlight--;
      const next = gitRefreshQueue.shift();
      if (next) runGitRefresh(next);
    });
}

function scheduleGitRefresh(cwd) {
  if (gitRefreshInFlight < GIT_REFRESH_CONCURRENCY) runGitRefresh(cwd);
  else gitRefreshQueue.push(cwd);
}

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

// ---- Window IPC handlers (hide-bar, minimize/restore, resize, focus, tile) ----
const { getVisibleWtHwnds, tileHwnds } = require('./lib/ipc/window-handlers').register(ipcMain, {
  getMainWindow: () => mainWindow,
  win32,
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

    // Refresh git cache for overlay titles (non-blocking, 30s TTL, concurrency-capped)
    const now = Date.now();
    const cwds = new Set(arr.filter(s => s.cwd && s.cwd !== 'N/A').map(s => s.cwd));
    for (const cwd of cwds) {
      if (!mainGitCacheTime[cwd] || now - mainGitCacheTime[cwd] > MAIN_GIT_TTL) {
        mainGitCacheTime[cwd] = now;
        scheduleGitRefresh(cwd);
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

// ---- Startup helpers (update checker, script paths, statusLine, hook check) ----
const PKG_VERSION = require('./package.json').version;
const startup = require('./lib/startup-helpers').init({
  appRoot: __dirname,
  getMainWindow: () => mainWindow,
  telemetry, ipcMain, pkgVersion: PKG_VERSION,
});
const { resolveScript, checkForUpdates, setupStatusLine, checkHookSetup } = startup;

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

require('./lib/ipc/orchestrator-handlers').register(ipcMain, {
  store, scanner, analyzer, scheduler, telemetry,
  tokenHistory, statsAggregator, executor,
  gitStatus, conversationReader,
});

require('./lib/ipc/autonomous-handlers').register(ipcMain, {
  autonomousStore, tokenHistory, tokenReport, goalSuggester, telemetry,
  getAutoOrchestrator: () => autoOrchestrator,
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
