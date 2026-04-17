import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock USERPROFILE a un directorio temporal ANTES de importar el módulo
const TMP = path.join(os.tmpdir(), `claudio-test-as-${Date.now()}`);
process.env.USERPROFILE = TMP;

// Nuke cache para que orchestrator-store tome el USERPROFILE nuevo
vi.resetModules();

const {
  getConfig,
  updateConfig,
  getProject,
  updateProject,
  toggleActive,
  setObjective,
  appendHistory,
  appendEvent,
  readEvents,
  loadPendingQuestions,
  savePendingQuestions,
  appendPlannerHistory,
  readPlannerHistory,
  withAutonomousDefaults,
  deepMerge,
  EVENTS_PATH,
  PENDING_PATH,
  PLANNER_HISTORY_PATH,
} = require('../lib/autonomous-store');

const store = require('../lib/orchestrator-store');

const STATE_DIR = path.join(TMP, '.claude', 'claudio-state');

beforeEach(() => {
  // Preserva el dir (el módulo cachea _dirEnsured), solo borra contenido
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      const s = fs.statSync(p);
      if (s.isFile()) fs.unlinkSync(p);
    }
  } catch {}
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ---- deepMerge ----

describe('deepMerge', () => {
  it('merges nested objects', () => {
    const a = { x: 1, nested: { a: 1, b: 2 } };
    const b = { y: 2, nested: { b: 20, c: 30 } };
    expect(deepMerge(a, b)).toEqual({ x: 1, y: 2, nested: { a: 1, b: 20, c: 30 } });
  });

  it('replaces arrays (not deep-merged)', () => {
    expect(deepMerge({ arr: [1, 2] }, { arr: [3] })).toEqual({ arr: [3] });
  });

  it('replaces null with value', () => {
    expect(deepMerge({ x: null }, { x: { a: 1 } })).toEqual({ x: { a: 1 } });
  });

  it('does not mutate target', () => {
    const a = { nested: { x: 1 } };
    deepMerge(a, { nested: { y: 2 } });
    expect(a.nested.y).toBeUndefined();
  });
});

// ---- withAutonomousDefaults ----

describe('withAutonomousDefaults', () => {
  it('fills missing fields', () => {
    const p = withAutonomousDefaults({ path: '/p', stack: 'node' });
    expect(p.active).toBe(false);
    expect(p.objective).toBeNull();
    expect(p.history).toEqual([]);
    expect(p.failures24h).toEqual([]);
    expect(p.maintenanceSince).toBeNull();
    expect(p.path).toBe('/p');
    expect(p.stack).toBe('node');
  });

  it('preserves existing autonomous fields', () => {
    const p = withAutonomousDefaults({
      active: true,
      objective: { template: 'MVP-lanzable' },
      history: [{ skill: 'a' }],
    });
    expect(p.active).toBe(true);
    expect(p.objective.template).toBe('MVP-lanzable');
    expect(p.history).toHaveLength(1);
  });

  it('handles non-object input', () => {
    const p = withAutonomousDefaults(null);
    expect(p.active).toBe(false);
    expect(p.history).toEqual([]);
  });

  it('coerces corrupted arrays to empty', () => {
    const p = withAutonomousDefaults({ history: 'not-an-array', failures24h: null });
    expect(p.history).toEqual([]);
    expect(p.failures24h).toEqual([]);
  });
});

// ---- getConfig / updateConfig ----

describe('getConfig', () => {
  it('returns defaults on empty state', () => {
    const cfg = getConfig();
    expect(cfg.tokenTargetPct).toBe(90);
    expect(cfg.telegram).toMatchObject({ enabled: false });
    expect(cfg.projects).toEqual({});
  });

  it('merges existing orchestrator.json with autonomous defaults', () => {
    store.save({ projects: { a: { path: '/a', stack: 'node' } } });
    const cfg = getConfig();
    expect(cfg.projects.a.path).toBe('/a');
    expect(cfg.projects.a.active).toBe(false);
    expect(cfg.projects.a.history).toEqual([]);
  });

  it('preserves full telegram config when set', () => {
    store.save({ telegram: { enabled: true, botToken: 'X', chatId: '123', timeoutHours: 6 } });
    const cfg = getConfig();
    expect(cfg.telegram.enabled).toBe(true);
    expect(cfg.telegram.botToken).toBe('X');
  });
});

describe('updateConfig', () => {
  it('persists top-level patches with deep-merge', () => {
    updateConfig({ tokenTargetPct: 95, telegram: { enabled: true } });
    const cfg = getConfig();
    expect(cfg.tokenTargetPct).toBe(95);
    expect(cfg.telegram.enabled).toBe(true);
    expect(cfg.telegram.timeoutHours).toBe(12); // default conservado
  });
});

