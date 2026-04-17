/**
 * stats-aggregator.js — Aggregates data from token-history, orchestrator-log,
 * and rate-limits for the Stats dashboard tab.
 */

/**
 * @typedef {Object} DashboardStats
 * @property {import('./token-history').CycleEntry[]} cycleChart - Last 20 cycle snapshots
 * @property {{todayUsd: number, weekUsd: number, monthUsd: number, weekRuns: number, monthRuns: number}} costSummary
 * @property {Object<string, {total: number, done: number, failed: number}>} activityBySkill
 * @property {number} totalBranches - Branches created with changes
 * @property {Array<{project: string, count: number}>} projectHeatmap - Top 15 projects by run count
 */

/**
 * @typedef {Object} LiveCycleInfo
 * @property {number} usedPercent - Current 5h usage
 * @property {number} targetPercent - Pacing target usage
 * @property {number} progress - 0..1 cycle progress
 * @property {number} remainingMin - Minutes until cycle reset
 * @property {number} sevenDayPercent - 7-day usage
 * @property {string} action - Pacing action (burst|accelerate|pace|coast|wait)
 */

const store = require('./orchestrator-store');
const tokenHistory = require('./token-history');
const tokenMonitor = require('./token-monitor');

/**
 * Returns all dashboard data in a single object.
 * @returns {DashboardStats}
 */
function getDashboardStats() {
  // Last 20 cycles from token-history.jsonl
  const cycleChart = tokenHistory.readHistory(20);

  // Read all execution log entries
  const logEntries = store.readLog(5000);

  // Cost summary: today, week, month
  const now = Date.now();
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

    // Activity by skill
    if (entry.skill) {
      if (!activityBySkill[entry.skill]) {
        activityBySkill[entry.skill] = { total: 0, done: 0, failed: 0 };
      }
      activityBySkill[entry.skill].total++;
      if (entry.status === 'done') activityBySkill[entry.skill].done++;
      if (entry.status === 'failed') activityBySkill[entry.skill].failed++;
    }

    // Project heatmap
    if (entry.project) {
      projectCounts[entry.project] = (projectCounts[entry.project] || 0) + 1;
    }

    // Branches created
    if (entry.branch && entry.hasChanges) totalBranches++;
  }

  // Today's spend from store
  const config = store.load();
  const todayUsd = config.todaySpentUsd || 0;

  // Project heatmap: sorted desc, top 15
  const projectHeatmap = Object.entries(projectCounts)
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    cycleChart,
    costSummary: {
      todayUsd: Math.round(todayUsd * 100) / 100,
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

/**
 * Returns live cycle info for the real-time indicator.
 * @returns {LiveCycleInfo|null}
 */
function getLiveCycle() {
  const cycle = tokenMonitor.getCycleInfo();
  if (!cycle) return null;

  const config = store.load();
  const decision = tokenMonitor.getPacingDecision({
    pacingMaxTarget: config.pacingMaxTarget,
    pacingExponent: config.pacingExponent,
    sevenDayThrottle: config.sevenDayThrottle,
    sevenDayCaution: config.sevenDayCaution
  });

  return {
    usedPercent: cycle.usedPercent,
    targetPercent: decision.targetUsage || 0,
    progress: cycle.progress,
    remainingMin: cycle.remainingMin,
    sevenDayPercent: cycle.sevenDayPercent,
    action: decision.action
  };
}

module.exports = { getDashboardStats, getLiveCycle };
