import { describe, it, expect } from 'vitest';

const {
  isUndoEligible,
  planUndo,
  inspectGitState,
  executeUndo,
  undoExecution,
} = require('../lib/undo');

const HOUR_MS = 3600 * 1000;
const NOW = new Date('2026-04-18T12:00:00Z').getTime();

function makeRun(overrides = {}) {
  return {
    skill: 'audit-claude-md',
    at: NOW - 1 * HOUR_MS,
    branch: 'claudio/auto/audit-claude-md-20260418',
    ...overrides,
  };
}

// ---- isUndoEligible ----

describe('isUndoEligible', () => {
  it('eligible within window', () => {
    const r = isUndoEligible(makeRun(), { now: NOW, windowHours: 6 });
    expect(r.eligible).toBe(true);
  });

  it('not eligible when older than window', () => {
    const r = isUndoEligible(makeRun({ at: NOW - 10 * HOUR_MS }), { now: NOW, windowHours: 6 });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/vencida/);
  });

  it('not eligible for future timestamps', () => {
    const r = isUndoEligible(makeRun({ at: NOW + HOUR_MS }), { now: NOW });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/futuro/);
  });

  it('handles missing run record', () => {
    expect(isUndoEligible(null).eligible).toBe(false);
    expect(isUndoEligible({}).eligible).toBe(false);
  });

  it('respects custom window', () => {
    const r = isUndoEligible(makeRun({ at: NOW - 3 * HOUR_MS }), { now: NOW, windowHours: 2 });
    expect(r.eligible).toBe(false);
  });
});

// ---- planUndo ----

describe('planUndo', () => {
  it('delete-branch when branch still exists', () => {
    const plan = planUndo(makeRun(), { branchExists: true });
    expect(plan.action).toBe('delete-branch');
    expect(plan.target).toBe('claudio/auto/audit-claude-md-20260418');
  });

  it('revert-commit when branch merged and commit known', () => {
    const plan = planUndo(
      makeRun({ mergedCommit: 'abc123' }),
      { branchExists: false, mergedToMaster: true }
    );
    expect(plan.action).toBe('revert-commit');
    expect(plan.target).toBe('abc123');
  });

  it('nothing when branch not found and no merged commit', () => {
    const plan = planUndo(makeRun(), { branchExists: false, mergedToMaster: false });
    expect(plan.action).toBe('nothing');
  });

  it('nothing when run has no branch field', () => {
    const plan = planUndo({ skill: 's', at: NOW }, { branchExists: true });
    expect(plan.action).toBe('nothing');
  });

  it('prefers delete over revert when branch still exists', () => {
    const plan = planUndo(
      makeRun({ mergedCommit: 'abc123' }),
      { branchExists: true, mergedToMaster: true }
    );
    expect(plan.action).toBe('delete-branch');
  });
});

// ---- inspectGitState ----

describe('inspectGitState', () => {
  it('branchExists true when rev-parse succeeds', async () => {
    const gitRun = async (args) => {
      if (args[0] === 'rev-parse') return 'sha';
      throw new Error('unexpected');
    };
    const s = await inspectGitState({ projectPath: '/p', branch: 'b' }, { gitRun });
    expect(s.branchExists).toBe(true);
    expect(s.mergedToMaster).toBe(false);
  });

  it('branchExists false when rev-parse throws', async () => {
    const gitRun = async () => { throw new Error('not found'); };
    const s = await inspectGitState({ projectPath: '/p', branch: 'b' }, { gitRun });
    expect(s.branchExists).toBe(false);
  });

  it('mergedToMaster true when merge-base succeeds', async () => {
    const gitRun = async (args) => {
      if (args[0] === 'rev-parse') throw new Error('gone');
      if (args[0] === 'merge-base') return '';
      throw new Error('?');
    };
    const s = await inspectGitState(
      { projectPath: '/p', branch: 'b', mergedCommit: 'abc' },
      { gitRun }
    );
    expect(s.mergedToMaster).toBe(true);
  });

  it('mergedToMaster false without mergedCommit input', async () => {
    const gitRun = async () => '';
    const s = await inspectGitState({ projectPath: '/p', branch: 'b' }, { gitRun });
    expect(s.mergedToMaster).toBe(false);
  });
});

// ---- executeUndo ----

describe('executeUndo', () => {
  it('nothing action is a no-op success', async () => {
    const r = await executeUndo({ projectPath: '/p', plan: { action: 'nothing' } }, { gitRun: async () => '' });
    expect(r.ok).toBe(true);
  });

  it('delete-branch runs git branch -D', async () => {
    const calls = [];
    const gitRun = async (args) => { calls.push(args); return ''; };
    await executeUndo(
      { projectPath: '/p', plan: { action: 'delete-branch', target: 'b' } },
      { gitRun }
    );
    expect(calls[0]).toEqual(['branch', '-D', 'b']);
  });

  it('revert-commit runs checkout + revert --no-edit', async () => {
    const calls = [];
    const gitRun = async (args) => { calls.push(args); return ''; };
    await executeUndo(
      { projectPath: '/p', plan: { action: 'revert-commit', target: 'abc' } },
      { gitRun }
    );
    expect(calls[0]).toEqual(['checkout', 'master']);
    expect(calls[1]).toEqual(['revert', '--no-edit', 'abc']);
  });

  it('respects custom base branch in revert', async () => {
    const calls = [];
    const gitRun = async (args) => { calls.push(args); return ''; };
    await executeUndo(
      { projectPath: '/p', plan: { action: 'revert-commit', target: 'abc' } },
      { gitRun, base: 'main' }
    );
    expect(calls[0]).toEqual(['checkout', 'main']);
  });

  it('returns ok:false with error message on failure', async () => {
    const gitRun = async () => { throw new Error('conflict'); };
    const r = await executeUndo(
      { projectPath: '/p', plan: { action: 'revert-commit', target: 'abc' } },
      { gitRun }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/conflict/);
  });
});

// ---- undoExecution (full flow) ----

describe('undoExecution', () => {
  it('returns eligibility error when out of window', async () => {
    const r = await undoExecution(
      { execution: makeRun({ at: NOW - 10 * HOUR_MS }), projectPath: '/p', now: NOW, windowHours: 6 },
      { gitRun: async () => '' }
    );
    expect(r.ok).toBe(false);
    expect(r.action).toBe('nothing');
    expect(r.reason).toMatch(/vencida/);
  });

  it('full happy path: eligible + branch exists + delete', async () => {
    const calls = [];
    const gitRun = async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return 'sha';
      return '';
    };
    const r = await undoExecution(
      { execution: makeRun(), projectPath: '/p', now: NOW },
      { gitRun }
    );
    expect(r.ok).toBe(true);
    expect(r.action).toBe('delete-branch');
    const hasDelete = calls.some(args => args[0] === 'branch' && args[1] === '-D');
    expect(hasDelete).toBe(true);
  });

  it('returns nothing when branch missing and no merged commit', async () => {
    const gitRun = async () => { throw new Error('not found'); };
    const r = await undoExecution(
      { execution: makeRun(), projectPath: '/p', now: NOW },
      { gitRun }
    );
    expect(r.ok).toBe(false);
    expect(r.action).toBe('nothing');
  });
});
