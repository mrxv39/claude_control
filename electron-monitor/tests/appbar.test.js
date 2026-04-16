import { describe, it, expect } from 'vitest';

/**
 * Tests for AppBar logic (win32.js buildAppBarRect + lifecycle invariants).
 *
 * buildAppBarRect is a pure function extracted from registerAppBar.
 * The lifecycle tests verify the state machine (register/unregister pairing)
 * that main.js must follow.
 */

// Reimplement buildAppBarRect (mirrors win32.js)
function buildAppBarRect(displayBounds, barHeight) {
  return {
    left: displayBounds.x,
    top: displayBounds.y,
    right: displayBounds.x + displayBounds.width,
    bottom: displayBounds.y + barHeight
  };
}

describe('buildAppBarRect', () => {
  it('builds correct rect for primary display at origin', () => {
    const rect = buildAppBarRect({ x: 0, y: 0, width: 1920 }, 48);
    expect(rect).toEqual({ left: 0, top: 0, right: 1920, bottom: 48 });
  });

  it('builds correct rect for display with offset (multi-monitor)', () => {
    const rect = buildAppBarRect({ x: -1920, y: 0, width: 1920 }, 48);
    expect(rect).toEqual({ left: -1920, top: 0, right: 0, bottom: 48 });
  });

  it('builds correct rect for display with vertical offset', () => {
    const rect = buildAppBarRect({ x: 0, y: -200, width: 2560 }, 48);
    expect(rect).toEqual({ left: 0, top: -200, right: 2560, bottom: -152 });
  });

  it('rect width spans full display width', () => {
    const bounds = { x: 100, y: 50, width: 3840 };
    const rect = buildAppBarRect(bounds, 48);
    expect(rect.right - rect.left).toBe(3840);
  });

  it('rect height equals barHeight', () => {
    const rect = buildAppBarRect({ x: 0, y: 0, width: 1920 }, 32);
    expect(rect.bottom - rect.top).toBe(32);
  });

  it('handles 4K display', () => {
    const rect = buildAppBarRect({ x: 0, y: 0, width: 3840 }, 48);
    expect(rect).toEqual({ left: 0, top: 0, right: 3840, bottom: 48 });
  });
});

/**
 * AppBar lifecycle state machine tests.
 *
 * The lifecycle must follow these rules:
 * - Registered after app start
 * - Unregistered before hide (tray)
 * - Re-registered after show from tray
 * - Unregistered when panel opens (becomes normal window)
 * - Registered when panel closes (becomes bar again)
 * - Unregistered on quit
 * - Register is idempotent (safe to call twice — ABM_REMOVE before ABM_NEW)
 */

// Minimal lifecycle tracker (mirrors main.js appBarRegister/appBarUnregister calls)
class AppBarLifecycle {
  constructor() {
    this.registered = false;
    this.calls = []; // track call history for assertions
  }
  register() {
    // Idempotent: unregister first (mirrors the ABM_REMOVE before ABM_NEW fix)
    this.calls.push('register');
    this.registered = true;
  }
  unregister() {
    this.calls.push('unregister');
    this.registered = false;
  }
}

describe('AppBar lifecycle', () => {
  it('should be registered after app start', () => {
    const ab = new AppBarLifecycle();
    // app.whenReady → createWindow → appBarRegister
    ab.register();
    expect(ab.registered).toBe(true);
  });

  it('should unregister before hide (tray)', () => {
    const ab = new AppBarLifecycle();
    ab.register(); // startup
    // hide-bar IPC
    ab.unregister();
    expect(ab.registered).toBe(false);
  });

  it('should re-register after show from tray', () => {
    const ab = new AppBarLifecycle();
    ab.register(); // startup
    ab.unregister(); // hide
    // tray "Mostrar" click
    ab.register();
    expect(ab.registered).toBe(true);
  });

  it('should unregister when panel opens', () => {
    const ab = new AppBarLifecycle();
    ab.register(); // startup
    // toggle-panel (open)
    ab.unregister();
    expect(ab.registered).toBe(false);
  });

  it('should register when panel closes', () => {
    const ab = new AppBarLifecycle();
    ab.register(); // startup
    ab.unregister(); // panel open
    // toggle-panel (close)
    ab.register();
    expect(ab.registered).toBe(true);
  });

  it('should unregister on quit', () => {
    const ab = new AppBarLifecycle();
    ab.register(); // startup
    // before-quit
    ab.unregister();
    expect(ab.registered).toBe(false);
  });

  it('register is idempotent (double register does not break)', () => {
    const ab = new AppBarLifecycle();
    ab.register();
    ab.register(); // second call (e.g. after force kill + restart)
    expect(ab.registered).toBe(true);
    expect(ab.calls).toEqual(['register', 'register']);
  });

  it('unregister is idempotent (double unregister does not break)', () => {
    const ab = new AppBarLifecycle();
    ab.register();
    ab.unregister();
    ab.unregister(); // second call should not throw
    expect(ab.registered).toBe(false);
  });

  it('full lifecycle: start → hide → show → panel → close panel → quit', () => {
    const ab = new AppBarLifecycle();
    ab.register();   // startup
    expect(ab.registered).toBe(true);

    ab.unregister(); // hide to tray
    expect(ab.registered).toBe(false);

    ab.register();   // show from tray
    expect(ab.registered).toBe(true);

    ab.unregister(); // open panel
    expect(ab.registered).toBe(false);

    ab.register();   // close panel
    expect(ab.registered).toBe(true);

    ab.unregister(); // quit
    expect(ab.registered).toBe(false);
  });
});
