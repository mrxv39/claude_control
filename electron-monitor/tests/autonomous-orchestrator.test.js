import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { AutonomousOrchestrator, ERROR_BACKOFF_MS } = require('../lib/autonomous-orchestrator');

function flushTimers(ms) {
  return vi.advanceTimersByTimeAsync(ms);
}

function baseDeps(overrides = {}) {
  return {
    getConfig: async () => ({ projects: {} }),
    analyze: async () => ({ score: 5, checks: {} }),
    updateProject: async () => {},
    planner: {
      decide: async () => ({ decision: 'no_op', reasoning: 'r' }),
      buildConstraints: () => [],
    },
    ...overrides,
  };
}

describe('AutonomousOrchestrator — construction', () => {
  it('throws when getConfig is missing', () => {
    expect(() => new AutonomousOrchestrator({})).toThrow(/getConfig/);
    expect(() => new AutonomousOrchestrator(null)).toThrow();
  });

  it('accepts deps with getConfig', () => {
    const o = new AutonomousOrchestrator(baseDeps());
    expect(o).toBeInstanceOf(AutonomousOrchestrator);
    expect(o.isRunning()).toBe(false);
    expect(o.isDryRun()).toBe(false);
  });

  it('dryRun flag passes through', () => {
    const o = new AutonomousOrchestrator({ ...baseDeps(), dryRun: true });
    expect(o.isDryRun()).toBe(true);
  });
});

describe('AutonomousOrchestrator — start/stop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start schedules first tick quickly; stop clears it', async () => {
    let ticks = 0;
    const o = new AutonomousOrchestrator({
      ...baseDeps({
        getConfig: async () => { ticks++; return { projects: {} }; },
      }),
    });
    o.start();
    expect(o.isRunning()).toBe(true);
    await flushTimers(200);
    expect(ticks).toBeGreaterThan(0);
    o.stop();
    const ticksAtStop = ticks;
    await flushTimers(65000);
    expect(ticks).toBe(ticksAtStop);
    expect(o.isRunning()).toBe(false);
  });

  it('start is idempotent', () => {
    const o = new AutonomousOrchestrator(baseDeps());
    o.start();
    o.start();
    o.start();
    expect(o.isRunning()).toBe(true);
    o.stop();
  });
});

describe('AutonomousOrchestrator — tick loop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reschedules next tick with getIntervalMs', async () => {
    let calls = 0;
    const o = new AutonomousOrchestrator({
      ...baseDeps({ getConfig: async () => { calls++; return { projects: {} }; } }),
      getIntervalMs: () => 10000,
    });
    o.start();
    await flushTimers(200); // first tick
    expect(calls).toBe(1);
    await flushTimers(10000);
    expect(calls).toBe(2);
    await flushTimers(10000);
    expect(calls).toBe(3);
    o.stop();
  });

  it('uses default 60s interval if getIntervalMs omitted', async () => {
    let calls = 0;
    const o = new AutonomousOrchestrator({
      ...baseDeps({ getConfig: async () => { calls++; return { projects: {} }; } }),
    });
    o.start();
    await flushTimers(200);
    expect(calls).toBe(1);
    await flushTimers(30000);
    expect(calls).toBe(1); // still just 1
    await flushTimers(35000);
    expect(calls).toBe(2);
    o.stop();
  });

  it('backs off ERROR_BACKOFF_MS after error tick', async () => {
    let calls = 0;
    const o = new AutonomousOrchestrator({
      ...baseDeps({ getConfig: async () => { calls++; throw new Error('boom'); } }),
      getIntervalMs: () => 60000,
    });
    o.start();
    await flushTimers(200);
    expect(calls).toBe(1);
    // Error → backoff 5s, not 60s
    await flushTimers(ERROR_BACKOFF_MS + 100);
    expect(calls).toBe(2);
    o.stop();
  });
});

