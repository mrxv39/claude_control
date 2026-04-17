/**
 * overlay-manager.js — Title overlay windows pinned to each WT window.
 *
 * Creates small frameless BrowserWindows that sit on top of WT title bars
 * showing project name + status color. Repositions at ~30fps, hides when
 * the WT window is occluded, minimized, or destroyed.
 */

/**
 * @typedef {Object} OverlayInfo
 * @property {Electron.BrowserWindow} win
 * @property {string} label
 * @property {string} status - 'BUSY' | 'WAITING' | 'IDLE'
 * @property {boolean} offscreen - Currently hidden
 * @property {number} [lastX]
 * @property {number} [lastY]
 * @property {number} [lastW]
 */

/**
 * @typedef {Object} SkillOverlayInfo
 * @property {Electron.BrowserWindow} win
 * @property {string} skill
 * @property {string} project
 * @property {string} projectPath
 * @property {boolean} offscreen
 * @property {number} [lastX]
 * @property {number} [lastY]
 */

const { BrowserWindow } = require('electron');
const { IsWindow, IsWindowVisible, IsIconic, GetWindowRect, WindowFromPoint, GetAncestor } = require('./win32');

/** @type {Map<number, OverlayInfo>} hwnd -> overlay state */
const overlays = new Map();
/** @type {Map<number, SkillOverlayInfo>} hwnd -> skill button state */
const skillOverlays = new Map();
const OVERLAY_H = 33;
const SKILL_BTN_W = 160;
const OVERLAY_BTN_MARGIN = 140; // space for WT minimize/maximize/close buttons

/** @type {ReturnType<typeof setInterval>|null} */
let pollTimer = null;
let quitting = false;
/** @type {((project: string, skill: string, projectPath: string) => void)|null} */
let onClickCb = null;

/** @param {boolean} val */
function setQuitting(val) { quitting = val; }
/** @param {(project: string, skill: string, projectPath: string) => void} cb */
function onSkillClick(cb) { onClickCb = cb; }

const escapeHtml = require('./utils').escapeHtml;

/**
 * @param {string} label
 * @param {string} status - 'BUSY' | 'WAITING' | 'IDLE'
 * @returns {string} data: URL for overlay HTML
 */
function overlayHtml(label, status) {
  const safe = escapeHtml(label);
  const bg = status === 'BUSY' ? 'rgba(158,206,106,1)' : 'rgba(247,118,142,1)';
  const textColor = status === 'BUSY' ? '#1a2e0a' : '#3a0a12';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:'Segoe UI',sans-serif;">
<div style="background:${bg};border:1px solid ${bg};border-top:none;color:${textColor};font-size:16px;font-weight:700;padding:5px 15px;border-radius:0 0 8px 8px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:22px;">${safe}</div>
</body></html>`);
}

/**
 * Create a frameless overlay BrowserWindow with shared defaults.
 * @param {number} width
 * @param {boolean} [clickable=false] - If false, ignores mouse events
 * @returns {Electron.BrowserWindow}
 */
function createBaseOverlay(width, clickable = false) {
  const win = new BrowserWindow({
    width, height: OVERLAY_H,
    x: -9999, y: -9999,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false,
    hasShadow: false, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  if (!clickable) win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win._ready = false;
  win.once('ready-to-show', () => { win._ready = true; win.showInactive(); });
  return win;
}

/**
 * @param {number} hwnd
 * @param {string} label
 * @param {string} status
 * @returns {Electron.BrowserWindow}
 */
function createOverlay(hwnd, label, status) {
  const win = createBaseOverlay(400);
  win.loadURL(overlayHtml(label, status));
  return win;
}

/**
 * @param {string} skill
 * @returns {string} data: URL for skill button HTML
 */
function skillButtonHtml(skill) {
  const safe = escapeHtml(skill.length > 14 ? skill.slice(0, 13) + '\u2026' : skill);
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:'Segoe UI',sans-serif;cursor:pointer;">
<div onclick="document.title='CLICK'" style="background:rgba(224,175,104,.85);color:#1a1b26;font-size:13px;font-weight:700;padding:5px 12px;border-radius:0 0 8px 8px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:22px;">${safe} \u25B6</div>
</body></html>`);
}

/**
 * @param {number} hwnd
 * @param {string} skill
 * @param {string} project
 * @param {string} projectPath
 * @returns {Electron.BrowserWindow}
 */
