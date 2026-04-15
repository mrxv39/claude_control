/**
 * overlay-manager.js — Title overlay windows pinned to each WT window.
 *
 * Creates small frameless BrowserWindows that sit on top of WT title bars
 * showing project name + status color. Repositions at ~30fps, hides when
 * the WT window is occluded, minimized, or destroyed.
 */

const { BrowserWindow } = require('electron');
const { IsWindow, IsWindowVisible, IsIconic, GetWindowRect, WindowFromPoint, GetAncestor } = require('./win32');

const overlays = new Map(); // hwnd -> { win, label, status, offscreen }
const OVERLAY_H = 33;
const OVERLAY_BTN_MARGIN = 140; // space for WT minimize/maximize/close buttons

let pollTimer = null;
let quitting = false;

function setQuitting(val) { quitting = val; }

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
      const overlayW = Math.max(100, wWidth - OVERLAY_BTN_MARGIN);
      info.win.setBounds({ x: r.left, y: r.top + 4, width: overlayW, height: OVERLAY_H });
      if (info.offscreen) { info.win.showInactive(); info.offscreen = false; }
    } catch {
      overlays.delete(h);
    }
  }
}

function startLoop() {
  if (pollTimer) return;
  pollTimer = setInterval(repositionOverlays, 33);
}

function stopLoop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function destroyAll() {
  for (const [, info] of overlays) {
    try { if (info.win && !info.win.isDestroyed()) info.win.destroy(); } catch {}
  }
  overlays.clear();
}

module.exports = { syncOverlays, startLoop, stopLoop, destroyAll, setQuitting };
