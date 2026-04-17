import { describe, it, expect } from 'vitest';

const {
  listTemplates,
  getTemplate,
  isValidTemplate,
  evaluate,
  preferredSkills,
  plannerModelFor,
} = require('../lib/goals');

const DAY_MS = 86400000;
const NOW = new Date('2026-04-18T12:00:00Z').getTime();

function state({ checks = {}, score = 5, history = [] } = {}) {
  return {
    analysis: { checks, score },
    history,
    now: NOW,
  };
}

function daysAgo(n) {
  return NOW - n * DAY_MS;
}

describe('goals.listTemplates', () => {
  it('returns all templates with metadata', () => {
    const list = listTemplates();
    const names = list.map(t => t.name).sort();
    expect(names).toEqual([
      'MVP-lanzable',
      'explorar-idea',
      'mantenimiento',
      'production-ready',
      'seguro-y-testeado',
    ]);
    for (const t of list) {
      expect(t).toHaveProperty('label');
      expect(t).toHaveProperty('description');
      expect(t).toHaveProperty('criteriaCount');
      expect(t.criteriaCount).toBeGreaterThan(0);
      expect(['haiku', 'sonnet', 'opus']).toContain(t.plannerModel);
    }
  });
});

describe('goals.getTemplate / isValidTemplate', () => {
  it('returns template object for valid name', () => {
    const t = getTemplate('production-ready');
    expect(t).not.toBeNull();
    expect(t.name).toBe('production-ready');
    expect(Array.isArray(t.criteria)).toBe(true);
    expect(Array.isArray(t.skills)).toBe(true);
  });

  it('returns null for unknown name', () => {
    expect(getTemplate('does-not-exist')).toBeNull();
  });

  it('isValidTemplate matches valid names', () => {
    expect(isValidTemplate('production-ready')).toBe(true);
    expect(isValidTemplate('mantenimiento')).toBe(true);
    expect(isValidTemplate('nope')).toBe(false);
  });
});

describe('goals.evaluate — production-ready', () => {
  it('throws on unknown template', () => {
    expect(() => evaluate('nope', state())).toThrow(/Unknown template/);
  });

  it('returns all criteria unmet for empty project', () => {
    const r = evaluate('production-ready', state());
    expect(r.met).toBe(false);
    expect(r.satisfied).toBe(0);
    expect(r.total).toBeGreaterThan(0);
  });

  it('marks score-min met when score is high enough', () => {
    const r = evaluate('production-ready', state({ score: 9, checks: { hasClaude: true } }));
    const scoreCriterion = r.criteria.find(c => c.id === 'score-min-8');
    expect(scoreCriterion.met).toBe(true);
    expect(scoreCriterion.detail).toMatch(/9\/10/);
  });

  it('marks score-min unmet when score too low', () => {
    const r = evaluate('production-ready', state({ score: 7 }));
    const scoreCriterion = r.criteria.find(c => c.id === 'score-min-8');
    expect(scoreCriterion.met).toBe(false);
  });

  it('security-audit-30d met when security-review ran 10 days ago', () => {
    const r = evaluate('production-ready', state({
      history: [{ skill: 'security-review', outcome: 'ok', at: daysAgo(10) }],
    }));
    const sec = r.criteria.find(c => c.id === 'security-audit-30d');
    expect(sec.met).toBe(true);
    expect(sec.detail).toMatch(/10d/);
  });

  it('security-audit-30d unmet when audit was 45 days ago', () => {
    const r = evaluate('production-ready', state({
      history: [{ skill: 'security-review', outcome: 'ok', at: daysAgo(45) }],
    }));
    const sec = r.criteria.find(c => c.id === 'security-audit-30d');
    expect(sec.met).toBe(false);
    expect(sec.detail).toMatch(/>30d/);
  });

  it('security-audit ignores failed runs', () => {
    const r = evaluate('production-ready', state({
      history: [{ skill: 'security-review', outcome: 'fail', at: daysAgo(5) }],
    }));
    const sec = r.criteria.find(c => c.id === 'security-audit-30d');
    expect(sec.met).toBe(false);
  });

  it('picks latest successful run when multiple exist', () => {
    const r = evaluate('production-ready', state({
      history: [
        { skill: 'security-review', outcome: 'ok', at: daysAgo(100) },
        { skill: 'security-review', outcome: 'ok', at: daysAgo(5) },
        { skill: 'security-review', outcome: 'fail', at: daysAgo(1) },
      ],
    }));
    const sec = r.criteria.find(c => c.id === 'security-audit-30d');
    expect(sec.met).toBe(true);
  });

  it('full production-ready met when all criteria satisfied', () => {
    const r = evaluate('production-ready', state({
      score: 9,
      checks: { hasClaude: true, hasTests: true, depsOk: true },
      history: [
        { skill: 'audit-claude-md', outcome: 'ok', at: daysAgo(5) },
        { skill: 'security-review', outcome: 'ok', at: daysAgo(10) },
        { skill: 'add-tests', outcome: 'ok', at: daysAgo(8) },
        { skill: 'add-tests', outcome: 'ok', at: daysAgo(3) },
      ],
    }));
    expect(r.met).toBe(true);
    expect(r.satisfied).toBe(r.total);
  });
});

