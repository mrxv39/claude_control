import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Test in a temp directory to avoid touching real data
const TEST_DIR = path.join(os.tmpdir(), `claudio-test-th-${Date.now()}`);
const HISTORY_PATH = path.join(TEST_DIR, 'token-history.jsonl');

// Reimplement pure logic from token-history.js for testing

function readHistory(maxLines = 50) {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    const lines = fs.readFileSync(HISTORY_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function getStats(entries) {
  if (entries.length === 0) {
    return { count: 0, avgUsedPercent: 0, minUsedPercent: 0, maxUsedPercent: 0, avgCostUsd: 0, recentCycles: [] };
  }
  const percents = entries.map(e => e.fiveHourPercent);
  const costs = entries.map(e => e.costUsd).filter(c => c != null);
  return {
    count: entries.length,
    avgUsedPercent: Math.round(percents.reduce((a, b) => a + b, 0) / percents.length),
    minUsedPercent: Math.min(...percents),
    maxUsedPercent: Math.max(...percents),
    avgCostUsd: costs.length > 0 ? Math.round(costs.reduce((a, b) => a + b, 0) / costs.length * 100) / 100 : 0,
    recentCycles: entries.slice(-10)
  };
}

function shouldCapture(cycleInfo, rateLimits, lastSavedResetAt) {
  if (!cycleInfo || !rateLimits) return false;
  if (cycleInfo.remainingMin > 1) return false;
  if (cycleInfo.resetsAt === lastSavedResetAt) return false;
  if (cycleInfo.isStale) return false;
  return true;
}

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('token-history readHistory', () => {
  it('returns empty array if file does not exist', () => {
    expect(readHistory()).toEqual([]);
  });

  it('reads valid JSONL entries', () => {
    const entries = [
      { resetsAt: '2026-04-16T10:00:00Z', fiveHourPercent: 50, costUsd: 1.5 },
      { resetsAt: '2026-04-16T15:00:00Z', fiveHourPercent: 75, costUsd: 2.3 },
    ];
    fs.writeFileSync(HISTORY_PATH, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    const result = readHistory();
    expect(result).toHaveLength(2);
    expect(result[0].fiveHourPercent).toBe(50);
    expect(result[1].fiveHourPercent).toBe(75);
  });

  it('skips malformed lines', () => {
    fs.writeFileSync(HISTORY_PATH, '{"fiveHourPercent":50}\nNOT_JSON\n{"fiveHourPercent":80}\n');
    const result = readHistory();
    expect(result).toHaveLength(2);
    expect(result[0].fiveHourPercent).toBe(50);
    expect(result[1].fiveHourPercent).toBe(80);
  });

  it('limits to maxLines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ fiveHourPercent: i * 10 }));
    fs.writeFileSync(HISTORY_PATH, lines.join('\n') + '\n');
    const result = readHistory(3);
    expect(result).toHaveLength(3);
    expect(result[0].fiveHourPercent).toBe(70);
  });

  it('handles empty file', () => {
    fs.writeFileSync(HISTORY_PATH, '');
    expect(readHistory()).toEqual([]);
  });
});

describe('token-history getStats', () => {
  it('returns zeroes for empty entries', () => {
    const stats = getStats([]);
    expect(stats.count).toBe(0);
    expect(stats.avgUsedPercent).toBe(0);
    expect(stats.avgCostUsd).toBe(0);
  });

  it('computes correct averages', () => {
    const entries = [
      { fiveHourPercent: 40, costUsd: 1.0 },
      { fiveHourPercent: 60, costUsd: 2.0 },
      { fiveHourPercent: 80, costUsd: 3.0 },
    ];
    const stats = getStats(entries);
    expect(stats.count).toBe(3);
    expect(stats.avgUsedPercent).toBe(60);
    expect(stats.minUsedPercent).toBe(40);
    expect(stats.maxUsedPercent).toBe(80);
    expect(stats.avgCostUsd).toBe(2.0);
  });

  it('handles null costUsd', () => {
    const entries = [
      { fiveHourPercent: 50, costUsd: null },
      { fiveHourPercent: 70, costUsd: 1.5 },
    ];
    const stats = getStats(entries);
    expect(stats.avgCostUsd).toBe(1.5);
  });

  it('recentCycles returns last 10', () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({ fiveHourPercent: i }));
    const stats = getStats(entries);
    expect(stats.recentCycles).toHaveLength(10);
    expect(stats.recentCycles[0].fiveHourPercent).toBe(5);
  });
});

describe('token-history shouldCapture', () => {
  it('returns false if cycleInfo is null', () => {
    expect(shouldCapture(null, {})).toBe(false);
  });

  it('returns false if rateLimits is null', () => {
    expect(shouldCapture({ remainingMin: 0.5, resetsAt: 'x' }, null)).toBe(false);
  });

  it('returns false if remainingMin > 1', () => {
    expect(shouldCapture({ remainingMin: 5, resetsAt: 'x' }, {})).toBe(false);
  });

  it('returns false if already saved this cycle', () => {
    expect(shouldCapture({ remainingMin: 0.5, resetsAt: 'same' }, {}, 'same')).toBe(false);
  });

  it('returns false if stale', () => {
    expect(shouldCapture({ remainingMin: 0.5, resetsAt: 'x', isStale: true }, {})).toBe(false);
  });

  it('returns true for valid capture', () => {
    expect(shouldCapture({ remainingMin: 0.5, resetsAt: 'new' }, {}, 'old')).toBe(true);
  });
});
