import { describe, it, expect } from 'vitest';

/**
 * Tests for window-handlers.js pure logic (visible-hwnd filter + tile layout).
 *
 * window-handlers.js requires `electron` at module load (for `screen`),
 * so we mirror the pure pieces here. Same pattern as appbar.test.js and
 * startup-helpers.test.js. If the logic drifts in window-handlers.js,
 * these tests act as an executable spec.
 */

// ---- getVisibleWtHwnds mirror (from window-handlers.js:25-35) ----
function makeGetVisibleWtHwnds(win32) {
  const { IsWindow, IsWindowVisible, IsIconic } = win32;
  return function getVisibleWtHwnds(wtWindows) {
    const hwnds = [];
    for (const [, wins] of wtWindows) {
      for (const w of wins) {
        if (w.hwnd && IsWindow(w.hwnd) && IsWindowVisible(w.hwnd) && !IsIconic(w.hwnd)) {
          hwnds.push(w.hwnd);
        }
      }
    }
    return hwnds;
  };
}

// ---- tileHwnds mirror (from window-handlers.js:39-60) ----
const SW_RESTORE = 9;
function makeTileHwnds(win32, workArea) {
  const { ShowWindow, MoveWindow } = win32;
  return function tileHwnds(hwnds, { singleFull = false } = {}) {
    const n = hwnds.length;
    if (n === 0) return;

    let cols, rows;
    if (n === 1)      { cols = singleFull ? 1 : 2; rows = 1; }
    else if (n === 2) { cols = 2; rows = 1; }
    else if (n === 3) { cols = 3; rows = 1; }
    else if (n === 4) { cols = 2; rows = 2; }
    else { cols = Math.ceil(Math.sqrt(n)); rows = Math.ceil(n / cols); }

    const cellW = Math.floor(workArea.width / cols);
    const cellH = Math.floor(workArea.height / rows);

    hwnds.forEach((h, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      ShowWindow(h, SW_RESTORE);
      MoveWindow(h, workArea.x + c * cellW, workArea.y + r * cellH, cellW, cellH, true);
    });
  };
}

function makeSpyWin32(overrides = {}) {
  const moves = [];
  const shown = [];
  return {
    moves, shown,
    IsIconic: overrides.IsIconic || (() => false),
    IsWindow: overrides.IsWindow || (() => true),
    MoveWindow: (h, x, y, w, hh) => { moves.push({ h, x, y, w, h: hh }); },
    IsWindowVisible: overrides.IsWindowVisible || (() => true),
    ShowWindow: (h, cmd) => { shown.push({ h, cmd }); },
  };
}

describe('getVisibleWtHwnds', () => {
  it('returns hwnds that are valid, visible, and not minimized', () => {
    const win32 = makeSpyWin32({
      IsWindow: (h) => h !== 999,         // 999 = invalid
      IsWindowVisible: (h) => h !== 200,  // 200 = hidden
      IsIconic: (h) => h === 300,         // 300 = minimized
    });
    const getVisibleWtHwnds = makeGetVisibleWtHwnds(win32);

    const wtWindows = new Map([
      [1234, [
        { hwnd: 100, title: 'good' },
        { hwnd: 200, title: 'hidden' },
        { hwnd: 300, title: 'minimized' },
        { hwnd: 999, title: 'invalid' },
      ]],
      [5678, [{ hwnd: 400, title: 'also good' }]],
    ]);

    expect(getVisibleWtHwnds(wtWindows).sort()).toEqual([100, 400]);
  });

  it('returns empty array for empty wtWindows', () => {
    const getVisibleWtHwnds = makeGetVisibleWtHwnds(makeSpyWin32());
    expect(getVisibleWtHwnds(new Map())).toEqual([]);
  });

  it('filters out hwnd=0 (falsy guard)', () => {
    const getVisibleWtHwnds = makeGetVisibleWtHwnds(makeSpyWin32());
    const wtWindows = new Map([[1, [{ hwnd: 0, title: 'zero' }, { hwnd: 5, title: 'five' }]]]);
    expect(getVisibleWtHwnds(wtWindows)).toEqual([5]);
  });

  it('preserves order within the same PID bucket', () => {
    const getVisibleWtHwnds = makeGetVisibleWtHwnds(makeSpyWin32());
    const wtWindows = new Map([[1, [
      { hwnd: 30, title: 'a' },
      { hwnd: 10, title: 'b' },
      { hwnd: 20, title: 'c' },
    ]]]);
    expect(getVisibleWtHwnds(wtWindows)).toEqual([30, 10, 20]);
  });
});