describe('goals.evaluate — mantenimiento', () => {
  it('requires dep-update within 14 days', () => {
    const fresh = evaluate('mantenimiento', state({
      history: [{ skill: 'dep-update', outcome: 'ok', at: daysAgo(7) }],
    }));
    const stale = evaluate('mantenimiento', state({
      history: [{ skill: 'dep-update', outcome: 'ok', at: daysAgo(20) }],
    }));
    expect(fresh.criteria.find(c => c.id === 'deps-up-to-date-14d').met).toBe(true);
    expect(stale.criteria.find(c => c.id === 'deps-up-to-date-14d').met).toBe(false);
  });

  it('requires score >=7', () => {
    const r = evaluate('mantenimiento', state({ score: 7, checks: { hasClaude: true, gitClean: true } }));
    expect(r.criteria.find(c => c.id === 'score-min-7').met).toBe(true);
  });

  it('git-clean unmet when dirty', () => {
    const r = evaluate('mantenimiento', state({ checks: { gitClean: false } }));
    expect(r.criteria.find(c => c.id === 'git-clean').met).toBe(false);
  });

  it('git-clean unmet when indeterminate (null)', () => {
    const r = evaluate('mantenimiento', state({ checks: { gitClean: null } }));
    expect(r.criteria.find(c => c.id === 'git-clean').met).toBe(false);
  });
});

describe('goals.evaluate — MVP-lanzable', () => {
  it('tests-happy-path met when add-tests succeeded once', () => {
    const r = evaluate('MVP-lanzable', state({
      checks: { hasTests: true },
      history: [{ skill: 'add-tests', outcome: 'ok', at: daysAgo(2) }],
    }));
    expect(r.criteria.find(c => c.id === 'tests-happy-path').met).toBe(true);
  });

  it('tests-happy-path unmet without hasTests dir', () => {
    const r = evaluate('MVP-lanzable', state({
      history: [{ skill: 'add-tests', outcome: 'ok', at: daysAgo(2) }],
    }));
    expect(r.criteria.find(c => c.id === 'tests-happy-path').met).toBe(false);
  });

  it('score-min-6 threshold', () => {
    expect(evaluate('MVP-lanzable', state({ score: 6 })).criteria.find(c => c.id === 'score-min-6').met).toBe(true);
    expect(evaluate('MVP-lanzable', state({ score: 5 })).criteria.find(c => c.id === 'score-min-6').met).toBe(false);
  });
});

