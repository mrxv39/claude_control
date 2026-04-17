import { describe, it, expect } from 'vitest';

const {
  cycleWindow,
  computeAverage,
  classifyCycle,
  eventsInCycle,
  probableCause,
  rankCycles,
  bucketByDay,
  summarize,
} = require('../lib/token-report');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 86400 * 1000;
const NOW = new Date('2026-04-18T12:00:00Z').getTime();

// Helpers para construir entries (resetsAt en Unix seconds)
function entry(resetsAtDate, pct, overrides = {}) {
  return {
    resetsAt: Math.floor(new Date(resetsAtDate).getTime() / 1000),
    capturedAt: new Date(resetsAtDate).toISOString(),
    fiveHourPercent: pct,
    sevenDayPercent: 50,
    costUsd: 1.50,
    model: 'sonnet',
    ...overrides,
  };
}

function event(atDate, type, extra = {}) {
  return { type, at: new Date(atDate).getTime(), ...extra };
}

// ---- cycleWindow ----

describe('cycleWindow', () => {
  it('computes 5h before resetsAt', () => {
    const e = entry('2026-04-18T10:00:00Z', 80);
    const w = cycleWindow(e.resetsAt);
    expect(w.endMs).toBe(new Date('2026-04-18T10:00:00Z').getTime());
    expect(w.startMs).toBe(new Date('2026-04-18T05:00:00Z').getTime());
  });
});

// ---- computeAverage ----

describe('computeAverage', () => {
  it('returns no-data on empty input', () => {
    const r = computeAverage([], { now: NOW });
    expect(r.status).toBe('no-data');
    expect(r.avg).toBe(0);
    expect(r.count).toBe(0);
  });

  it('computes rolling average within window', () => {
    const entries = [
      entry('2026-04-18T10:00:00Z', 80),
      entry('2026-04-18T05:00:00Z', 90),
      entry('2026-04-17T20:00:00Z', 70),
    ];
    const r = computeAverage(entries, { now: NOW, windowDays: 7 });
    expect(r.avg).toBe(80);
    expect(r.count).toBe(3);
    expect(r.status).toBe('ok');
  });

  it('excludes entries outside window', () => {
    const entries = [
      entry('2026-04-18T10:00:00Z', 80),
      entry('2026-03-01T10:00:00Z', 50), // fuera de 7d
    ];
    const r = computeAverage(entries, { now: NOW, windowDays: 7 });
    expect(r.count).toBe(1);
    expect(r.avg).toBe(80);
  });

  it('respects custom windowDays', () => {
    const entries = [
      entry('2026-04-18T10:00:00Z', 90),
      entry('2026-04-15T10:00:00Z', 70),
      entry('2026-04-10T10:00:00Z', 50),
    ];
    const short = computeAverage(entries, { now: NOW, windowDays: 4 });
    const long = computeAverage(entries, { now: NOW, windowDays: 30 });
    expect(short.count).toBe(2); // 18 y 15
    expect(long.count).toBe(3);
  });

  it('handles null/malformed entries', () => {
    const entries = [null, { noResetsAt: true }, entry('2026-04-18T10:00:00Z', 80)];
    const r = computeAverage(entries, { now: NOW });
    expect(r.count).toBe(1);
  });
});

// ---- classifyCycle ----

describe('classifyCycle', () => {
  it('optimal when above target', () => {
    expect(classifyCycle({ fiveHourPercent: 95 })).toBe('optimal');
    expect(classifyCycle({ fiveHourPercent: 90 })).toBe('optimal');
  });

  it('acceptable when between 70 and target', () => {
    expect(classifyCycle({ fiveHourPercent: 85 })).toBe('acceptable');
    expect(classifyCycle({ fiveHourPercent: 70 })).toBe('acceptable');
  });

  it('poor when below 70', () => {
    expect(classifyCycle({ fiveHourPercent: 60 })).toBe('poor');
    expect(classifyCycle({ fiveHourPercent: 0 })).toBe('poor');
  });

  it('respects custom target', () => {
    expect(classifyCycle({ fiveHourPercent: 85 }, 80)).toBe('optimal');
  });

  it('handles missing percent safely', () => {
    expect(classifyCycle({})).toBe('poor');
    expect(classifyCycle(null)).toBe('poor');
  });
});

// ---- eventsInCycle ----

describe('eventsInCycle', () => {
  const e = entry('2026-04-18T10:00:00Z', 70); // cycle: 5:00 - 10:00 UTC

  it('includes events within cycle bounds', () => {
    const events = [
      event('2026-04-18T06:00:00Z', 'skill-executed'),
      event('2026-04-18T09:30:00Z', 'planner-decision'),
    ];
    expect(eventsInCycle(events, e)).toHaveLength(2);
  });

  it('excludes events outside bounds', () => {
    const events = [
      event('2026-04-18T04:00:00Z', 'skill-executed'), // antes
      event('2026-04-18T11:00:00Z', 'skill-executed'), // después
    ];
    expect(eventsInCycle(events, e)).toHaveLength(0);
  });

  it('includes events exactly at boundary', () => {
    const events = [
      event('2026-04-18T05:00:00Z', 'a'),
      event('2026-04-18T10:00:00Z', 'b'),
    ];
    expect(eventsInCycle(events, e)).toHaveLength(2);
  });

  it('handles empty/null inputs', () => {
    expect(eventsInCycle([], e)).toEqual([]);
    expect(eventsInCycle(null, e)).toEqual([]);
    expect(eventsInCycle([event('2026-04-18T06:00:00Z', 'a')], null)).toEqual([]);
  });
});

// ---- probableCause ----

