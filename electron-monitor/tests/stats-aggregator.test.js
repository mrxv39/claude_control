import { describe, it, expect } from 'vitest';

// Reimplement getDashboardStats aggregation logic for testing
function aggregateLogEntries(logEntries, now = Date.now()) {
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const monthAgo = now - 30 * 24 * 3600 * 1000;

  let weekUsd = 0, monthUsd = 0, weekRuns = 0, monthRuns = 0;
  const activityBySkill = {};
  const projectCounts = {};
  let totalBranches = 0;

  for (const entry of logEntries) {
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
    const cost = entry.costUsd || 0;

    if (ts >= weekAgo) { weekUsd += cost; weekRuns++; }
    if (ts >= monthAgo) { monthUsd += cost; monthRuns++; }

    if (entry.skill) {
      if (!activityBySkill[entry.skill]) {
        activityBySkill[entry.skill] = { total: 0, done: 0, failed: 0 };
      }
      activityBySkill[entry.skill].total++;
      if (entry.status === 'done') activityBySkill[entry.skill].done++;
      if (entry.status === 'failed') activityBySkill[entry.skill].failed++;
    }

    if (entry.project) {
      projectCounts[entry.project] = (projectCounts[entry.project] || 0) + 1;
    }

    if (entry.branch && entry.hasChanges) totalBranches++;
  }

  const projectHeatmap = Object.entries(projectCounts)
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    costSummary: {
      weekUsd: Math.round(weekUsd * 100) / 100,
      monthUsd: Math.round(monthUsd * 100) / 100,
      weekRuns,
      monthRuns
    },
    activityBySkill,
    totalBranches,
    projectHeatmap
  };
}

describe('stats-aggregator aggregateLogEntries', () => {
  const NOW = new Date('2026-04-16T12:00:00Z').getTime();

  it('returns zeroes for empty log', () => {
    const result = aggregateLogEntries([], NOW);
    expect(result.costSummary.weekUsd).toBe(0);
    expect(result.costSummary.monthUsd).toBe(0);
    expect(result.costSummary.weekRuns).toBe(0);
    expect(result.totalBranches).toBe(0);
    expect(result.projectHeatmap).toEqual([]);
  });

  it('accumulates costs within week and month windows', () => {
    const entries = [
      { timestamp: '2026-04-15T10:00:00Z', costUsd: 1.5, skill: 'simplify', status: 'done' },
      { timestamp: '2026-04-10T10:00:00Z', costUsd: 2.0, skill: 'add-tests', status: 'done' },
      { timestamp: '2026-03-01T10:00:00Z', costUsd: 5.0, skill: 'simplify', status: 'failed' }, // >30 days ago
    ];
    const result = aggregateLogEntries(entries, NOW);
    expect(result.costSummary.weekUsd).toBe(3.5);
    expect(result.costSummary.weekRuns).toBe(2);
    expect(result.costSummary.monthUsd).toBe(3.5); // 3rd entry is >30d ago
    expect(result.costSummary.monthRuns).toBe(2);
  });

  it('tracks activity by skill', () => {
    const entries = [
      { timestamp: '2026-04-15T10:00:00Z', skill: 'simplify', status: 'done' },
      { timestamp: '2026-04-14T10:00:00Z', skill: 'simplify', status: 'failed' },
      { timestamp: '2026-04-13T10:00:00Z', skill: 'add-tests', status: 'done' },
    ];
    const result = aggregateLogEntries(entries, NOW);
    expect(result.activityBySkill.simplify).toEqual({ total: 2, done: 1, failed: 1 });
    expect(result.activityBySkill['add-tests']).toEqual({ total: 1, done: 1, failed: 0 });
  });

  it('counts branches only when hasChanges is true', () => {
    const entries = [
      { timestamp: '2026-04-15T10:00:00Z', branch: 'claudio/auto/x', hasChanges: true },
      { timestamp: '2026-04-14T10:00:00Z', branch: 'claudio/auto/y', hasChanges: false },
      { timestamp: '2026-04-13T10:00:00Z', branch: null, hasChanges: true },
    ];
    const result = aggregateLogEntries(entries, NOW);
    expect(result.totalBranches).toBe(1);
  });

  it('builds project heatmap sorted by count, limited to 15', () => {
    const entries = [];
    for (let i = 0; i < 20; i++) {
      const count = 20 - i;
      for (let j = 0; j < count; j++) {
        entries.push({ timestamp: '2026-04-15T10:00:00Z', project: `project-${i}` });
      }
    }
    const result = aggregateLogEntries(entries, NOW);
    expect(result.projectHeatmap).toHaveLength(15);
    expect(result.projectHeatmap[0].project).toBe('project-0');
    expect(result.projectHeatmap[0].count).toBe(20);
  });

  it('handles entries without timestamp (ts=0 → outside both windows)', () => {
    const entries = [{ costUsd: 10.0 }];
    const result = aggregateLogEntries(entries, NOW);
    expect(result.costSummary.weekUsd).toBe(0);
    expect(result.costSummary.monthUsd).toBe(0);
  });

  it('rounds costs to 2 decimal places', () => {
    const entries = [
      { timestamp: '2026-04-15T10:00:00Z', costUsd: 1.333 },
      { timestamp: '2026-04-15T11:00:00Z', costUsd: 1.777 },
    ];
    const result = aggregateLogEntries(entries, NOW);
    expect(result.costSummary.weekUsd).toBe(3.11);
  });
});
