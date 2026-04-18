// lib/ipc/window-handlers.js — IPC de manejo de ventanas:
// hide-bar, minimize-all-wt, restore-wt, resize-bar, focus-wt, tile-windows.
// Exporta tambien getVisibleWtHwnds y tileHwnds (reutilizados por autoTile).
//
// Dependencias del main:
// - getMainWindow: getter de mainWindow (puede no existir durante init)
// - win32: bindings FFI
// - electron (se require aqui para screen)

const { screen } = require('electron');

const SW_MINIMIZE = 6;
const SW_RESTORE = 9;

function register(ipcMain, deps) {
  const { getMainWindow, win32 } = deps;
  const {
    FindWindowA, ShowWindow, IsIconic, IsWindow, MoveWindow,
    IsWindowVisible, keybd_event, enumWtWindows, focusWindow,
  } = win32;

  let firstShowDone = false;
  let lastFocusedViaChip = 0;

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

  ipcMain.handle('hide-bar', () => {
    const mw = getMainWindow();
    if (!mw) return;
    // Keep AppBar reserved during hide. Unregistering + re-registering causes
    // Windows to relocate the bar to Y=BAR_H on the next show. The downside
    // (48px reserved strip while bar is invisible) is acceptable — apps still
    // respect the area, and on Mostrar the bar reappears exactly where it was.
    mw.hide();
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
    const mw = getMainWindow();
    if (!mw) return;
    const n = Number(w);
    if (!Number.isFinite(n)) return;
    const bounds = screen.getPrimaryDisplay().bounds;
    const width = Math.max(180, Math.min(Math.ceil(n), bounds.width));
    const [, h] = mw.getSize();

    // Always center horizontally. We deliberately don't track user drags —
    // Windows DWM fires async 'move' events after AppBar/show operations that
    // are indistinguishable from real drags, polluting any position cache and
    // preventing the bar from re-centering when its width changes.
    const x = Math.round((bounds.width - width) / 2) + bounds.x;

    mw.setBounds({ x, y: bounds.y, width, height: h });
    // First resize after startup: window was created with show:false to avoid
    // a visible jump from initial 300px to the real chip width. Show it now
    // that it's at the correct position. After this, hide-bar / Mostrar
    // control visibility — don't auto-show on subsequent resizes.
    if (!firstShowDone) {
      firstShowDone = true;
      mw.show();
    }
  });

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

  return { getVisibleWtHwnds, tileHwnds };
}

module.exports = { register, SW_MINIMIZE, SW_RESTORE };
