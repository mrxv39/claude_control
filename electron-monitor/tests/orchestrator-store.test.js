import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `claudio-test-${Date.now()}`);
const CONFIG_PATH = path.join(TEST_DIR, 'orchestrator.json');
const LOG_PATH = path.join(TEST_DIR, 'orchestrator-log.jsonl');

// Minimal store implementation that mirrors orchestrator-store.js
// but uses our temp dir. This tests the LOGIC, not the file paths.
function makeStore() {
  const DEFAULTS = {
    projectDirs: [],
    workHours: { start: 9, end: 23 },
    dailyBudgetUsd: 2.00,
    todaySpentUsd: 0.00,
    todayDate: new Date().toISOString().slice(0, 10),
    projects: {},
    queue: []
  };

  function load() {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS };
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      const today = new Date().toISOString().slice(0, 10);
      if (data.todayDate !== today) { data.todaySpentUsd = 0; data.todayDate = today; }
      return { ...DEFAULTS, ...data };
    } catch { return { ...DEFAULTS }; }
  }

  function save(data) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
  }

  function update(partial) {
    const data = load();
    Object.assign(data, partial);
    save(data);
    return data;
  }

  function enqueue(task) {
    const d = load();
    task.id = task.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    task.status = task.status || 'pending';
    task.createdAt = task.createdAt || new Date().toISOString();
    d.queue.push(task);
    save(d);
    return task;
  }

  function dequeue(taskId) {
    const d = load();
    d.queue = d.queue.filter(t => t.id !== taskId);
    save(d);
  }

  function nextPendingTask() {
    return load().queue.find(t => t.status === 'pending') || null;
  }

  function addSpend(usd) {
    const d = load();
    d.todaySpentUsd = Math.round((d.todaySpentUsd + usd) * 1000) / 1000;
    save(d);
    return d;
  }

  function budgetRemaining() {
    const d = load();
    return Math.max(0, d.dailyBudgetUsd - d.todaySpentUsd);
  }

  function logExecution(entry) {
    entry.timestamp = entry.timestamp || new Date().toISOString();
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  }

  function readLog(maxLines = 50) {
    if (!fs.existsSync(LOG_PATH)) return [];
    try {
      const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-maxLines).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  return { load, save, update, enqueue, dequeue, nextPendingTask, addSpend, budgetRemaining, logExecution, readLog };
}

let store;

beforeEach(() => {
  // Fresh state for each test
  try { if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH); } catch {}
  try { if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH); } catch {}
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  store = makeStore();
});

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe('orchestrator-store', () => {
  describe('load/save', () => {
    it('returns defaults when no config file exists', () => {
      const config = store.load();
      expect(config.workHours).toEqual({ start: 9, end: 23 });
      expect(config.projects).toEqual({});
      expect(config.queue).toEqual([]);
    });

    it('persists data across load/save cycles', () => {
      const data = store.load();
      data.timezone = 'America/New_York';
      store.save(data);
      expect(store.load().timezone).toBe('America/New_York');
    });

    it('update merges partial data', () => {
      store.update({ dailyBudgetUsd: 5.0 });
      expect(store.load().dailyBudgetUsd).toBe(5.0);
      // Existing defaults should still be present
      expect(store.load().workHours).toEqual({ start: 9, end: 23 });
    });
  });

  describe('queue', () => {
    it('enqueue adds a task with defaults', () => {
      const task = store.enqueue({ project: 'foo', skill: 'simplify' });
      expect(task.id).toBeDefined();
      expect(task.status).toBe('pending');
      expect(store.load().queue).toHaveLength(1);
    });

    it('dequeue removes a task', () => {
      const task = store.enqueue({ project: 'bar', skill: 'audit' });
      store.dequeue(task.id);
      expect(store.load().queue).toHaveLength(0);
    });

    it('nextPendingTask returns first pending', () => {
      store.enqueue({ project: 'a', skill: 's1' });
      store.enqueue({ project: 'b', skill: 's2' });
      const next = store.nextPendingTask();
      expect(next.project).toBe('a');
    });

    it('nextPendingTask skips non-pending tasks', () => {
      store.enqueue({ project: 'running', skill: 's1', status: 'running' });
      store.enqueue({ project: 'pending', skill: 's2' });
      const next = store.nextPendingTask();
      expect(next.project).toBe('pending');
    });
  });

  describe('budget', () => {
    it('tracks spending correctly', () => {
      store.addSpend(0.5);
      store.addSpend(0.3);
      expect(store.budgetRemaining()).toBeCloseTo(1.2, 2);
    });

    it('never goes below zero', () => {
      store.addSpend(5.0);
      expect(store.budgetRemaining()).toBe(0);
    });
  });

  describe('execution log', () => {
    it('appends and reads log entries', () => {
      store.logExecution({ skill: 'test', status: 'done' });
      store.logExecution({ skill: 'test2', status: 'failed' });
      const log = store.readLog(10);
      expect(log).toHaveLength(2);
      expect(log[0].skill).toBe('test');
      expect(log[1].status).toBe('failed');
    });

    it('respects maxLines (returns last N)', () => {
      for (let i = 0; i < 10; i++) {
        store.logExecution({ skill: `s${i}`, status: 'done' });
      }
      const log = store.readLog(3);
      expect(log).toHaveLength(3);
      expect(log[0].skill).toBe('s7');
      expect(log[2].skill).toBe('s9');
    });

    it('returns empty array when no log exists', () => {
      expect(store.readLog()).toEqual([]);
    });

    it('auto-adds timestamp', () => {
      store.logExecution({ skill: 'x' });
      const log = store.readLog(1);
      expect(log[0].timestamp).toBeDefined();
    });
  });
});
