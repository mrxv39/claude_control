import { describe, it, expect } from 'vitest';

const {
  extractPatterns,
  formatLessons,
  describePattern,
  learnLessons,
  globalSuccessRate,
} = require('../lib/planner-learner');

function run(skill, outcome, extras = {}) {
  return { skill, outcome, at: Date.now(), ...extras };
}

// ---- globalSuccessRate ----

describe('globalSuccessRate', () => {
  it('returns 0.5 for empty history', () => {
    expect(globalSuccessRate([])).toBe(0.5);
    expect(globalSuccessRate(null)).toBe(0.5);
  });

  it('computes success rate from history', () => {
    const hist = [
      run('a', 'ok'), run('a', 'ok'), run('a', 'fail'), run('a', 'fail'),
    ];
    expect(globalSuccessRate(hist)).toBe(0.5);
  });
});

// ---- extractPatterns ----

describe('extractPatterns', () => {
  it('returns empty for insufficient samples', () => {
    const hist = [run('a', 'ok'), run('a', 'fail')];
    expect(extractPatterns(hist, { minSample: 3 })).toEqual([]);
  });

  it('detects a negative pattern (skill failing in a stack)', () => {
    const hist = [
      // Global: 6 ok / 4 fail = 60% global
      run('audit-claude-md', 'ok'),
      run('audit-claude-md', 'ok'),
      run('audit-claude-md', 'ok'),
      run('audit-claude-md', 'ok'),
      run('audit-claude-md', 'ok'),
      run('audit-claude-md', 'fail', { stack: 'tauri+rust' }),
      run('audit-claude-md', 'fail', { stack: 'tauri+rust' }),
      run('audit-claude-md', 'fail', { stack: 'tauri+rust' }),
      run('audit-claude-md', 'fail', { stack: 'tauri+rust' }),
      run('audit-claude-md', 'ok'),
    ];
    const patterns = extractPatterns(hist, { minSample: 3, minDeviation: 0.3 });
    const tauri = patterns.find(p => p.stack === 'tauri+rust' && p.template === null);
    expect(tauri).toBeTruthy();
    expect(tauri.direction).toBe('negative');
    expect(tauri.runs).toBe(4);
    expect(tauri.successes).toBe(0);
  });

  it('detects positive patterns', () => {
    const hist = [
      // Global ~ 40% OK
      run('fix-types', 'ok', { template: 'production-ready' }),
      run('fix-types', 'ok', { template: 'production-ready' }),
      run('fix-types', 'ok', { template: 'production-ready' }),
      run('fix-types', 'fail'),
      run('fix-types', 'fail'),
      run('simplify', 'fail'),
      run('simplify', 'fail'),
      run('simplify', 'fail'),
    ];
    const patterns = extractPatterns(hist, { minSample: 3, minDeviation: 0.2 });
    const positive = patterns.find(p => p.direction === 'positive' && p.template === 'production-ready');
    expect(positive).toBeTruthy();
    expect(positive.skill).toBe('fix-types');
  });

  it('ranks negative patterns first', () => {
    const hist = [
      ...Array(5).fill(0).map(() => run('a', 'ok', { template: 't1' })),
      ...Array(5).fill(0).map(() => run('a', 'fail', { template: 't2' })),
    ];
    const patterns = extractPatterns(hist, { minSample: 3, minDeviation: 0.1 });
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].direction).toBe('negative');
  });

  it('confidence grows with sample size', () => {
    const small = Array(3).fill(0).map(() => run('a', 'fail', { stack: 'x' }));
    const large = Array(10).fill(0).map(() => run('b', 'fail', { stack: 'x' }));
    const hist = [...small, ...large, ...Array(5).fill(0).map(() => run('c', 'ok'))];
    const patterns = extractPatterns(hist, { minSample: 3, minDeviation: 0.1 });
    const smallPat = patterns.find(p => p.skill === 'a' && p.stack === 'x');
    const largePat = patterns.find(p => p.skill === 'b' && p.stack === 'x');
    expect(largePat.confidence).toBeGreaterThan(smallPat.confidence);
  });

  it('ignores patterns below minDeviation', () => {
    // All runs around 50% — no pattern should emerge
    const hist = [
      run('a', 'ok'), run('a', 'fail'),
      run('a', 'ok'), run('a', 'fail'),
      run('a', 'ok'), run('a', 'fail'),
    ];
    expect(extractPatterns(hist, { minSample: 3, minDeviation: 0.3 })).toEqual([]);
  });

  it('groups by skill+stack+template dimensions', () => {
    // Stack+template combination fails, rest succeed → pattern emerges for that combo
    const hist = [
      ...Array(5).fill(0).map(() => run('x', 'fail', { stack: 'node', template: 'mantenimiento' })),
      ...Array(5).fill(0).map(() => run('x', 'ok', { stack: 'python', template: 'MVP-lanzable' })),
    ];
    const patterns = extractPatterns(hist, { minSample: 3, minDeviation: 0.1 });
    const combined = patterns.find(p => p.stack === 'node' && p.template === 'mantenimiento');
    expect(combined).toBeTruthy();
    expect(combined.direction).toBe('negative');
  });

  it('handles empty input', () => {
    expect(extractPatterns([], {})).toEqual([]);
    expect(extractPatterns(null, {})).toEqual([]);
  });
});