// ---- Project operations ----

describe('getProject / updateProject', () => {
  it('returns project with defaults even if not yet set', () => {
    const p = getProject('nope');
    expect(p.active).toBe(false);
    expect(p.history).toEqual([]);
  });

  it('creates project via updateProject', () => {
    updateProject('x', { active: true, objective: { template: 'MVP-lanzable' } });
    const p = getProject('x');
    expect(p.active).toBe(true);
    expect(p.objective.template).toBe('MVP-lanzable');
    expect(p.history).toEqual([]);
  });

  it('deep-merges patches', () => {
    updateProject('x', { objective: { template: 'MVP-lanzable', note: 'UX' } });
    updateProject('x', { objective: { note: 'rendimiento' } });
    const p = getProject('x');
    expect(p.objective.template).toBe('MVP-lanzable');
    expect(p.objective.note).toBe('rendimiento');
  });

  it('appends to history (arrays replaced, no deep-merge)', () => {
    updateProject('x', { history: [{ skill: 'a', at: 1, outcome: 'ok' }] });
    updateProject('x', { history: [{ skill: 'a', at: 1, outcome: 'ok' }, { skill: 'b', at: 2, outcome: 'ok' }] });
    const p = getProject('x');
    expect(p.history).toHaveLength(2);
  });

  it('throws when name is empty', () => {
    expect(() => updateProject('', { active: true })).toThrow(/name/);
    expect(() => updateProject(null, { active: true })).toThrow();
  });
});

describe('toggleActive / setObjective / appendHistory', () => {
  it('toggleActive flips the flag', () => {
    toggleActive('tog', true);
    expect(getProject('tog').active).toBe(true);
    toggleActive('tog', false);
    expect(getProject('tog').active).toBe(false);
  });

  it('setObjective replaces objective', () => {
    setObjective('obj', { template: 'production-ready' });
    expect(getProject('obj').objective.template).toBe('production-ready');
    setObjective('obj', null);
    expect(getProject('obj').objective).toBeNull();
  });

  it('appendHistory grows the list', () => {
    appendHistory('hist', { skill: 'a', at: 1, outcome: 'ok' });
    appendHistory('hist', { skill: 'b', at: 2, outcome: 'fail' });
    expect(getProject('hist').history).toHaveLength(2);
  });
});

// ---- Event log ----

describe('event log', () => {
  it('appendEvent writes JSONL', () => {
    appendEvent({ type: 'skill-executed', project: 'x', outcome: 'ok' });
    appendEvent({ type: 'goal-reached', project: 'x' });
    const ev = readEvents();
    expect(ev).toHaveLength(2);
    expect(ev[0].type).toBe('skill-executed');
    expect(typeof ev[0].at).toBe('number');
  });

  it('readEvents returns [] when file missing', () => {
    expect(readEvents()).toEqual([]);
  });

  it('readEvents respects maxLines', () => {
    for (let i = 0; i < 5; i++) appendEvent({ type: 'x', i });
    expect(readEvents(2)).toHaveLength(2);
  });

  it('appendEvent ignores non-objects', () => {
    appendEvent(null);
    appendEvent('nope');
    expect(readEvents()).toEqual([]);
  });
});

// ---- Pending questions ----

describe('pending questions', () => {
  it('loads empty array when file missing', () => {
    expect(loadPendingQuestions()).toEqual([]);
  });

  it('roundtrips save + load', () => {
    const q = [{ id: '1', status: 'pending', question: '?' }];
    savePendingQuestions(q);
    expect(loadPendingQuestions()).toEqual(q);
  });

  it('returns empty array for corrupted file', () => {
    fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
    fs.writeFileSync(PENDING_PATH, '{not valid json', 'utf-8');
    expect(loadPendingQuestions()).toEqual([]);
  });
});

// ---- Planner history ----

describe('planner history', () => {
  it('appendPlannerHistory writes JSONL with timestamp', () => {
    appendPlannerHistory({ skill: 's', stack: 'node', template: 't', outcome: 'ok' });
    const h = readPlannerHistory();
    expect(h).toHaveLength(1);
    expect(h[0].skill).toBe('s');
    expect(typeof h[0].at).toBe('number');
  });

  it('ignores records without skill', () => {
    appendPlannerHistory({ stack: 'node' });
    expect(readPlannerHistory()).toEqual([]);
  });

  it('readPlannerHistory respects maxLines', () => {
    for (let i = 0; i < 5; i++) appendPlannerHistory({ skill: `s${i}` });
    expect(readPlannerHistory(3)).toHaveLength(3);
  });
});
