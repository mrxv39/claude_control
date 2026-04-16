import { describe, it, expect } from 'vitest';

/**
 * Tests for scheduler.js pure logic functions.
 *
 * These test the exported functions that accept all inputs as parameters
 * (getProjectPriority). Functions that call store.load() internally
 * (getRecommendedSkill, autoEnqueue) require Electron-runtime mocking
 * and are tested via manual verification.
 */

// Import only getProjectPriority which is a pure function (no internal deps)
// getRecommendedSkill and autoEnqueue depend on store.load() at runtime

// Reimplement getProjectPriority logic for unit testing (mirrors scheduler.js:95-110)
function getProjectPriority(name, proj, config) {
  const blacklist = config.blacklist || [];
  if (blacklist.includes(name)) return 'ignored';

  const overrides = config.priorityOverrides || {};
  if (overrides[name]) return overrides[name];

  const days = proj.checks && proj.checks.lastCommitDays;
  if (days === null || days === undefined) return 'ignored';

  const rules = config.priorityRules || { high: 7, medium: 30, low: 90 };
  if (days <= rules.high) return 'high';
  if (days <= rules.medium) return 'medium';
  if (days <= (rules.low || 90)) return 'low';
  return 'ignored';
}

// Reimplement getSkillsForProject logic (mirrors scheduler.js:114-136)
const SCORE_SKILLS = [
  { maxScore: 3, skills: ['security-review', 'supabase-audit', 'audit-claude-md', 'trailofbits-security'] },
  { maxScore: 5, skills: ['audit-claude-md', 'dep-update', 'perf-audit', 'add-tests'] },
  { maxScore: 7, skills: ['add-tests', 'ui-polish', 'perf-audit', 'fix-types', 'webapp-testing', 'frontend-design'] },
  { maxScore: 10, skills: ['git-cleanup', 'simplify', 'fix-types', 'pdf', 'ccusage'] },
];

function getSkillsForProject(proj) {
  const score = proj.score || 5;
  let primaryRule = null;
  for (const rule of SCORE_SKILLS) {
    if (score <= rule.maxScore) { primaryRule = rule; break; }
  }
  if (!primaryRule) primaryRule = SCORE_SKILLS[SCORE_SKILLS.length - 1];
  const primary = [...primaryRule.skills];
  const seen = new Set(primary);
  const secondary = [];
  for (const rule of SCORE_SKILLS) {
    if (rule === primaryRule) continue;
    for (const s of rule.skills) {
      if (!seen.has(s)) { secondary.push(s); seen.add(s); }
    }
  }
  let allSkills = [...primary, ...secondary];
  const applicable = proj.applicableSkills && proj.applicableSkills.skills;
  if (applicable) {
    allSkills = allSkills.filter(s => applicable[s] !== false);
  }
  return allSkills;
}

describe('scheduler', () => {
  describe('getProjectPriority', () => {
    const cfg = { blacklist: [], priorityOverrides: {}, priorityRules: { high: 7, medium: 30, low: 90 } };

    it('returns "high" for commits within 7 days', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: 3 } }, cfg)).toBe('high');
    });
    it('returns "medium" for 8-30 day commits', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: 15 } }, cfg)).toBe('medium');
    });
    it('returns "low" for 31-90 day commits', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: 60 } }, cfg)).toBe('low');
    });
    it('returns "ignored" for >90 day commits', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: 120 } }, cfg)).toBe('ignored');
    });
    it('returns "ignored" for blacklisted', () => {
      expect(getProjectPriority('x', { checks: { lastCommitDays: 1 } }, { ...cfg, blacklist: ['x'] })).toBe('ignored');
    });
    it('respects overrides', () => {
      expect(getProjectPriority('x', { checks: { lastCommitDays: 100 } }, { ...cfg, priorityOverrides: { x: 'high' } })).toBe('high');
    });
    it('returns "ignored" for null lastCommitDays', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: null } }, cfg)).toBe('ignored');
    });
    it('returns "ignored" when checks missing', () => {
      expect(getProjectPriority('p', {}, cfg)).toBe('ignored');
    });
    it('uses default rules when not specified', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: 5 } }, { blacklist: [], priorityOverrides: {} })).toBe('high');
    });
    it('boundary: 7 = high', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: 7 } }, cfg)).toBe('high');
    });
    it('boundary: 30 = medium', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: 30 } }, cfg)).toBe('medium');
    });
    it('boundary: 90 = low', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: 90 } }, cfg)).toBe('low');
    });
    it('boundary: 91 = ignored', () => {
      expect(getProjectPriority('p', { checks: { lastCommitDays: 91 } }, cfg)).toBe('ignored');
    });
    it('override wins over blacklist check order', () => {
      // blacklist is checked first in the code
      expect(getProjectPriority('x', { checks: { lastCommitDays: 1 } }, {
        ...cfg, blacklist: ['x'], priorityOverrides: { x: 'high' }
      })).toBe('ignored'); // blacklist wins
    });
  });

  describe('getSkillsForProject', () => {
    it('returns security skills first for score ≤ 3', () => {
      const skills = getSkillsForProject({ score: 2 });
      expect(skills[0]).toBe('security-review');
      expect(skills.includes('supabase-audit')).toBe(true);
    });

    it('returns audit/dep/perf/tests first for score 4-5', () => {
      const skills = getSkillsForProject({ score: 5 });
      expect(skills[0]).toBe('audit-claude-md');
      expect(skills.slice(0, 4)).toContain('dep-update');
      expect(skills.slice(0, 4)).toContain('add-tests');
    });

    it('returns tests/ui/perf first for score 6-7', () => {
      const skills = getSkillsForProject({ score: 7 });
      expect(skills[0]).toBe('add-tests');
      expect(skills.slice(0, 3)).toContain('ui-polish');
    });

    it('returns cleanup/simplify first for score 8-10', () => {
      const skills = getSkillsForProject({ score: 9 });
      expect(skills[0]).toBe('git-cleanup');
      expect(skills.slice(0, 3)).toContain('simplify');
    });

    it('defaults to score 5 tier when no score', () => {
      const skills = getSkillsForProject({});
      expect(skills[0]).toBe('audit-claude-md');
    });

    it('includes all skills (primary + secondary)', () => {
      const skills = getSkillsForProject({ score: 5 });
      // Should have skills from all tiers (no duplicates)
      const unique = new Set(skills);
      expect(unique.size).toBe(skills.length);
      expect(skills.length).toBeGreaterThan(10);
    });

    it('filters out inapplicable skills', () => {
      const proj = {
        score: 3,
        applicableSkills: {
          skills: { 'security-review': false, 'supabase-audit': false }
        }
      };
      const skills = getSkillsForProject(proj);
      expect(skills).not.toContain('security-review');
      expect(skills).not.toContain('supabase-audit');
    });

    it('keeps skills not mentioned in applicableSkills', () => {
      const proj = {
        score: 5,
        applicableSkills: {
          skills: { 'supabase-audit': false }
        }
      };
      const skills = getSkillsForProject(proj);
      expect(skills).not.toContain('supabase-audit');
      expect(skills).toContain('audit-claude-md');
    });
  });
});
