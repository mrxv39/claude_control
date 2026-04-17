import { describe, it, expect } from 'vitest';

/**
 * Tests for executor.js logic.
 *
 * executor.js spawns child processes (claude --print) and manages git branches.
 * We test: SKILLS config integrity, branch naming, emergencyStop logic,
 * and the execute flow decisions (without actually spawning processes).
 */

// --- SKILLS definitions (mirrored from executor.js) ---
const SKILLS = {
  'audit-claude-md': { model: 'sonnet' },
  'security-review': { model: 'opus' },
  'dep-update': { model: 'sonnet' },
  'simplify': { model: 'opus' },
  'add-tests': { model: 'opus' },
  'git-cleanup': { model: 'sonnet' },
  'supabase-audit': { model: 'opus' },
  'perf-audit': { model: 'sonnet' },
  'fix-types': { model: 'sonnet' },
  'ui-polish': { model: 'sonnet' },
  'webapp-testing': { model: 'sonnet' },
  'frontend-design': { model: 'sonnet' },
  'trailofbits-security': { model: 'opus' },
  'pdf': { model: 'sonnet' },
  'ccusage': { model: 'sonnet' },
};

const VALID_MODELS = new Set(['opus', 'sonnet']);
const WATCHDOG_MS = 8 * 60 * 1000;
const IDLE_TIMEOUT_MS = 120 * 1000;

// --- Branch naming logic (mirrored from executor.js:176-178) ---
function buildBranchName(skill) {
  const date = new Date().toISOString().slice(0, 10);
  return `claudio/auto/${skill}-${date}`;
}

function buildFallbackBranchName(skill) {
  const date = new Date().toISOString().slice(0, 10);
  return `claudio/auto/${skill}-${date}-${Date.now() % 10000}`;
}

// --- emergencyStop logic (mirrored from executor.js:378-385) ---
function emergencyStop(procs) {
  if (!procs || procs.size === 0) return false;
  const killed = [];
  for (const [id, proc] of procs) {
    try { proc.kill('SIGTERM'); killed.push(id); } catch {}
  }
  procs.clear();
  return true;
}

// --- execute pre-checks (mirrored from executor.js:243-246) ---
function validateTask(task) {
  if (!SKILLS[task.skill]) {
    return { status: 'failed', error: `Unknown skill: ${task.skill}`, costUsd: 0 };
  }
  return null;
}


describe('executor SKILLS config', () => {
  it('should have 15 registered skills', () => {
    expect(Object.keys(SKILLS)).toHaveLength(15);
  });

  it('every skill should have a valid model', () => {
    for (const [name, def] of Object.entries(SKILLS)) {
      expect(VALID_MODELS.has(def.model), `${name} has invalid model: ${def.model}`).toBe(true);
    }
  });

  it('opus skills should be the deep-analysis ones', () => {
    const opusSkills = Object.entries(SKILLS)
      .filter(([, d]) => d.model === 'opus')
      .map(([n]) => n)
      .sort();
    expect(opusSkills).toEqual([
      'add-tests',
      'security-review',
      'simplify',
      'supabase-audit',
      'trailofbits-security',
    ]);
  });

  it('sonnet skills should be the lighter ones', () => {
    const sonnetSkills = Object.entries(SKILLS)
      .filter(([, d]) => d.model === 'sonnet')
      .map(([n]) => n)
      .sort();
    expect(sonnetSkills).toEqual([
      'audit-claude-md',
      'ccusage',
      'dep-update',
      'fix-types',
      'frontend-design',
      'git-cleanup',
      'pdf',
      'perf-audit',
      'ui-polish',
      'webapp-testing',
    ]);
  });
});

describe('executor branch naming', () => {
  it('should produce claudio/auto/<skill>-<date> format', () => {
    const branch = buildBranchName('security-review');
    expect(branch).toMatch(/^claudio\/auto\/security-review-\d{4}-\d{2}-\d{2}$/);
  });

  it('should use today date', () => {
    const today = new Date().toISOString().slice(0, 10);
    const branch = buildBranchName('add-tests');
    expect(branch).toBe(`claudio/auto/add-tests-${today}`);
  });

  it('fallback branch should include timestamp suffix', () => {
    const branch = buildFallbackBranchName('simplify');
    expect(branch).toMatch(/^claudio\/auto\/simplify-\d{4}-\d{2}-\d{2}-\d{1,4}$/);
  });

  it('should handle skill names with hyphens correctly', () => {
    const branch = buildBranchName('trailofbits-security');
    expect(branch).toContain('trailofbits-security');
  });
});

describe('executor emergencyStop', () => {
  it('should return false for null procs', () => {
    expect(emergencyStop(null)).toBe(false);
  });

  it('should return false for empty map', () => {
    expect(emergencyStop(new Map())).toBe(false);
  });

  it('should kill all processes and clear the map', () => {
    const killed = [];
    const procs = new Map([
      ['task-1', { kill: (sig) => killed.push({ id: 'task-1', sig }) }],
      ['task-2', { kill: (sig) => killed.push({ id: 'task-2', sig }) }],
    ]);

    const result = emergencyStop(procs);

    expect(result).toBe(true);
    expect(procs.size).toBe(0);
    expect(killed).toHaveLength(2);
    expect(killed[0]).toEqual({ id: 'task-1', sig: 'SIGTERM' });
    expect(killed[1]).toEqual({ id: 'task-2', sig: 'SIGTERM' });
  });

  it('should handle kill throwing an error gracefully', () => {
    const procs = new Map([
      ['task-1', { kill: () => { throw new Error('already dead'); } }],
      ['task-2', { kill: () => {} }],
    ]);

    const result = emergencyStop(procs);
    expect(result).toBe(true);
    expect(procs.size).toBe(0);
  });
});

describe('executor task validation', () => {
  it('should reject unknown skill', () => {
    const result = validateTask({ skill: 'nonexistent' });
    expect(result).toEqual({
      status: 'failed',
      error: 'Unknown skill: nonexistent',
      costUsd: 0,
    });
  });

  it('should return null for valid skill', () => {
    expect(validateTask({ skill: 'add-tests' })).toBeNull();
    expect(validateTask({ skill: 'security-review' })).toBeNull();
    expect(validateTask({ skill: 'ccusage' })).toBeNull();
  });

  it('should reject empty skill name', () => {
    const result = validateTask({ skill: '' });
    expect(result.status).toBe('failed');
  });
});

describe('executor timeouts', () => {
  it('watchdog should be 8 minutes', () => {
    expect(WATCHDOG_MS).toBe(8 * 60 * 1000);
  });

  it('idle timeout should be 2 minutes', () => {
    expect(IDLE_TIMEOUT_MS).toBe(120 * 1000);
  });

  it('idle timeout should be less than watchdog', () => {
    expect(IDLE_TIMEOUT_MS).toBeLessThan(WATCHDOG_MS);
  });
});