describe('AutonomousOrchestrator — events', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('captures events from orchestrator.tick', async () => {
    const o = new AutonomousOrchestrator(baseDeps());
    o.start();
    await flushTimers(200);
    const events = o.getRecentEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'tick-skip')).toBe(true);
    o.stop();
  });

  it('forwards events to onEvent callback', async () => {
    const received = [];
    const o = new AutonomousOrchestrator({
      ...baseDeps(),
      onEvent: (e) => received.push(e),
    });
    o.start();
    await flushTimers(200);
    expect(received.length).toBeGreaterThan(0);
    o.stop();
  });

  it('caps eventLog to maxEventLog', async () => {
    const o = new AutonomousOrchestrator({
      ...baseDeps(),
      maxEventLog: 3,
      getIntervalMs: () => 50,
    });
    o.start();
    // Each tick emits 1 tick-skip event (no active projects)
    await flushTimers(500);
    expect(o.getRecentEvents(100).length).toBeLessThanOrEqual(3);
    o.stop();
  });

  it('captures tick-error event when tick throws', async () => {
    let count = 0;
    const o = new AutonomousOrchestrator({
      ...baseDeps({
        getConfig: async () => { count++; if (count === 1) throw new Error('fs'); return { projects: {} }; },
      }),
      getIntervalMs: () => 10000,
    });
    o.start();
    await flushTimers(200);
    const events = o.getRecentEvents();
    expect(events.some(e => e.type === 'tick-error')).toBe(true);
    o.stop();
  });

  it('getRecentEvents returns last N', async () => {
    const o = new AutonomousOrchestrator({
      ...baseDeps(),
      getIntervalMs: () => 50,
    });
    o.start();
    await flushTimers(500);
    expect(o.getRecentEvents(2)).toHaveLength(2);
    o.stop();
  });
});

describe('AutonomousOrchestrator — dry-run', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('setDryRun(true) passes null executor to tick', async () => {
    let executorCalled = false;
    const o = new AutonomousOrchestrator({
      ...baseDeps({
        getConfig: async () => ({
          projects: {
            x: { active: true, path: '/p/x', stack: 'node', objective: { template: 'MVP-lanzable' }, history: [] },
          },
        }),
        planner: {
          decide: async () => ({ decision: 'run', project: 'x', skill: 'audit-claude-md', reasoning: 'r' }),
          buildConstraints: () => [],
        },
      }),
      executor: { execute: async () => { executorCalled = true; return { status: 'done' }; } },
      dryRun: true,
    });
    o.start();
    await flushTimers(200);
    expect(executorCalled).toBe(false);
    const events = o.getRecentEvents();
    expect(events.some(e => e.type === 'dry-run')).toBe(true);
    o.stop();
  });

  it('setDryRun(false) passes real executor', async () => {
    let executorCalled = false;
    const o = new AutonomousOrchestrator({
      ...baseDeps({
        getConfig: async () => ({
          projects: {
            x: { active: true, path: '/p/x', stack: 'node', objective: { template: 'MVP-lanzable' }, history: [] },
          },
        }),
        planner: {
          decide: async () => ({ decision: 'run', project: 'x', skill: 'audit-claude-md', reasoning: 'r' }),
          buildConstraints: () => [],
        },
      }),
      executor: { execute: async () => { executorCalled = true; return { status: 'done' }; } },
      dryRun: false,
    });
    o.start();
    await flushTimers(200);
    expect(executorCalled).toBe(true);
    o.stop();
  });
});

describe('AutonomousOrchestrator — concurrency guard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runTickNow does not overlap a running tick', async () => {
    let inProgress = 0;
    let maxConcurrent = 0;
    const o = new AutonomousOrchestrator({
      ...baseDeps({
        getConfig: async () => {
          inProgress++;
          if (inProgress > maxConcurrent) maxConcurrent = inProgress;
          await new Promise(r => setTimeout(r, 100));
          inProgress--;
          return { projects: {} };
        },
      }),
    });
    o.start();
    await flushTimers(50); // first tick is in flight but not done
    // Attempt a manual tick while the loop's tick is mid-flight
    const manualPromise = o.runTickNow();
    await flushTimers(200);
    const result = await manualPromise;
    // The second call should have returned skip, not run concurrently
    expect([result.action, maxConcurrent]).toEqual(['skip', 1]);
    o.stop();
  });
});

describe('AutonomousOrchestrator — last tick tracking', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tracks getLastTickResult + getLastTickAt after a tick', async () => {
    const o = new AutonomousOrchestrator(baseDeps());
    expect(o.getLastTickAt()).toBeNull();
    expect(o.getLastTickResult()).toBeNull();
    o.start();
    await flushTimers(200);
    expect(o.getLastTickResult()).not.toBeNull();
    expect(typeof o.getLastTickAt()).toBe('number');
    o.stop();
  });
});
