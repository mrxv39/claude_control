import { describe, it, expect } from 'vitest';

/**
 * Tests for notifications.js status-change detection logic.
 *
 * checkStatusChanges() uses three Maps to track transitions:
 *   - prevStatus: last seen status per cwd
 *   - waitingSince: what status the WAITING streak started from
 *   - waitingCount: consecutive WAITING polls (debounce)
 *
 * A toast fires only when: BUSY -> 3 consecutive WAITING polls.
 * We reimplement the logic here to test it without Electron/BrowserWindow deps.
 */

// Reimplement checkStatusChanges logic (mirrors notifications.js)
function createStatusTracker() {
  const prevStatus = new Map();
  const waitingSince = new Map();
  const waitingCount = new Map();
  const toasts = [];

  function checkStatusChanges(sessions) {
    const liveCwds = new Set(sessions.filter(s => s.isClaude && s.cwd).map(s => s.cwd));
    for (const cwd of prevStatus.keys()) {
      if (!liveCwds.has(cwd)) {
        prevStatus.delete(cwd);
        waitingSince.delete(cwd);
        waitingCount.delete(cwd);
      }
    }

    for (const s of sessions) {
      if (!s.isClaude || !s.cwd) continue;
      const prev = prevStatus.get(s.cwd);
      prevStatus.set(s.cwd, s.status);
      if (s.status === 'WAITING') {
        const count = (waitingCount.get(s.cwd) || 0) + 1;
        waitingCount.set(s.cwd, count);
        if (count === 1) waitingSince.set(s.cwd, prev);
        if (waitingSince.get(s.cwd) === 'BUSY' && count === 3) {
          toasts.push({ project: s.project, hwnd: s.hwnd });
        }
      } else {
        waitingCount.set(s.cwd, 0);
        waitingSince.delete(s.cwd);
      }
    }
  }

  return {
    checkStatusChanges,
    getToasts: () => [...toasts],
    clearToasts: () => { toasts.length = 0; },
    _prevStatus: prevStatus,
    _waitingCount: waitingCount,
    _waitingSince: waitingSince,
  };
}

function mkSession(cwd, status, opts = {}) {
  return { isClaude: true, cwd, status, project: opts.project || cwd, hwnd: opts.hwnd || 123, ...opts };
}

describe('checkStatusChanges — debounce logic', () => {
  it('does not toast on first WAITING poll', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([mkSession('/a', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    expect(t.getToasts()).toHaveLength(0);
  });

  it('does not toast on second WAITING poll', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([mkSession('/a', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    expect(t.getToasts()).toHaveLength(0);
  });

  it('toasts after 3 consecutive WAITING polls from BUSY', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([mkSession('/a', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    expect(t.getToasts()).toHaveLength(1);
    expect(t.getToasts()[0].project).toBe('/a');
  });

  it('does not toast if WAITING streak started from IDLE (not BUSY)', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([mkSession('/a', 'IDLE')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    expect(t.getToasts()).toHaveLength(0);
  });

  it('does not toast if WAITING streak starts without prior status', () => {
    const t = createStatusTracker();
    // First time seeing this session, and it's already WAITING
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    expect(t.getToasts()).toHaveLength(0);
  });

  it('resets debounce counter if BUSY interrupts WAITING streak', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([mkSession('/a', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    // Interruption — back to BUSY
    t.checkStatusChanges([mkSession('/a', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    // Should toast now (fresh 3-poll streak from BUSY)
    expect(t.getToasts()).toHaveLength(1);
  });

  it('only toasts once per BUSY->WAITING transition (4th poll does not re-toast)', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([mkSession('/a', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]); // toast
    t.checkStatusChanges([mkSession('/a', 'WAITING')]); // 4th poll — no new toast
    expect(t.getToasts()).toHaveLength(1);
  });

  it('tracks multiple sessions independently', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([mkSession('/a', 'BUSY'), mkSession('/b', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING'), mkSession('/b', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING'), mkSession('/b', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING'), mkSession('/b', 'WAITING')]);
    // /a has 3 WAITING from BUSY → toast. /b only has 2 WAITING.
    expect(t.getToasts()).toHaveLength(1);
    expect(t.getToasts()[0].project).toBe('/a');

    t.checkStatusChanges([mkSession('/a', 'WAITING'), mkSession('/b', 'WAITING')]);
    // /b now has 3 WAITING from BUSY → toast
    expect(t.getToasts()).toHaveLength(2);
    expect(t.getToasts()[1].project).toBe('/b');
  });
});

describe('checkStatusChanges — session pruning', () => {
  it('prunes state for dead sessions (session disappears)', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([mkSession('/a', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    // Session /a disappears
    t.checkStatusChanges([]);
    expect(t._prevStatus.size).toBe(0);
    expect(t._waitingCount.size).toBe(0);
    expect(t._waitingSince.size).toBe(0);
  });

  it('ignores non-Claude sessions', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([{ isClaude: false, cwd: '/a', status: 'BUSY' }]);
    expect(t._prevStatus.size).toBe(0);
  });

  it('ignores sessions without cwd', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([{ isClaude: true, cwd: null, status: 'BUSY' }]);
    expect(t._prevStatus.size).toBe(0);
  });
});

describe('checkStatusChanges — edge cases', () => {
  it('handles rapid BUSY->WAITING->BUSY->WAITING cycle', () => {
    const t = createStatusTracker();
    // Rapid cycling — should never reach 3 consecutive
    for (let i = 0; i < 10; i++) {
      t.checkStatusChanges([mkSession('/a', 'BUSY')]);
      t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    }
    expect(t.getToasts()).toHaveLength(0);
  });

  it('handles IDLE -> BUSY -> 3xWAITING (toast expected)', () => {
    const t = createStatusTracker();
    t.checkStatusChanges([mkSession('/a', 'IDLE')]);
    t.checkStatusChanges([mkSession('/a', 'BUSY')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    t.checkStatusChanges([mkSession('/a', 'WAITING')]);
    expect(t.getToasts()).toHaveLength(1);
  });
});
