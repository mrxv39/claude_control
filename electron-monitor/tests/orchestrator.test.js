import { describe, it, expect } from 'vitest';

const {
  tick,
  makePlannerProject,
  selectProjectsForPlanner,
  buildGlobalHistory,
} = require('../lib/orchestrator');

const DAY_MS = 86400000;
const NOW = new Date('2026-04-18T12:00:00Z').getTime();

function daysAgo(n) { return NOW - n * DAY_MS; }

// Fabrica de deps para tick()
function deps({
  projects = {},
  analyze,
  planner,
  executor,
} = {}) {
  const events = [];
  const updates = [];
  const cfg = { projects: JSON.parse(JSON.stringify(projects)) };
  return {
    capture: { events, updates, cfg },
    spec: {
      getConfig: async () => cfg,
      analyze: analyze || (async (p) => ({ score: 5, checks: {} })),
      updateProject: async (name, patch) => {
        updates.push({ name, patch });
        cfg.projects[name] = { ...cfg.projects[name], ...patch };
      },
      recordEvent: (e) => events.push(e),
      planner: planner || {
        decide: async () => ({ decision: 'no_op', reasoning: 'default no-op' }),
        buildConstraints: () => [],
      },
      executor,
      now: NOW,
    },
  };
}

// ---- pure helpers ----

describe('makePlannerProject', () => {
  it('maps project + evaluation into planner format', () => {
    const p = { path: '/p/x', stack: 'node', objective: { template: 'MVP-lanzable' }, history: [{ skill: 'a', at: 1, outcome: 'ok' }] };
    const evalResult = { met: false, satisfied: 1, total: 2, criteria: [] };
    const out = makePlannerProject('x', p, evalResult);
    expect(out.name).toBe('x');
    expect(out.path).toBe('/p/x');
    expect(out.objective).toEqual({ template: 'MVP-lanzable' });
    expect(out.preferredSkills.length).toBeGreaterThan(0);
    expect(out.recentHistory).toHaveLength(1);
  });

  it('trims history to last 10 entries', () => {
    const history = Array(15).fill(0).map((_, i) => ({ skill: 's', at: i, outcome: 'ok' }));
    const out = makePlannerProject('x', { path: '/p', stack: 'n', objective: { template: 'MVP-lanzable' }, history }, {});
    expect(out.recentHistory).toHaveLength(10);
    expect(out.recentHistory[0].at).toBe(5);
  });
});

describe('selectProjectsForPlanner', () => {
  it('includes in-progress projects', () => {
    expect(selectProjectsForPlanner([{ transition: 'in-progress', needsReevaluation: false }])).toHaveLength(1);
  });

  it('includes regressed projects', () => {
    expect(selectProjectsForPlanner([{ transition: 'regressed', needsReevaluation: false }])).toHaveLength(1);
  });

  it('includes maintained projects only if re-eval is due', () => {
    expect(selectProjectsForPlanner([{ transition: 'maintained', needsReevaluation: false }])).toHaveLength(0);
    expect(selectProjectsForPlanner([{ transition: 'maintained', needsReevaluation: true }])).toHaveLength(1);
  });

  it('excludes reached projects (they just transitioned)', () => {
    expect(selectProjectsForPlanner([{ transition: 'reached', needsReevaluation: false }])).toHaveLength(0);
  });
});

describe('buildGlobalHistory', () => {
  it('flattens histories with project name', () => {
    const projects = {
      a: { history: [{ skill: 's1', at: 1, outcome: 'ok' }, { skill: 's2', at: 2, outcome: 'fail' }] },
      b: { history: [{ skill: 's1', at: 3, outcome: 'ok' }] },
    };
    const out = buildGlobalHistory(projects);
    expect(out).toHaveLength(3);
    expect(out.filter(h => h.project === 'a')).toHaveLength(2);
    expect(out.find(h => h.at === 3).project).toBe('b');
  });

  it('ignores malformed entries', () => {
    const projects = {
      a: { history: [null, { skill: 's' }, { at: 1 }, { skill: 's', at: 10, outcome: 'ok' }] },
    };
    expect(buildGlobalHistory(projects)).toHaveLength(1);
  });

  it('handles empty/missing input', () => {
    expect(buildGlobalHistory(null)).toEqual([]);
    expect(buildGlobalHistory({})).toEqual([]);
  });
});

// ---- tick() orchestration ----