describe('probableCause', () => {
  const poor = entry('2026-04-18T10:00:00Z', 40);
  const optimal = entry('2026-04-18T10:00:00Z', 95);

  it('returns null for optimal cycles', () => {
    expect(probableCause(optimal, [])).toBeNull();
  });

  it('detects no-active-projects', () => {
    const events = Array(5).fill(0).map((_, i) =>
      event(`2026-04-18T0${6 + i}:00:00Z`, 'tick-skip', { reason: 'no-active-projects' })
    );
    const c = probableCause(poor, events);
    expect(c.category).toBe('no-active-projects');
  });

  it('detects all-maintenance', () => {
    const events = Array(4).fill(0).map((_, i) =>
      event(`2026-04-18T0${6 + i}:00:00Z`, 'tick-skip', { reason: 'all-in-maintenance' })
    );
    const c = probableCause(poor, events);
    expect(c.category).toBe('all-maintenance');
  });

  it('detects circuit-breaker-trips', () => {
    const events = [
      event('2026-04-18T06:00:00Z', 'circuit-breaker-trip', { project: 'x' }),
    ];
    const c = probableCause(poor, events);
    expect(c.category).toBe('circuit-breaker-trips');
  });

  it('detects planner-blocked when many no_op', () => {
    const events = Array(6).fill(0).map((_, i) =>
      event(`2026-04-18T0${6 + i}:00:00Z`, 'planner-decision', { decision: 'no_op' })
    );
    const c = probableCause(poor, events);
    expect(c.category).toBe('planner-blocked');
  });

  it('detects low-throughput', () => {
    const events = [
      event('2026-04-18T06:00:00Z', 'skill-executed'),
      event('2026-04-18T08:00:00Z', 'skill-executed'),
    ];
    const c = probableCause(poor, events);
    expect(c.category).toBe('low-throughput');
  });

  it('returns no-telemetry if empty events', () => {
    const c = probableCause(poor, []);
    expect(c.category).toBe('no-telemetry');
  });

  it('returns no-executions when events exist but no skills ran', () => {
    const events = [event('2026-04-18T06:00:00Z', 'planner-decision', { decision: 'no_op' })];
    const c = probableCause(poor, events);
    expect(c.category).toBe('no-executions');
  });
});

// ---- rankCycles ----

describe('rankCycles', () => {
  it('sorts ascending by percent (worst first)', () => {
    const entries = [
      entry('2026-04-18T10:00:00Z', 90),
      entry('2026-04-17T10:00:00Z', 40),
      entry('2026-04-16T10:00:00Z', 70),
    ];
    const r = rankCycles(entries, []);
    expect(r.map(x => x.entry.fiveHourPercent)).toEqual([40, 70, 90]);
  });

  it('respects limit option', () => {
    const entries = [
      entry('2026-04-18T10:00:00Z', 90),
      entry('2026-04-17T10:00:00Z', 40),
      entry('2026-04-16T10:00:00Z', 70),
    ];
    expect(rankCycles(entries, [], { limit: 2 })).toHaveLength(2);
  });

  it('enriches with classification and cause', () => {
    const entries = [entry('2026-04-18T10:00:00Z', 40)];
    const events = [event('2026-04-18T06:00:00Z', 'tick-skip', { reason: 'no-active-projects' })];
    const r = rankCycles(entries, events);
    expect(r[0].classification).toBe('poor');
    expect(r[0].cause.category).toBe('no-active-projects');
  });

  it('handles empty/null input', () => {
    expect(rankCycles(null, null)).toEqual([]);
    expect(rankCycles([], [])).toEqual([]);
  });
});

// ---- bucketByDay ----

describe('bucketByDay', () => {
  it('groups entries by day with per-day average', () => {
    const entries = [
      entry('2026-04-18T10:00:00Z', 80),
      entry('2026-04-18T05:00:00Z', 90),
      entry('2026-04-17T10:00:00Z', 60),
    ];
    const out = bucketByDay(entries);
    expect(out).toHaveLength(2);
    const d18 = out.find(b => b.day === '2026-04-18');
    expect(d18.avg).toBe(85);
    expect(d18.cycles).toHaveLength(2);
  });

  it('sorts by day ascending', () => {
    const entries = [
      entry('2026-04-18T10:00:00Z', 80),
      entry('2026-04-15T10:00:00Z', 60),
      entry('2026-04-17T10:00:00Z', 70),
    ];
    const out = bucketByDay(entries);
    expect(out.map(b => b.day)).toEqual(['2026-04-15', '2026-04-17', '2026-04-18']);
  });

  it('handles null input', () => {
    expect(bucketByDay(null)).toEqual([]);
    expect(bucketByDay([])).toEqual([]);
  });
});

// ---- summarize ----

describe('summarize', () => {
  it('produces a full rollup', () => {
    const entries = [
      entry('2026-04-18T10:00:00Z', 95),
      entry('2026-04-18T05:00:00Z', 80),
      entry('2026-04-17T10:00:00Z', 50, { costUsd: 0.40 }),
    ];
    const s = summarize(entries, { now: NOW });
    expect(s.avg).toBe(75);
    expect(s.totalCycles).toBe(3);
    expect(s.counts.optimal).toBe(1);
    expect(s.counts.acceptable).toBe(1);
    expect(s.counts.poor).toBe(1);
    expect(s.target).toBe(90);
    expect(s.costUsd).toBeCloseTo(3.4, 1);
  });

  it('returns no-data status when empty', () => {
    const s = summarize([], { now: NOW });
    expect(s.avgStatus).toBe('no-data');
    expect(s.totalCycles).toBe(0);
  });
});
