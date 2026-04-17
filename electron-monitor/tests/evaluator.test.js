import { describe, it, expect } from 'vitest';

const {
  evaluateProject,
  applyTransition,
  shouldReevaluate,
  unmetCriteria,
} = require('../lib/evaluator');

const DAY_MS = 86400000;
const NOW = new Date('2026-04-18T12:00:00Z').getTime();

function daysAgo(n) { return NOW - n * DAY_MS; }

function projectWith({ active = true, template = 'MVP-lanzable', note, history = [], maintenanceSince = null }) {
  return {
    active,
    objective: template ? { template, note } : null,
    history,
    maintenanceSince,
  };
}

function analysisWith({ score = 5, checks = {} } = {}) {
  return { score, checks };
}

describe('evaluateProject — transitions', () => {
  it('returns in-progress when project has no objective', () => {
    const r = evaluateProject(projectWith({ template: null }), analysisWith(), { now: NOW });
    expect(r.transition).toBe('in-progress');
    expect(r.evaluation).toBeNull();
  });

  it('returns in-progress when criteria not met and was not in maintenance', () => {
    const p = projectWith({ template: 'MVP-lanzable' });
    const r = evaluateProject(p, analysisWith({ score: 3 }), { now: NOW });
    expect(r.transition).toBe('in-progress');
    expect(r.evaluation.met).toBe(false);
  });

  it('detects reached transition when goals become met the first time', () => {
    const p = projectWith({
      template: 'MVP-lanzable',
      history: [{ skill: 'add-tests', outcome: 'ok', at: daysAgo(1) }],
    });
    const r = evaluateProject(
      p,
      analysisWith({ score: 7, checks: { hasClaude: true, hasTests: true, gitClean: true } }),
      { now: NOW }
    );
    expect(r.evaluation.met).toBe(true);
    expect(r.transition).toBe('reached');
  });

  it('detects maintained transition when already in maintenance and still meets', () => {
    const p = projectWith({
      template: 'MVP-lanzable',
      maintenanceSince: daysAgo(3),
      history: [{ skill: 'add-tests', outcome: 'ok', at: daysAgo(1) }],
    });
    const r = evaluateProject(
      p,
      analysisWith({ score: 7, checks: { hasClaude: true, hasTests: true, gitClean: true } }),
      { now: NOW }
    );
    expect(r.transition).toBe('maintained');
    expect(r.daysSinceMaintenance).toBe(3);
  });

  it('detects regressed transition when previously met but now does not', () => {
    const p = projectWith({
      template: 'MVP-lanzable',
      maintenanceSince: daysAgo(5),
    });
    const r = evaluateProject(p, analysisWith({ score: 3 }), { now: NOW });
    expect(r.transition).toBe('regressed');
  });
});

describe('evaluateProject — needsReevaluation', () => {
  it('is true when in maintenance for >= 7 days', () => {
    const p = projectWith({
      template: 'MVP-lanzable',
      maintenanceSince: daysAgo(8),
      history: [{ skill: 'add-tests', outcome: 'ok', at: daysAgo(1) }],
    });
    const r = evaluateProject(
      p,
      analysisWith({ score: 7, checks: { hasClaude: true, hasTests: true, gitClean: true } }),
      { now: NOW }
    );
    expect(r.needsReevaluation).toBe(true);
  });

  it('is false for fresh maintenance', () => {
    const p = projectWith({
      template: 'MVP-lanzable',
      maintenanceSince: daysAgo(2),
      history: [{ skill: 'add-tests', outcome: 'ok', at: daysAgo(1) }],
    });
    const r = evaluateProject(
      p,
      analysisWith({ score: 7, checks: { hasClaude: true, hasTests: true, gitClean: true } }),
      { now: NOW }
    );
    expect(r.needsReevaluation).toBe(false);
  });

  it('respects custom reevalIntervalDays', () => {
    const p = projectWith({
      template: 'MVP-lanzable',
      maintenanceSince: daysAgo(4),
      history: [{ skill: 'add-tests', outcome: 'ok', at: daysAgo(1) }],
    });
    const r = evaluateProject(
      p,
      analysisWith({ score: 7, checks: { hasClaude: true, hasTests: true, gitClean: true } }),
      { now: NOW, reevalIntervalDays: 3 }
    );
    expect(r.needsReevaluation).toBe(true);
  });
});

describe('applyTransition', () => {
  it('sets maintenanceSince on reached', () => {
    const p = projectWith({ maintenanceSince: null });
    const out = applyTransition(p, 'reached', NOW);
    expect(out.maintenanceSince).toBe(NOW);
    expect(p.maintenanceSince).toBeNull(); // original not mutated
  });

  it('clears maintenanceSince on regressed', () => {
    const p = projectWith({ maintenanceSince: daysAgo(2) });
    const out = applyTransition(p, 'regressed', NOW);
    expect(out.maintenanceSince).toBeNull();
  });

  it('does not change state on maintained', () => {
    const since = daysAgo(3);
    const p = projectWith({ maintenanceSince: since });
    const out = applyTransition(p, 'maintained', NOW);
    expect(out.maintenanceSince).toBe(since);
  });

  it('does not change state on in-progress', () => {
    const p = projectWith({ maintenanceSince: null });
    const out = applyTransition(p, 'in-progress', NOW);
    expect(out.maintenanceSince).toBeNull();
  });

  it('returns a new object (does not mutate input)', () => {
    const p = projectWith({});
    const out = applyTransition(p, 'reached', NOW);
    expect(out).not.toBe(p);
  });
});

describe('shouldReevaluate', () => {
  it('returns true for a project not in maintenance', () => {
    const p = projectWith({ maintenanceSince: null });
    expect(shouldReevaluate(p, NOW)).toBe(true);
  });

  it('returns true when in maintenance for a long time', () => {
    const p = projectWith({ maintenanceSince: daysAgo(10) });
    expect(shouldReevaluate(p, NOW)).toBe(true);
  });

  it('returns false for fresh maintenance', () => {
    const p = projectWith({ maintenanceSince: daysAgo(3) });
    expect(shouldReevaluate(p, NOW)).toBe(false);
  });

  it('returns false for null input', () => {
    expect(shouldReevaluate(null, NOW)).toBe(false);
  });
});

describe('unmetCriteria', () => {
  it('returns empty for null / missing criteria', () => {
    expect(unmetCriteria(null)).toEqual([]);
    expect(unmetCriteria({})).toEqual([]);
  });

  it('returns only unmet criteria with id/label/detail', () => {
    const evalResult = {
      criteria: [
        { id: 'a', label: 'A', met: true, detail: 'OK' },
        { id: 'b', label: 'B', met: false, detail: 'Falta X' },
        { id: 'c', label: 'C', met: false, detail: 'Falta Y' },
      ],
    };
    const unmet = unmetCriteria(evalResult);
    expect(unmet).toHaveLength(2);
    expect(unmet.map(c => c.id)).toEqual(['b', 'c']);
    expect(unmet[0]).toEqual({ id: 'b', label: 'B', detail: 'Falta X' });
  });
});
