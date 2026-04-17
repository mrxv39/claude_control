import { describe, it, expect } from 'vitest';

const {
  pruneOld,
  recordExecution,
  isTripped,
  reset,
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW_MS,
} = require('../lib/circuit-breaker');

const HOUR = 3600000;
const NOW = new Date('2026-04-18T12:00:00Z').getTime();

function hoursAgo(n) { return NOW - n * HOUR; }

describe('pruneOld', () => {
  it('keeps entries within the window', () => {
    const failures = [
      { skill: 'a', at: hoursAgo(1) },
      { skill: 'b', at: hoursAgo(12) },
      { skill: 'c', at: hoursAgo(23) },
    ];
    const kept = pruneOld(failures, NOW);
    expect(kept).toHaveLength(3);
  });

  it('drops entries older than 24h', () => {
    const failures = [
      { skill: 'a', at: hoursAgo(1) },
      { skill: 'b', at: hoursAgo(25) },
      { skill: 'c', at: hoursAgo(48) },
    ];
    const kept = pruneOld(failures, NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0].skill).toBe('a');
  });

  it('drops malformed entries', () => {
    const failures = [
      null,
      { skill: 'a' },
      { skill: 'b', at: 'not-a-number' },
      { skill: 'c', at: hoursAgo(1) },
    ];
    const kept = pruneOld(failures, NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0].skill).toBe('c');
  });

  it('returns empty array for null/undefined', () => {
    expect(pruneOld(null, NOW)).toEqual([]);
    expect(pruneOld(undefined, NOW)).toEqual([]);
  });

  it('respects custom windowMs', () => {
    const failures = [
      { skill: 'a', at: hoursAgo(1) },
      { skill: 'b', at: hoursAgo(5) },
    ];
    const kept = pruneOld(failures, NOW, 3 * HOUR);
    expect(kept).toHaveLength(1);
  });
});

describe('recordExecution — success', () => {
  it('resets failures on success', () => {
    const current = [
      { skill: 'a', at: hoursAgo(2) },
      { skill: 'a', at: hoursAgo(1) },
    ];
    const r = recordExecution(current, { skill: 'a', outcome: 'ok', at: NOW });
    expect(r.failures).toEqual([]);
    expect(r.tripped).toBe(false);
  });
});

describe('recordExecution — failure', () => {
  it('appends a failure', () => {
    const r = recordExecution([], { skill: 'fix-types', outcome: 'fail', at: NOW }, { now: NOW });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toBe('fail');
    expect(r.tripped).toBe(false);
  });

  it('trips at threshold (3 failures)', () => {
    let failures = [];
    for (let i = 0; i < 3; i++) {
      const r = recordExecution(failures, { skill: 'a', outcome: 'fail', at: NOW - i * 100 }, { now: NOW });
      failures = r.failures;
      if (i === 2) {
        expect(r.tripped).toBe(true);
        expect(r.reason).toMatch(/3 fallos/);
      } else {
        expect(r.tripped).toBe(false);
      }
    }
  });

  it('does not trip if older failures fall outside window', () => {
    const old = [
      { skill: 'a', at: hoursAgo(30) },
      { skill: 'a', at: hoursAgo(28) },
    ];
    const r = recordExecution(old, { skill: 'a', outcome: 'fail', at: NOW }, { now: NOW });
    expect(r.failures).toHaveLength(1);
    expect(r.tripped).toBe(false);
  });

  it('treats timeout as failure', () => {
    const r = recordExecution(
      [],
      { skill: 'a', outcome: 'ok', at: NOW, durationMs: 20 * 60 * 1000 },
      { now: NOW }
    );
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toBe('timeout');
  });

  it('does not treat short duration as timeout', () => {
    const r = recordExecution(
      [],
      { skill: 'a', outcome: 'ok', at: NOW, durationMs: 60 * 1000 },
      { now: NOW }
    );
    expect(r.failures).toHaveLength(0);
  });

  it('respects custom threshold', () => {
    const r = recordExecution(
      [{ skill: 'a', at: hoursAgo(1) }],
      { skill: 'a', outcome: 'fail', at: NOW },
      { now: NOW, threshold: 2 }
    );
    expect(r.tripped).toBe(true);
  });

  it('respects custom skillTimeoutMs', () => {
    const r = recordExecution(
      [],
      { skill: 'a', outcome: 'ok', at: NOW, durationMs: 10 * 60 * 1000 },
      { now: NOW, skillTimeoutMs: 5 * 60 * 1000 }
    );
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toBe('timeout');
  });

  it('handles empty execution gracefully', () => {
    const r = recordExecution([{ skill: 'a', at: hoursAgo(1) }], null, { now: NOW });
    expect(r.failures).toHaveLength(1);
    expect(r.tripped).toBe(false);
  });
});

describe('isTripped', () => {
  it('returns true when failures in window reach threshold', () => {
    const failures = [
      { skill: 'a', at: hoursAgo(1) },
      { skill: 'a', at: hoursAgo(5) },
      { skill: 'a', at: hoursAgo(10) },
    ];
    expect(isTripped(failures, { now: NOW })).toBe(true);
  });

  it('returns false when some failures are outside window', () => {
    const failures = [
      { skill: 'a', at: hoursAgo(1) },
      { skill: 'a', at: hoursAgo(25) },
      { skill: 'a', at: hoursAgo(48) },
    ];
    expect(isTripped(failures, { now: NOW })).toBe(false);
  });

  it('returns false for empty failures', () => {
    expect(isTripped([], { now: NOW })).toBe(false);
    expect(isTripped(null, { now: NOW })).toBe(false);
  });
});

describe('reset', () => {
  it('returns empty array', () => {
    expect(reset()).toEqual([]);
  });
});

describe('defaults exported', () => {
  it('exposes sensible defaults', () => {
    expect(DEFAULT_THRESHOLD).toBe(3);
    expect(DEFAULT_WINDOW_MS).toBe(24 * HOUR);
  });
});