describe('tick — empty states', () => {
  it('skips when no projects configured', async () => {
    const d = deps();
    const r = await tick(d.spec);
    expect(r.action).toBe('skip');
    expect(r.reason).toBe('no-active-projects');
    expect(d.capture.events[0].type).toBe('tick-skip');
  });

  it('skips when no active projects', async () => {
    const d = deps({ projects: { a: { active: false, objective: { template: 'MVP-lanzable' }, path: '/p' } } });
    const r = await tick(d.spec);
    expect(r.action).toBe('skip');
  });

  it('skips when projects lack objective', async () => {
    const d = deps({ projects: { a: { active: true, objective: null, path: '/p' } } });
    const r = await tick(d.spec);
    expect(r.action).toBe('skip');
  });
});

describe('tick — evaluation + transitions', () => {
  it('marks reached when goal is newly met', async () => {
    const d = deps({
      projects: {
        x: {
          active: true,
          path: '/p/x',
          stack: 'node',
          objective: { template: 'MVP-lanzable' },
          history: [{ skill: 'add-tests', outcome: 'ok', at: daysAgo(1) }],
          maintenanceSince: null,
        },
      },
      analyze: async () => ({ score: 7, checks: { hasClaude: true, hasTests: true, gitClean: true } }),
    });
    const r = await tick(d.spec);
    // Primer proyecto pasa a mantenimiento → select excluye 'reached' → skip
    expect(r.action).toBe('skip');
    expect(r.reason).toBe('all-in-maintenance');
    const reachedUpdate = d.capture.updates.find(u => u.patch.maintenanceSince === NOW);
    expect(reachedUpdate.name).toBe('x');
    const reachedEvent = d.capture.events.find(e => e.type === 'goal-reached');
    expect(reachedEvent).toBeTruthy();
  });

  it('marks regressed when previously in maintenance but not anymore', async () => {
    const d = deps({
      projects: {
        x: {
          active: true,
          path: '/p/x',
          stack: 'node',
          objective: { template: 'MVP-lanzable' },
          history: [],
          maintenanceSince: daysAgo(3),
        },
      },
      analyze: async () => ({ score: 3, checks: {} }),
    });
    await tick(d.spec);
    const ev = d.capture.events.find(e => e.type === 'goal-regressed');
    expect(ev).toBeTruthy();
    const up = d.capture.updates.find(u => u.patch.maintenanceSince === null);
    expect(up).toBeTruthy();
  });
});

describe('tick — planner interaction', () => {
  it('calls planner with active projects needing action', async () => {
    let captured;
    const d = deps({
      projects: {
        x: {
          active: true,
          path: '/p/x',
          stack: 'node',
          objective: { template: 'MVP-lanzable' },
          history: [],
        },
      },
      planner: {
        decide: async (s) => { captured = s; return { decision: 'no_op', reasoning: 'nothing' }; },
        buildConstraints: () => [],
      },
    });
    await tick(d.spec);
    expect(captured.activeProjects).toHaveLength(1);
    expect(captured.activeProjects[0].name).toBe('x');
    expect(captured.constraints).toBeDefined();
  });

  it('dry-run: records dry-run event and does not call executor', async () => {
    let executorCalls = 0;
    const d = deps({
      projects: {
        x: { active: true, path: '/p/x', stack: 'node', objective: { template: 'MVP-lanzable' }, history: [] },
      },
      planner: {
        decide: async () => ({ decision: 'run', project: 'x', skill: 'audit-claude-md', reasoning: 'falta docs' }),
        buildConstraints: () => [],
      },
      // no executor → dry-run
    });
    const r = await tick(d.spec);
    expect(r.action).toBe('dry-run');
    expect(r.project).toBe('x');
    const dryEvent = d.capture.events.find(e => e.type === 'dry-run');
    expect(dryEvent).toBeTruthy();
    expect(dryEvent.skill).toBe('audit-claude-md');
  });

  it('no_op: records decision and returns', async () => {
    const d = deps({
      projects: {
        x: { active: true, path: '/p/x', stack: 'node', objective: { template: 'MVP-lanzable' }, history: [] },
      },
      planner: {
        decide: async () => ({ decision: 'no_op', reasoning: 'planner says no' }),
        buildConstraints: () => [],
      },
    });
    const r = await tick(d.spec);
    expect(r.action).toBe('no_op');
    expect(r.reason).toBe('planner says no');
  });
});

