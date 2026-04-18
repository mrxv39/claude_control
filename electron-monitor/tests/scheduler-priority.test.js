import { describe, it, expect } from 'vitest';

const {
  SEVEN_DAYS_MS,
  SCORE_SKILLS,
  wasRecentlyRun,
  isOutsideWorkHours,
  getProjectPriority,
  getSkillsForProject,
} = require('../lib/scheduler-priority');

describe('SEVEN_DAYS_MS', () => {
  it('is 7 days in milliseconds', () => {
    expect(SEVEN_DAYS_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('SCORE_SKILLS', () => {
  it('covers score ranges up to 10', () => {
    const maxCovered = Math.max(...SCORE_SKILLS.map(r => r.maxScore));
    expect(maxCovered).toBeGreaterThanOrEqual(10);
  });

  it('every rule has a non-empty skills array', () => {
    for (const rule of SCORE_SKILLS) {
      expect(Array.isArray(rule.skills)).toBe(true);
      expect(rule.skills.length).toBeGreaterThan(0);
    }
  });
});

describe('wasRecentlyRun', () => {
  const now = Date.now();
  const recent = new Date(now - 1000).toISOString();
  const old = new Date(now - SEVEN_DAYS_MS - 1000).toISOString();

  it('returns true when skill was run in the last 7 days', () => {
    const log = [{ project: 'alpha', skill: 'simplify', timestamp: recent }];
    expect(wasRecentlyRun('alpha', 'simplify', log)).toBe(true);
  });

  it('returns false when the last run is older than 7 days', () => {
    const log = [{ project: 'alpha', skill: 'simplify', timestamp: old }];
    expect(wasRecentlyRun('alpha', 'simplify', log)).toBe(false);
  });

  it('returns false when no matching project/skill entry exists', () => {
    const log = [{ project: 'beta', skill: 'simplify', timestamp: recent }];
    expect(wasRecentlyRun('alpha', 'simplify', log)).toBe(false);
  });

  it('returns false for an empty log', () => {
    expect(wasRecentlyRun('alpha', 'simplify', [])).toBe(false);
  });

  it('ignores entries with null/missing timestamp', () => {
    const log = [{ project: 'alpha', skill: 'simplify', timestamp: null }];
    expect(wasRecentlyRun('alpha', 'simplify', log)).toBe(false);
  });
});

describe('isOutsideWorkHours', () => {
  it('uses a fallback when the configured timezone is invalid', () => {
    const cfg = { timezone: 'Not/A_Zone', workHours: { start: 9, end: 18 } };
    // Should not throw; returns a boolean based on system clock.
    const result = isOutsideWorkHours(cfg);
    expect(typeof result).toBe('boolean');
  });

  it('handles overnight windows (start > end)', () => {
    const cfg = { timezone: 'Europe/Madrid', workHours: { start: 22, end: 6 } };
    // Can't assert the specific hour, but the function must still return a boolean.
    expect(typeof isOutsideWorkHours(cfg)).toBe('boolean');
  });

  it('returns a boolean for a standard 9-18 window', () => {
    const cfg = { timezone: 'Europe/Madrid', workHours: { start: 9, end: 18 } };
    expect(typeof isOutsideWorkHours(cfg)).toBe('boolean');
  });
});

describe('getProjectPriority', () => {
  const baseProj = (days) => ({ checks: { lastCommitDays: days } });

  it('returns "ignored" when the project is blacklisted', () => {
    const config = { blacklist: ['alpha'] };
    expect(getProjectPriority('alpha', baseProj(1), config)).toBe('ignored');
  });

  it('respects manual priority overrides over commit-age rules', () => {
    const config = { priorityOverrides: { alpha: 'high' } };
    expect(getProjectPriority('alpha', baseProj(999), config)).toBe('high');
  });

  it('returns "ignored" when lastCommitDays is null/undefined', () => {
    expect(getProjectPriority('alpha', { checks: {} }, {})).toBe('ignored');
    expect(getProjectPriority('alpha', {}, {})).toBe('ignored');
  });

  it('maps commit age to priority using default rules', () => {
    expect(getProjectPriority('a', baseProj(0), {})).toBe('high');
    expect(getProjectPriority('a', baseProj(7), {})).toBe('high');
    expect(getProjectPriority('a', baseProj(8), {})).toBe('medium');
    expect(getProjectPriority('a', baseProj(30), {})).toBe('medium');
    expect(getProjectPriority('a', baseProj(31), {})).toBe('low');
    expect(getProjectPriority('a', baseProj(90), {})).toBe('low');
    expect(getProjectPriority('a', baseProj(91), {})).toBe('ignored');
  });

  it('respects custom priorityRules in config', () => {
    const config = { priorityRules: { high: 3, medium: 10, low: 30 } };
    expect(getProjectPriority('a', baseProj(3), config)).toBe('high');
    expect(getProjectPriority('a', baseProj(4), config)).toBe('medium');
    expect(getProjectPriority('a', baseProj(11), config)).toBe('low');
    expect(getProjectPriority('a', baseProj(31), config)).toBe('ignored');
  });

  it('blacklist takes precedence over overrides', () => {
    const config = { blacklist: ['alpha'], priorityOverrides: { alpha: 'high' } };
    expect(getProjectPriority('alpha', baseProj(1), config)).toBe('ignored');
  });
});

describe('getSkillsForProject', () => {
  it('returns primary skills first for a given score tier', () => {
    const result = getSkillsForProject({ score: 2 });
    // Score ≤3 rule: security-review, supabase-audit, audit-claude-md, trailofbits-security
    expect(result.slice(0, 4)).toEqual([
      'security-review', 'supabase-audit', 'audit-claude-md', 'trailofbits-security',
    ]);
  });

  it('appends skills from other tiers as secondary (deduped)', () => {
    const result = getSkillsForProject({ score: 2 });
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });

  it('defaults missing score to 5 (mid-tier rules)', () => {
    const result = getSkillsForProject({});
    // Score 5 falls in maxScore:5 rule → audit-claude-md first
    expect(result[0]).toBe('audit-claude-md');
  });

  it('uses the last tier for scores above the max', () => {
    const result = getSkillsForProject({ score: 99 });
    // maxScore:10 rule: git-cleanup, simplify, fix-types, pdf, ccusage
    expect(result.slice(0, 5)).toEqual(['git-cleanup', 'simplify', 'fix-types', 'pdf', 'ccusage']);
  });

  it('filters out skills marked inapplicable via applicableSkills', () => {
    const proj = {
      score: 2,
      applicableSkills: { skills: { 'security-review': false, 'audit-claude-md': true } },
    };
    const result = getSkillsForProject(proj);
    expect(result).not.toContain('security-review');
    expect(result).toContain('audit-claude-md');
  });

  it('keeps skills without an explicit applicableSkills entry', () => {
    const proj = {
      score: 2,
      applicableSkills: { skills: { 'security-review': false } }, // audit-claude-md not mentioned
    };
    expect(getSkillsForProject(proj)).toContain('audit-claude-md');
  });
});
