import { describe, it, expect } from 'vitest';

const {
  aggregateEvents,
  plainDigest,
  buildDigestPrompt,
  cleanDigestText,
  generateDigest,
} = require('../lib/digest');

const NOW = new Date('2026-04-18T12:00:00Z').getTime();
const HOUR_MS = 3600 * 1000;

function ev(type, hoursAgo, extra = {}) {
  return { type, at: NOW - hoursAgo * HOUR_MS, ...extra };
}

// ---- aggregateEvents ----

describe('aggregateEvents', () => {
  it('aggregates runs by skill and project', () => {
    const events = [
      ev('skill-executed', 1, { skill: 'audit-claude-md', project: 'a', outcome: 'ok' }),
      ev('skill-executed', 2, { skill: 'audit-claude-md', project: 'b', outcome: 'ok' }),
      ev('skill-executed', 3, { skill: 'add-tests', project: 'a', outcome: 'fail' }),
    ];
    const agg = aggregateEvents(events, { until: NOW });
    expect(agg.totals).toEqual({ totalRuns: 3, successful: 2, failed: 1 });
    expect(agg.bySkill['audit-claude-md']).toEqual({ ok: 2, fail: 0 });
    expect(agg.bySkill['add-tests']).toEqual({ ok: 0, fail: 1 });
    expect(agg.byProject['a']).toEqual({ runs: 2, ok: 1, fail: 1 });
  });

  it('filters by window', () => {
    const events = [
      ev('skill-executed', 1, { skill: 's', project: 'a', outcome: 'ok' }),
      ev('skill-executed', 25, { skill: 's', project: 'b', outcome: 'ok' }),
    ];
    const agg = aggregateEvents(events, { until: NOW });
    expect(agg.totals.totalRuns).toBe(1);
  });

  it('captures transitions separately', () => {
    const events = [
      ev('goal-reached', 1, { project: 'a', template: 'MVP-lanzable' }),
      ev('goal-regressed', 2, { project: 'b', template: 'production-ready' }),
    ];
    const agg = aggregateEvents(events, { until: NOW });
    expect(agg.transitions).toHaveLength(2);
    expect(agg.transitions[0].project).toBe('a');
  });

  it('captures trips separately', () => {
    const events = [
      ev('circuit-breaker-trip', 1, { project: 'a', reason: '3 fails' }),
    ];
    const agg = aggregateEvents(events, { until: NOW });
    expect(agg.trips).toHaveLength(1);
    expect(agg.trips[0].project).toBe('a');
  });

  it('captures errors separately', () => {
    const events = [
      ev('tick-error', 1, { error: 'boom' }),
      ev('analyze-error', 2, { error: 'fs' }),
    ];
    const agg = aggregateEvents(events, { until: NOW });
    expect(agg.errors).toHaveLength(2);
  });

  it('handles empty input', () => {
    const agg = aggregateEvents([]);
    expect(agg.totals.totalRuns).toBe(0);
    expect(agg.bySkill).toEqual({});
  });
});

// ---- plainDigest ----

describe('plainDigest', () => {
  it('returns no-activity message for empty', () => {
    const agg = aggregateEvents([]);
    const text = plainDigest(agg);
    expect(text).toMatch(/Sin actividad/);
  });

  it('summarizes counts and top skills', () => {
    const events = [
      ev('skill-executed', 1, { skill: 'a', project: 'x', outcome: 'ok' }),
      ev('skill-executed', 2, { skill: 'a', project: 'y', outcome: 'ok' }),
      ev('skill-executed', 3, { skill: 'b', project: 'x', outcome: 'fail' }),
    ];
    const agg = aggregateEvents(events, { until: NOW });
    const text = plainDigest(agg);
    expect(text).toMatch(/3 skills ejecutados/);
    expect(text).toMatch(/2 OK/);
    expect(text).toMatch(/1 FAIL/);
    expect(text).toMatch(/Skills más activos/);
  });

  it('mentions transitions and trips', () => {
    const events = [
      ev('goal-reached', 1, { project: 'x' }),
      ev('circuit-breaker-trip', 2, { project: 'y' }),
    ];
    const agg = aggregateEvents(events, { until: NOW });
    const text = plainDigest(agg);
    expect(text).toMatch(/cumplió objetivo/);
    expect(text).toMatch(/Circuit breaker/);
    expect(text).toMatch(/y/);
  });

  it('includes AVG metric when provided', () => {
    const agg = aggregateEvents([], { until: NOW });
    // plainDigest returns no-activity text for empty, which includes AVG only if
    // there's activity. Construct an agg with activity to check AVG formatting.
    const active = aggregateEvents(
      [ev('skill-executed', 1, { skill: 's', project: 'a', outcome: 'ok' })],
      { until: NOW }
    );
    const text = plainDigest(active, { avgPct: 75, targetPct: 90 });
    expect(text).toMatch(/AVG uso 75%/);
    expect(text).toMatch(/⚠/);
  });

  it('marks AVG as OK when ≥ target', () => {
    const events = [ev('skill-executed', 1, { skill: 's', project: 'a', outcome: 'ok' })];
    const agg = aggregateEvents(events, { until: NOW });
    const text = plainDigest(agg, { avgPct: 92 });
    expect(text).toMatch(/✓/);
  });
});