describe('tick — execution + circuit breaker', () => {
  it('records successful execution in history', async () => {
    const d = deps({
      projects: {
        x: { active: true, path: '/p/x', stack: 'node', objective: { template: 'MVP-lanzable' }, history: [] },
      },
      planner: {
        decide: async () => ({ decision: 'run', project: 'x', skill: 'audit-claude-md', reasoning: 'r' }),
        buildConstraints: () => [],
      },
      executor: {
        execute: async () => ({ status: 'done' }),
      },
    });
    const r = await tick(d.spec);
    expect(r.action).toBe('executed');
    expect(r.outcome).toBe('ok');
    const historyUpdate = d.capture.updates.find(u => u.patch.history);
    expect(historyUpdate).toBeTruthy();
    expect(historyUpdate.patch.history[0]).toMatchObject({ skill: 'audit-claude-md', outcome: 'ok' });
    expect(historyUpdate.patch.failures24h).toEqual([]);  // success resets
    expect(historyUpdate.patch.active).toBeUndefined();   // not tripped
  });

  it('records failed execution and increments failure counter', async () => {
    const d = deps({
      projects: {
        x: { active: true, path: '/p/x', stack: 'node', objective: { template: 'MVP-lanzable' }, history: [], failures24h: [] },
      },
      planner: {
        decide: async () => ({ decision: 'run', project: 'x', skill: 'fix-types', reasoning: 'r' }),
        buildConstraints: () => [],
      },
      executor: {
        execute: async () => ({ status: 'failed', error: 'compile error' }),
      },
    });
    const r = await tick(d.spec);
    expect(r.outcome).toBe('fail');
    const historyUpdate = d.capture.updates.find(u => u.patch.failures24h && u.patch.failures24h.length > 0);
    expect(historyUpdate.patch.failures24h).toHaveLength(1);
    expect(historyUpdate.patch.active).toBeUndefined(); // 1 fail != tripped
  });

  it('trips circuit breaker on 3rd failure and auto-pauses project', async () => {
    const prior = [
      { skill: 'x', at: NOW - 1000, reason: 'fail' },
      { skill: 'x', at: NOW - 500, reason: 'fail' },
    ];
    const d = deps({
      projects: {
        x: {
          active: true, path: '/p/x', stack: 'node',
          objective: { template: 'MVP-lanzable' }, history: [], failures24h: prior,
        },
      },
      planner: {
        decide: async () => ({ decision: 'run', project: 'x', skill: 'fix-types', reasoning: 'r' }),
        buildConstraints: () => [],
      },
      executor: {
        execute: async () => ({ status: 'failed' }),
      },
    });
    await tick(d.spec);
    const tripEvent = d.capture.events.find(e => e.type === 'circuit-breaker-trip');
    expect(tripEvent).toBeTruthy();
    const pauseUpdate = d.capture.updates.find(u => u.patch.active === false);
    expect(pauseUpdate).toBeTruthy();
  });

  it('handles executor throwing as failure', async () => {
    const d = deps({
      projects: {
        x: { active: true, path: '/p/x', stack: 'node', objective: { template: 'MVP-lanzable' }, history: [] },
      },
      planner: {
        decide: async () => ({ decision: 'run', project: 'x', skill: 's', reasoning: 'r' }),
        buildConstraints: () => [],
      },
      executor: {
        execute: async () => { throw new Error('boom'); },
      },
    });
    const r = await tick(d.spec);
    expect(r.outcome).toBe('fail');
  });
});

describe('tick — analyze resilience', () => {
  it('uses baseline when analyze throws', async () => {
    let plannerGotAnalysis = null;
    const d = deps({
      projects: {
        x: { active: true, path: '/p/x', stack: 'node', objective: { template: 'MVP-lanzable' }, history: [] },
      },
      analyze: async () => { throw new Error('fs error'); },
      planner: {
        decide: async (s) => {
          plannerGotAnalysis = s.activeProjects[0].evaluation;
          return { decision: 'no_op', reasoning: 'r' };
        },
        buildConstraints: () => [],
      },
    });
    await tick(d.spec);
    expect(plannerGotAnalysis).toBeDefined();
    expect(plannerGotAnalysis.total).toBeGreaterThan(0);
    const errEvent = d.capture.events.find(e => e.type === 'analyze-error');
    expect(errEvent).toBeTruthy();
  });
});