describe('goals.evaluate — explorar-idea', () => {
  it('requires just CLAUDE.md + recent activity', () => {
    const r = evaluate('explorar-idea', state({
      checks: { hasClaude: true, lastCommitDays: 3 },
    }));
    expect(r.met).toBe(true);
  });

  it('stale activity (>14d) fails recent-activity', () => {
    const r = evaluate('explorar-idea', state({
      checks: { hasClaude: true, lastCommitDays: 30 },
    }));
    expect(r.met).toBe(false);
  });
});

describe('goals.evaluate — seguro-y-testeado', () => {
  it('tests-coverage-80-entry requires 3+ add-tests successful runs', () => {
    const less = evaluate('seguro-y-testeado', state({
      checks: { hasTests: true },
      history: Array(2).fill(0).map((_, i) => ({ skill: 'add-tests', outcome: 'ok', at: daysAgo(i + 1) })),
    }));
    const enough = evaluate('seguro-y-testeado', state({
      checks: { hasTests: true },
      history: Array(3).fill(0).map((_, i) => ({ skill: 'add-tests', outcome: 'ok', at: daysAgo(i + 1) })),
    }));
    expect(less.criteria.find(c => c.id === 'tests-coverage-80-entry').met).toBe(false);
    expect(enough.criteria.find(c => c.id === 'tests-coverage-80-entry').met).toBe(true);
  });
});

describe('goals.preferredSkills', () => {
  it('returns skills array for valid template', () => {
    const skills = preferredSkills('production-ready');
    expect(skills).toContain('security-review');
    expect(skills).toContain('add-tests');
    expect(skills[0]).toBe('audit-claude-md'); // first = highest priority
  });

  it('returns empty array for unknown template', () => {
    expect(preferredSkills('nope')).toEqual([]);
  });

  it('returns a fresh copy (mutation-safe)', () => {
    const a = preferredSkills('production-ready');
    a.push('mutation-test');
    const b = preferredSkills('production-ready');
    expect(b).not.toContain('mutation-test');
  });
});

describe('goals.plannerModelFor', () => {
  it('returns sonnet for production-ready by default', () => {
    expect(plannerModelFor('production-ready')).toBe('sonnet');
  });

  it('returns opus for explorar-idea', () => {
    expect(plannerModelFor('explorar-idea')).toBe('opus');
  });

  it('upgrades to opus when note mentions exploration', () => {
    expect(plannerModelFor('production-ready', 'explorar nuevo approach de auth')).toBe('opus');
    expect(plannerModelFor('mantenimiento', 'es un prototipo temporal')).toBe('opus');
    expect(plannerModelFor('MVP-lanzable', 'experimento con Tauri')).toBe('opus');
  });

  it('keeps sonnet for plain production notes', () => {
    expect(plannerModelFor('production-ready', 'priorizar rendimiento')).toBe('sonnet');
  });

  it('returns sonnet default for unknown template', () => {
    expect(plannerModelFor('nope')).toBe('sonnet');
  });
});

describe('goals.evaluate — edge cases', () => {
  it('handles missing analysis gracefully', () => {
    const r = evaluate('mantenimiento', { analysis: null, history: [], now: NOW });
    expect(r.met).toBe(false);
    expect(r.satisfied).toBe(0);
  });

  it('handles missing history gracefully', () => {
    const r = evaluate('production-ready', { analysis: { checks: {}, score: 5 }, now: NOW });
    expect(r.met).toBe(false);
  });

  it('uses Date.now() when state.now is undefined', () => {
    // Should not throw
    const r = evaluate('MVP-lanzable', { analysis: { checks: {}, score: 0 }, history: [] });
    expect(r).toHaveProperty('satisfied');
    expect(r).toHaveProperty('total');
  });

  it('criterion detail is always a string', () => {
    const r = evaluate('production-ready', state());
    for (const c of r.criteria) {
      expect(typeof c.detail).toBe('string');
      expect(c.detail.length).toBeGreaterThan(0);
    }
  });
});