function createSkillOverlay(hwnd, skill, project, projectPath) {
  const win = createBaseOverlay(SKILL_BTN_W, true);
  win.loadURL(skillButtonHtml(skill));

  win.webContents.on('page-title-updated', (ev, title) => {
    ev.preventDefault();
    if (title === 'CLICK') {
      if (onClickCb) onClickCb(project, skill, projectPath);
      // Visual feedback: briefly change to hourglass
      win.loadURL(skillButtonHtml('\u23F3'));
      // Next syncSkillButtons cycle (3s) will update with next skill or remove
    }
  });

  return win;
}

/**
 * Sync skill recommendation buttons to WT windows.
 * @param {Array<{hwnd: number, project: string}>} sessions
 * @param {Object<string, {skill: string, projectPath: string}>} recommendations
 */
function syncSkillButtons(sessions, recommendations) {
  const live = new Map();
  for (const s of sessions) {
    if (!s.hwnd || !IsWindow(s.hwnd)) continue;
    const rec = recommendations[s.project];
    if (rec) {
      live.set(Number(s.hwnd), { project: s.project, skill: rec.skill, projectPath: rec.projectPath });
    }
  }

  // Remove stale skill overlays
  for (const [h, info] of skillOverlays) {
    if (!live.has(h)) { try { info.win.destroy(); } catch {} skillOverlays.delete(h); }
  }

  // Create or update
  for (const [h, data] of live) {
    let info = skillOverlays.get(h);
    if (!info) {
      const win = createSkillOverlay(h, data.skill, data.project, data.projectPath);
      info = { win, skill: data.skill, project: data.project, projectPath: data.projectPath, offscreen: true };
      skillOverlays.set(h, info);
    } else if (info.skill !== data.skill) {
      info.win.loadURL(skillButtonHtml(data.skill));
      info.skill = data.skill;
      info.project = data.project;
      info.projectPath = data.projectPath;
    }
  }
}

/**
 * Sync title overlays to match current session list.
 * @param {Array<{hwnd: number, project: string, status: string}>} sessions
 */
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
  if (quitting) return;
  for (const [h, info] of overlays) {
    if (!info.win || info.win.isDestroyed()) { overlays.delete(h); continue; }
    if (!info.win._ready) continue;
    try {
      if (!IsWindow(h) || !IsWindowVisible(h) || IsIconic(h)) {
        if (!info.offscreen) { info.win.hide(); info.offscreen = true; }
        continue;
      }
      const r = {};
      if (!GetWindowRect(h, r)) continue;
      const wWidth = r.right - r.left;
      const wHeight = r.bottom - r.top;
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
      const hasSkillBtn = skillOverlays.has(h);
      const overlayW = Math.max(100, wWidth - OVERLAY_BTN_MARGIN - (hasSkillBtn ? SKILL_BTN_W + 4 : 0));
      const nx = r.left, ny = r.top + 4;
      if (nx !== info.lastX || ny !== info.lastY || overlayW !== info.lastW) {
        info.win.setBounds({ x: nx, y: ny, width: overlayW, height: OVERLAY_H });
        info.lastX = nx; info.lastY = ny; info.lastW = overlayW;
      }
      if (info.offscreen) { info.win.showInactive(); info.offscreen = false; }

      // Reposition skill button overlay alongside
      const si = skillOverlays.get(h);
      if (si && si.win && !si.win.isDestroyed()) {
        if (si.win._ready) {
          const sx = nx + overlayW + 4, sy = ny;
          if (sx !== si.lastX || sy !== si.lastY) {
            si.win.setBounds({ x: sx, y: sy, width: SKILL_BTN_W, height: OVERLAY_H });
            si.lastX = sx; si.lastY = sy;
          }
          if (si.offscreen) { si.win.showInactive(); si.offscreen = false; }
        }
      }
    } catch {
      overlays.delete(h);
    }
  }

  // Hide skill overlays for occluded/hidden parent windows
  for (const [h, si] of skillOverlays) {
    if (!si.win || si.win.isDestroyed()) { skillOverlays.delete(h); continue; }
    if (!overlays.has(h) || (overlays.get(h).offscreen && !si.offscreen)) {
      si.win.hide(); si.offscreen = true;
    }
  }
}

function startLoop() {
  if (pollTimer) return;
  pollTimer = setInterval(repositionOverlays, 60);
}

function stopLoop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function destroyAll() {
  for (const [, info] of overlays) {
    try { if (info.win && !info.win.isDestroyed()) info.win.destroy(); } catch {}
  }
  overlays.clear();
  for (const [, info] of skillOverlays) {
    try { if (info.win && !info.win.isDestroyed()) info.win.destroy(); } catch {}
  }
  skillOverlays.clear();
}

module.exports = { syncOverlays, syncSkillButtons, startLoop, stopLoop, destroyAll, setQuitting, onSkillClick };