describe('tileHwnds layout', () => {
  // Synthetic workArea — leaves 48px reserved for the AppBar on top.
  const WORK_AREA = { x: 0, y: 48, width: 1920, height: 1032 };

  function runLayout(hwnds, opts) {
    const win32 = makeSpyWin32();
    const tileHwnds = makeTileHwnds(win32, WORK_AREA);
    tileHwnds(hwnds, opts);
    return win32.moves;
  }

  it('does nothing for empty input', () => {
    expect(runLayout([])).toEqual([]);
  });

  it('n=1 default: half-width column on the left (leaves room for a future second window)', () => {
    expect(runLayout([100])).toEqual([
      { h: 100, x: 0, y: 48, w: 960, h: 1032 },
    ]);
  });

  it('n=1 singleFull=true: fills the full workArea', () => {
    expect(runLayout([100], { singleFull: true })).toEqual([
      { h: 100, x: 0, y: 48, w: 1920, h: 1032 },
    ]);
  });

  it('n=2: two equal columns side by side', () => {
    expect(runLayout([100, 200])).toEqual([
      { h: 100, x: 0,   y: 48, w: 960, h: 1032 },
      { h: 200, x: 960, y: 48, w: 960, h: 1032 },
    ]);
  });

  it('n=3: three columns on a single row', () => {
    const moves = runLayout([1, 2, 3]);
    expect(moves.map(m => ({ x: m.x, w: m.w }))).toEqual([
      { x: 0,    w: 640 },
      { x: 640,  w: 640 },
      { x: 1280, w: 640 },
    ]);
    expect(new Set(moves.map(m => m.y))).toEqual(new Set([48]));
  });

  it('n=4: 2x2 grid', () => {
    expect(runLayout([1, 2, 3, 4])).toEqual([
      { h: 1, x: 0,   y: 48,       w: 960, h: 516 },
      { h: 2, x: 960, y: 48,       w: 960, h: 516 },
      { h: 3, x: 0,   y: 48 + 516, w: 960, h: 516 },
      { h: 4, x: 960, y: 48 + 516, w: 960, h: 516 },
    ]);
  });

  it('n=5: ceil(sqrt(5))=3 cols, 2 rows', () => {
    const moves = runLayout([1, 2, 3, 4, 5]);
    // cellW = floor(1920/3) = 640, cellH = floor(1032/2) = 516
    expect(moves.length).toBe(5);
    expect(moves[0]).toEqual({ h: 1, x: 0,    y: 48,       w: 640, h: 516 });
    expect(moves[2]).toEqual({ h: 3, x: 1280, y: 48,       w: 640, h: 516 });
    expect(moves[3]).toEqual({ h: 4, x: 0,    y: 48 + 516, w: 640, h: 516 });
  });

  it('n=9: perfect 3x3 grid', () => {
    const moves = runLayout([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(moves.length).toBe(9);
    // cols=ceil(sqrt(9))=3, rows=ceil(9/3)=3, cell 640x344
    expect(moves[0]).toMatchObject({ x: 0, y: 48, w: 640 });
    expect(moves[8]).toMatchObject({ x: 1280 });
  });

  it('restores each window before moving (SW_RESTORE=9)', () => {
    const win32 = makeSpyWin32();
    const tileHwnds = makeTileHwnds(win32, WORK_AREA);
    tileHwnds([10, 20, 30]);
    expect(win32.shown.map(s => s.cmd)).toEqual([SW_RESTORE, SW_RESTORE, SW_RESTORE]);
    expect(win32.shown.map(s => s.h)).toEqual([10, 20, 30]);
  });

  it('respects non-zero workArea origin (multi-monitor or reserved top bar)', () => {
    const win32 = makeSpyWin32();
    const offsetArea = { x: -1920, y: 100, width: 1920, height: 1000 };
    const tileHwnds = makeTileHwnds(win32, offsetArea);
    tileHwnds([1, 2]);
    expect(win32.moves).toEqual([
      { h: 1, x: -1920, y: 100, w: 960, h: 1000 },
      { h: 2, x: -960,  y: 100, w: 960, h: 1000 },
    ]);
  });
});
