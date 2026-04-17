import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Pure logic from lib/telemetry.js — isAllowedType, scrubPayload, persist/drain.
// Kept in sync with source; full module tests require electron at runtime.

const EVENT_WHITELIST = new Set([
  'app_start', 'app_stop', 'panel_toggle', 'panel_tab_view',
  'skill_run', 'skill_enqueue', 'scheduler_pause', 'scheduler_resume',
  'session_focus', 'session_idle', 'update_available', 'update_applied', 'error'
]);

function isAllowedType(type) {
  return EVENT_WHITELIST.has(type);
}

function scrubPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  const denied = new Set(['cwd', 'path', 'projectPath', 'branch', 'file', 'prompt', 'content', 'output', 'token', 'apiKey']);
  for (const [k, v] of Object.entries(payload)) {
    if (denied.has(k)) continue;
    if (k === 'stack' && typeof v === 'string') {
      out[k] = v.replace(/[A-Z]:\\[^\s)]+/g, '<path>').replace(/\/[^\s)]+/g, '<path>');
      continue;
    }
    out[k] = v;
  }
  return out;
}

describe('telemetry isAllowedType', () => {
  it('accepts known types', () => {
    expect(isAllowedType('app_start')).toBe(true);
    expect(isAllowedType('skill_run')).toBe(true);
    expect(isAllowedType('panel_toggle')).toBe(true);
    expect(isAllowedType('error')).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(isAllowedType('user_typed_something')).toBe(false);
    expect(isAllowedType('')).toBe(false);
    expect(isAllowedType('SKILL_RUN')).toBe(false); // case-sensitive
  });

  it('rejects prototype pollution attempts', () => {
    expect(isAllowedType('__proto__')).toBe(false);
    expect(isAllowedType('constructor')).toBe(false);
  });
});

describe('telemetry scrubPayload', () => {
  it('returns empty object for null/undefined', () => {
    expect(scrubPayload(null)).toEqual({});
    expect(scrubPayload(undefined)).toEqual({});
  });

  it('strips denied fields', () => {
    const payload = { skill: 'simplify', cwd: 'C:\\secret\\path', branch: 'feat/foo' };
    expect(scrubPayload(payload)).toEqual({ skill: 'simplify' });
  });

  it('strips path, projectPath, file, prompt, content, output, token, apiKey', () => {
    const payload = {
      keep: 1, path: 'x', projectPath: 'y', file: 'z',
      prompt: 'hi', content: 'data', output: 'log', token: 'tk', apiKey: 'sk'
    };
    expect(scrubPayload(payload)).toEqual({ keep: 1 });
  });

  it('scrubs Windows paths in stack traces', () => {
    const stack = 'Error: boom\n  at foo (C:\\Users\\u\\proj\\file.js:10:5)';
    const out = scrubPayload({ stack });
    expect(out.stack).toContain('<path>');
    expect(out.stack).not.toContain('Users');
    expect(out.stack).toContain('Error: boom');
  });

  it('scrubs Unix paths in stack traces', () => {
    const stack = 'Error: boom\n  at foo (/home/u/proj/file.js:10:5)';
    const out = scrubPayload({ stack });
    expect(out.stack).toContain('<path>');
    expect(out.stack).not.toContain('home');
  });

  it('preserves non-denied scalar fields', () => {
    const payload = { durationSeconds: 42, status: 'done', exitCode: 0, version: '1.2.3' };
    expect(scrubPayload(payload)).toEqual(payload);
  });
});

