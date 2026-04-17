import { describe, it, expect } from 'vitest';

const {
  classifyBlastRadius,
  shouldAutoMerge,
  shouldCreatePR,
  buildPRTitle,
  buildPRBody,
  createPR,
  autoMergeBranch,
  BLAST_RADIUS,
  DEFAULT_TRIVIAL_DELAY_HOURS,
} = require('../lib/auto-pr');

// ---- classifyBlastRadius ----

describe('classifyBlastRadius', () => {
  it('classifies known skills correctly', () => {
    expect(classifyBlastRadius('audit-claude-md')).toBe('trivial');
    expect(classifyBlastRadius('fix-types')).toBe('trivial');
    expect(classifyBlastRadius('git-cleanup')).toBe('trivial');
    expect(classifyBlastRadius('add-tests')).toBe('meaningful');
    expect(classifyBlastRadius('security-review')).toBe('meaningful');
    expect(classifyBlastRadius('simplify')).toBe('destructive');
    expect(classifyBlastRadius('frontend-design')).toBe('destructive');
  });

  it('defaults unknown skills to meaningful', () => {
    expect(classifyBlastRadius('some-new-skill')).toBe('meaningful');
    expect(classifyBlastRadius('')).toBe('meaningful');
  });

  it('docsOnly hint degrades to trivial', () => {
    expect(classifyBlastRadius('simplify', { docsOnly: true })).toBe('trivial');
    expect(classifyBlastRadius('security-review', { docsOnly: true })).toBe('trivial');
  });

  it('patchOnly hint degrades meaningful → trivial', () => {
    expect(classifyBlastRadius('dep-update', { patchOnly: true })).toBe('trivial');
  });

  it('patchOnly does not elevate destructive', () => {
    expect(classifyBlastRadius('simplify', { patchOnly: true })).toBe('destructive');
  });

  it('linesChanged >500 elevates meaningful → destructive', () => {
    expect(classifyBlastRadius('add-tests', { linesChanged: 800 })).toBe('destructive');
  });

  it('linesChanged does not affect trivial', () => {
    expect(classifyBlastRadius('audit-claude-md', { linesChanged: 2000 })).toBe('trivial');
  });

  it('respects overrides map', () => {
    expect(classifyBlastRadius('add-tests', { overrides: { 'add-tests': 'destructive' } })).toBe('destructive');
  });
});

// ---- shouldAutoMerge ----

describe('shouldAutoMerge', () => {
  it('never merges destructive', () => {
    expect(shouldAutoMerge('destructive', { branchAgeHours: 100, ciPassed: true }).shouldMerge).toBe(false);
  });

  it('never merges meaningful (opens PR instead)', () => {
    expect(shouldAutoMerge('meaningful', { branchAgeHours: 100, ciPassed: true }).shouldMerge).toBe(false);
  });

  it('merges trivial after delay with CI green', () => {
    const r = shouldAutoMerge('trivial', { branchAgeHours: 25, ciPassed: true });
    expect(r.shouldMerge).toBe(true);
    expect(r.reason).toMatch(/CI verde/);
  });

  it('does not merge trivial before delay', () => {
    const r = shouldAutoMerge('trivial', { branchAgeHours: 10, ciPassed: true });
    expect(r.shouldMerge).toBe(false);
    expect(r.reason).toMatch(/rama joven/);
  });

  it('does not merge when CI fails', () => {
    const r = shouldAutoMerge('trivial', { branchAgeHours: 25, ciPassed: false });
    expect(r.shouldMerge).toBe(false);
    expect(r.reason).toMatch(/CI en rojo/);
  });

  it('merges without CI if CI not configured (ciPassed null/undefined)', () => {
    expect(shouldAutoMerge('trivial', { branchAgeHours: 25 }).shouldMerge).toBe(true);
    expect(shouldAutoMerge('trivial', { branchAgeHours: 25, ciPassed: null }).shouldMerge).toBe(true);
  });

  it('requireCI=false bypasses CI check', () => {
    const r = shouldAutoMerge('trivial', { branchAgeHours: 25, ciPassed: false, requireCI: false });
    expect(r.shouldMerge).toBe(true);
  });

  it('respects custom delayHours', () => {
    const short = shouldAutoMerge('trivial', { branchAgeHours: 2, ciPassed: true, delayHours: 1 });
    const long = shouldAutoMerge('trivial', { branchAgeHours: 2, ciPassed: true, delayHours: 48 });
    expect(short.shouldMerge).toBe(true);
    expect(long.shouldMerge).toBe(false);
  });
});

// ---- shouldCreatePR ----

describe('shouldCreatePR', () => {
  it('true for meaningful only', () => {
    expect(shouldCreatePR('trivial')).toBe(false);
    expect(shouldCreatePR('meaningful')).toBe(true);
    expect(shouldCreatePR('destructive')).toBe(false);
  });
});