// ---- describePattern ----

describe('describePattern', () => {
  it('formats negative patterns with "Evitar"', () => {
    const p = { skill: 'audit-claude-md', stack: 'tauri+rust', template: null, runs: 5, successes: 1, successRate: 0.2, deviation: -0.4, direction: 'negative', confidence: 0.5 };
    const s = describePattern(p);
    expect(s).toMatch(/Evitar/);
    expect(s).toMatch(/audit-claude-md/);
    expect(s).toMatch(/stack tauri\+rust/);
    expect(s).toMatch(/20%/);
  });

  it('formats positive patterns with "Preferir"', () => {
    const p = { skill: 'fix-types', stack: null, template: 'production-ready', runs: 5, successes: 5, successRate: 1, deviation: 0.5, direction: 'positive', confidence: 0.5 };
    const s = describePattern(p);
    expect(s).toMatch(/Preferir/);
    expect(s).toMatch(/template production-ready/);
  });

  it('handles skill-only patterns (no stack/template)', () => {
    const p = { skill: 'simplify', stack: null, template: null, runs: 8, successes: 2, successRate: 0.25, deviation: -0.3, direction: 'negative', confidence: 0.8 };
    const s = describePattern(p);
    expect(s).toMatch(/Evitar `simplify`:/);
    expect(s).not.toMatch(/en /);
  });
});

// ---- formatLessons ----

describe('formatLessons', () => {
  it('returns empty string for empty patterns', () => {
    expect(formatLessons([])).toBe('');
    expect(formatLessons(null)).toBe('');
  });

  it('respects maxLessons cap', () => {
    const patterns = Array(10).fill(0).map((_, i) => ({
      skill: `s${i}`, stack: null, template: null, runs: 5, successes: 1,
      successRate: 0.2, deviation: -0.3, direction: 'negative', confidence: 0.5,
    }));
    const text = formatLessons(patterns, { maxLessons: 3 });
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
  });

  it('prefers more-specific patterns', () => {
    const patterns = [
      { skill: 'a', stack: null, template: null, runs: 5, successes: 0, successRate: 0, deviation: -0.5, direction: 'negative', confidence: 0.5 },
      { skill: 'a', stack: 'tauri', template: 'production-ready', runs: 5, successes: 0, successRate: 0, deviation: -0.5, direction: 'negative', confidence: 0.5 },
      { skill: 'a', stack: 'tauri', template: null, runs: 5, successes: 0, successRate: 0, deviation: -0.5, direction: 'negative', confidence: 0.5 },
    ];
    const text = formatLessons(patterns, { maxLessons: 1 });
    // El más específico (con stack + template) gana
    expect(text).toContain('tauri');
    expect(text).toContain('production-ready');
  });
});

// ---- learnLessons shortcut ----

describe('learnLessons', () => {
  it('returns lessons text from history', () => {
    const hist = Array(5).fill(0).map(() => run('a', 'fail', { stack: 'x' }))
      .concat(Array(5).fill(0).map(() => run('b', 'ok')));
    const lessons = learnLessons(hist, { minSample: 3, minDeviation: 0.2 });
    expect(lessons).toMatch(/Evitar/);
    expect(lessons).toMatch(/stack x/);
  });

  it('empty history → empty lessons', () => {
    expect(learnLessons([])).toBe('');
  });
});