// JSONL queue persistence — matches behaviour of persistEvent / drainPersistedEvents
describe('telemetry queue file', () => {
  const TEST_DIR = path.join(os.tmpdir(), `claudio-test-tl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const QUEUE_PATH = path.join(TEST_DIR, 'telemetry-queue.jsonl');

  function persistEvent(event) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.appendFileSync(QUEUE_PATH, JSON.stringify(event) + '\n', 'utf-8');
  }

  function drainPersistedEvents() {
    if (!fs.existsSync(QUEUE_PATH)) return [];
    const content = fs.readFileSync(QUEUE_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    fs.unlinkSync(QUEUE_PATH);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  function rotateQueueFile(cap) {
    if (!fs.existsSync(QUEUE_PATH)) return;
    const content = fs.readFileSync(QUEUE_PATH, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length <= cap) return;
    const trimmed = lines.slice(-cap);
    fs.writeFileSync(QUEUE_PATH, trimmed.join('\n') + '\n', 'utf-8');
  }

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('drain returns empty for missing file', () => {
    expect(drainPersistedEvents()).toEqual([]);
  });

  it('persists and drains events round-trip', () => {
    const ev1 = { type: 'app_start', payload: { version: '1.0.0' }, timestamp: '2026-01-01T00:00:00Z' };
    const ev2 = { type: 'panel_toggle', payload: { open: true }, timestamp: '2026-01-01T00:00:01Z' };
    persistEvent(ev1);
    persistEvent(ev2);
    const drained = drainPersistedEvents();
    expect(drained).toHaveLength(2);
    expect(drained[0].type).toBe('app_start');
    expect(drained[1].payload.open).toBe(true);
  });

  it('drain removes the file (caller responsible for re-persist on failure)', () => {
    persistEvent({ type: 'app_start', payload: {}, timestamp: 'now' });
    drainPersistedEvents();
    expect(fs.existsSync(QUEUE_PATH)).toBe(false);
  });

  it('skips malformed JSONL lines', () => {
    fs.writeFileSync(QUEUE_PATH, '{"type":"app_start"}\nNOT_JSON\n{"type":"app_stop"}\n');
    const drained = drainPersistedEvents();
    expect(drained).toHaveLength(2);
    expect(drained[0].type).toBe('app_start');
    expect(drained[1].type).toBe('app_stop');
  });

  it('rotates file when over cap (FIFO)', () => {
    for (let i = 0; i < 10; i++) persistEvent({ type: 'x', payload: { i }, timestamp: String(i) });
    rotateQueueFile(3);
    const remaining = drainPersistedEvents();
    expect(remaining).toHaveLength(3);
    expect(remaining[0].payload.i).toBe(7); // kept the last 3
    expect(remaining[2].payload.i).toBe(9);
  });

  it('rotate is no-op when under cap', () => {
    for (let i = 0; i < 3; i++) persistEvent({ type: 'x', payload: { i }, timestamp: String(i) });
    rotateQueueFile(10);
    const remaining = drainPersistedEvents();
    expect(remaining).toHaveLength(3);
  });
});

// Integration: flush triggers based on queue size threshold
describe('telemetry flush trigger logic', () => {
  function shouldFlushNow(queueLength, threshold) {
    return queueLength >= threshold;
  }

  it('does not flush under threshold', () => {
    expect(shouldFlushNow(5, 20)).toBe(false);
    expect(shouldFlushNow(19, 20)).toBe(false);
  });

  it('flushes at threshold', () => {
    expect(shouldFlushNow(20, 20)).toBe(true);
  });

  it('flushes above threshold', () => {
    expect(shouldFlushNow(100, 20)).toBe(true);
  });

  it('never flushes empty queue', () => {
    expect(shouldFlushNow(0, 1)).toBe(false);
  });
});

// Heartbeat delta math
describe('telemetry heartbeat delta', () => {
  function deltaSeconds(nowMs, lastMs) {
    if (!lastMs) return 0;
    return Math.round((nowMs - lastMs) / 1000);
  }

  it('returns 0 when no previous heartbeat', () => {
    expect(deltaSeconds(Date.now(), 0)).toBe(0);
  });

  it('rounds seconds correctly', () => {
    expect(deltaSeconds(1_000_000_000 + 60_000, 1_000_000_000)).toBe(60);
  });

  it('handles sub-second deltas', () => {
    expect(deltaSeconds(1_000_000_499, 1_000_000_000)).toBe(0);
    expect(deltaSeconds(1_000_000_500, 1_000_000_000)).toBe(1);
  });
});