// ---- buildDigestPrompt ----

describe('buildDigestPrompt', () => {
  it('includes window, runs, skills, projects', () => {
    const events = [
      ev('skill-executed', 1, { skill: 's1', project: 'p1', outcome: 'ok' }),
    ];
    const agg = aggregateEvents(events, { until: NOW });
    const prompt = buildDigestPrompt(agg, { avgPct: 85 });
    expect(prompt).toContain('total_runs');
    expect(prompt).toContain('s1');
    expect(prompt).toContain('p1');
    expect(prompt).toContain('85');
  });

  it('asks for concise prose, no markdown', () => {
    const agg = aggregateEvents([]);
    const prompt = buildDigestPrompt(agg);
    expect(prompt).toMatch(/NO uses markdown/);
    expect(prompt).toMatch(/NO uses listas/);
  });
});

// ---- cleanDigestText ----

describe('cleanDigestText', () => {
  it('strips markdown fences', () => {
    expect(cleanDigestText('```\nresumen\n```')).toBe('resumen');
  });

  it('keeps first paragraph only', () => {
    expect(cleanDigestText('primer parrafo\n\nsegundo parrafo')).toBe('primer parrafo');
  });

  it('handles empty/non-string', () => {
    expect(cleanDigestText('')).toBe('');
    expect(cleanDigestText(null)).toBe('');
  });

  it('returns plain text as-is', () => {
    expect(cleanDigestText('hello world')).toBe('hello world');
  });
});

// ---- generateDigest (DI) ----

describe('generateDigest', () => {
  it('returns plain digest when no activity and useLLM default', async () => {
    const r = await generateDigest([], { until: NOW });
    expect(r.source).toBe('plain');
    expect(r.text).toMatch(/Sin actividad/);
  });

  it('calls LLM when activity present', async () => {
    let calls = 0;
    const invoke = async () => { calls++; return 'Últimas 24h: 1 skill ejecutado con éxito.'; };
    const events = [ev('skill-executed', 1, { skill: 's', project: 'a', outcome: 'ok' })];
    const r = await generateDigest(events, { until: NOW, invoke });
    expect(calls).toBe(1);
    expect(r.source).toBe('llm');
    expect(r.text).toMatch(/1 skill/);
  });

  it('falls back to plain digest when LLM throws', async () => {
    const events = [ev('skill-executed', 1, { skill: 's', project: 'a', outcome: 'ok' })];
    const r = await generateDigest(events, { until: NOW, invoke: async () => { throw new Error('x'); } });
    expect(r.source).toBe('plain');
  });

  it('falls back to plain when LLM returns empty', async () => {
    const events = [ev('skill-executed', 1, { skill: 's', project: 'a', outcome: 'ok' })];
    const r = await generateDigest(events, { until: NOW, invoke: async () => '' });
    expect(r.source).toBe('plain');
  });

  it('useLLM=false forces plain even with activity', async () => {
    let calls = 0;
    const invoke = async () => { calls++; return 'llm text'; };
    const events = [ev('skill-executed', 1, { skill: 's', project: 'a', outcome: 'ok' })];
    const r = await generateDigest(events, { until: NOW, invoke, useLLM: false });
    expect(calls).toBe(0);
    expect(r.source).toBe('plain');
  });
});