// ---- buildPRTitle/Body ----

describe('buildPRTitle', () => {
  it('formats consistently', () => {
    expect(buildPRTitle({ project: 'cars_control', skill: 'add-tests' })).toBe('auto(add-tests): cars_control');
  });

  it('handles missing fields', () => {
    expect(buildPRTitle({})).toBe('auto(skill): proyecto');
  });
});

describe('buildPRBody', () => {
  it('includes all sections', () => {
    const body = buildPRBody({
      project: 'x', skill: 's', branch: 'claudio/auto/s-1', reasoning: 'porque falta',
      diffStats: ' 2 files changed, 10 insertions(+)',
    });
    expect(body).toMatch(/\*\*Proyecto:\*\* x/);
    expect(body).toMatch(/\*\*Skill:\*\* s/);
    expect(body).toMatch(/claudio\/auto\/s-1/);
    expect(body).toMatch(/porque falta/);
    expect(body).toMatch(/2 files changed/);
  });

  it('includes event URL when provided', () => {
    const body = buildPRBody({
      project: 'x', skill: 's', branch: 'b', reasoning: 'r',
      eventUrl: 'http://localhost:9999/events/123',
    });
    expect(body).toMatch(/\[Ver evento en el Feed\]/);
    expect(body).toContain('http://localhost:9999/events/123');
  });

  it('handles missing diff/url gracefully', () => {
    const body = buildPRBody({ project: 'x', skill: 's', branch: 'b', reasoning: 'r' });
    expect(body).not.toMatch(/### Cambios/);
    expect(body).not.toMatch(/Ver evento/);
  });
});

// ---- createPR (with DI) ----

describe('createPR', () => {
  it('calls gh with base, head, title, body and parses URL from output', async () => {
    const calls = [];
    const ghRun = async (args, cwd) => {
      calls.push({ args, cwd });
      return 'https://github.com/user/repo/pull/42\n';
    };
    const r = await createPR(
      { project: 'x', projectPath: '/p/x', skill: 's', branch: 'b', reasoning: 'r' },
      { ghRun, base: 'master' }
    );
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://github.com/user/repo/pull/42');
    expect(calls[0].args).toContain('--base');
    expect(calls[0].args).toContain('master');
    expect(calls[0].args).toContain('--head');
    expect(calls[0].args).toContain('b');
    expect(calls[0].cwd).toBe('/p/x');
  });

  it('returns ok:false on gh error', async () => {
    const ghRun = async () => { throw new Error('auth failed'); };
    const r = await createPR(
      { project: 'x', projectPath: '/p/x', skill: 's', branch: 'b', reasoning: 'r' },
      { ghRun }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/auth failed/);
  });
});

// ---- autoMergeBranch (with DI) ----

describe('autoMergeBranch', () => {
  it('runs checkout + merge --ff-only + branch -d on success', async () => {
    const calls = [];
    const gitRun = async (args) => { calls.push(args); return ''; };
    const r = await autoMergeBranch({ projectPath: '/p', branch: 'claudio/auto/s' }, { gitRun });
    expect(r.ok).toBe(true);
    expect(calls[0]).toEqual(['checkout', 'master']);
    expect(calls[1]).toEqual(['merge', '--ff-only', 'claudio/auto/s']);
    expect(calls[2]).toEqual(['branch', '-d', 'claudio/auto/s']);
  });

  it('returns error when merge fails', async () => {
    const gitRun = async (args) => {
      if (args[0] === 'merge') throw new Error('not fast-forward');
      return '';
    };
    const r = await autoMergeBranch({ projectPath: '/p', branch: 'b' }, { gitRun });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not fast-forward/);
  });

  it('respects custom base branch', async () => {
    const calls = [];
    const gitRun = async (args) => { calls.push(args); return ''; };
    await autoMergeBranch({ projectPath: '/p', branch: 'b', base: 'main' }, { gitRun });
    expect(calls[0]).toEqual(['checkout', 'main']);
  });
});

// ---- sanity on the map ----

describe('BLAST_RADIUS map', () => {
  it('covers expected skills', () => {
    expect(BLAST_RADIUS['audit-claude-md']).toBe('trivial');
    expect(BLAST_RADIUS['simplify']).toBe('destructive');
  });

  it('all values are valid radii', () => {
    for (const v of Object.values(BLAST_RADIUS)) {
      expect(['trivial', 'meaningful', 'destructive']).toContain(v);
    }
  });

  it('DEFAULT_TRIVIAL_DELAY_HOURS is sensible', () => {
    expect(DEFAULT_TRIVIAL_DELAY_HOURS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_TRIVIAL_DELAY_HOURS).toBeLessThanOrEqual(72);
  });
});
