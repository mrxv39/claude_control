/**
 * win32.js — Win32 API bindings via koffi.
 *
 * Centralizes all FFI declarations and helper functions for
 * window management on Windows.
 */

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const shell32 = koffi.load('shell32.dll');

// Window functions
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

// ---- AppBar (shell32) ----
const APPBARDATA = koffi.struct('APPBARDATA', {
  cbSize: 'uint32',
  hWnd: 'intptr',
  uCallbackMessage: 'uint32',
  uEdge: 'uint32',
  rc: RECT,
  lParam: 'intptr'
});
const SHAppBarMessage = shell32.func('uint __stdcall SHAppBarMessage(uint dwMessage, APPBARDATA *pData)');

const ABM_NEW = 0;
const ABM_REMOVE = 1;
const ABM_QUERYPOS = 2;
const ABM_SETPOS = 3;
const ABE_TOP = 1;

/**
 * Build the AppBar rect from display bounds and bar height (pure logic).
 * @param {{x: number, y: number, width: number}} displayBounds
 * @param {number} barHeight
 * @returns {{left: number, top: number, right: number, bottom: number}}
 */
function buildAppBarRect(displayBounds, barHeight) {
  return {
    left: displayBounds.x,
    top: displayBounds.y,
    right: displayBounds.x + displayBounds.width,
    bottom: displayBounds.y + barHeight
  };
}

/**
 * Register a window as a top-edge AppBar so Windows reserves screen space.
 * Idempotent: calls ABM_REMOVE first to clean up any stale registration
 * (e.g. from a previous process killed with taskkill /F).
 * @param {number} hwnd - native window handle
 * @param {number} barHeight - height in pixels to reserve
 */
function registerAppBar(hwnd, barHeight) {
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().bounds;
  const rc = buildAppBarRect(wa, barHeight);
  const abd = { cbSize: koffi.sizeof(APPBARDATA), hWnd: hwnd, uCallbackMessage: 0, uEdge: ABE_TOP,
    rc, lParam: 0 };
  // Defensive: remove stale registration before re-registering
  SHAppBarMessage(ABM_REMOVE, abd);
  SHAppBarMessage(ABM_NEW, abd);
  SHAppBarMessage(ABM_QUERYPOS, abd);
  abd.rc.bottom = abd.rc.top + barHeight;
  SHAppBarMessage(ABM_SETPOS, abd);
}

/**
 * Unregister an AppBar, restoring the original work area.
 * @param {number} hwnd - native window handle
 */
function unregisterAppBar(hwnd) {
  const abd = { cbSize: koffi.sizeof(APPBARDATA), hWnd: hwnd, uCallbackMessage: 0, uEdge: 0,
    rc: { left: 0, top: 0, right: 0, bottom: 0 }, lParam: 0 };
  SHAppBarMessage(ABM_REMOVE, abd);
}

/**
 * Enumerate all Windows Terminal windows.
 * @returns {Map<number, Array<{hwnd: number, title: string}>>} Map of WT PID -> windows
 */
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
    let title = '';
    for (let i = 0; i < titleBuf.length && titleBuf[i]; i++) title += String.fromCharCode(titleBuf[i]);
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push({ hwnd: Number(h), title });
  }
  return map;
}

/**
 * Focus a window, restoring it first if minimized.
 * Uses Alt key trick to bypass SetForegroundWindow restrictions.
 */
function focusWindow(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
  keybd_event(0x12, 0, 0, 0);
  keybd_event(0x12, 0, 2, 0);
  SetForegroundWindow(hwnd);
}

module.exports = {
  FindWindowA, GetForegroundWindow, ShowWindow, IsIconic, IsWindow,
  SetForegroundWindow, MoveWindow, GetWindowRect, IsWindowVisible,
  WindowFromPoint, GetAncestor, keybd_event, FindWindowExA,
  GetWindowThreadProcessId, GetWindowTextW, GetClassNameA,
  enumWtWindows, focusWindow, registerAppBar, unregisterAppBar, buildAppBarRect
};
