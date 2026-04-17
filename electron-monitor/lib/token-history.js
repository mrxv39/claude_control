/**
 * token-history.js — Captures end-of-cycle token usage snapshots.
 *
 * Appends one line to token-history.jsonl when the 5h rate-limit cycle
 * is about to reset (≤1 min remaining). Used for historical tracking
 * of average token usage per cycle.
 */

/**
 * @typedef {Object} CycleEntry
 * @property {number} resetsAt - Unix timestamp when the 5h cycle resets
 * @property {string} capturedAt - ISO timestamp of capture
 * @property {number} fiveHourPercent - Usage % at capture
 * @property {number} sevenDayPercent - 7-day usage % at capture
 * @property {number|null} costUsd - Session cost at capture
 * @property {string|null} model - Model in use at capture
 */

/**
 * @typedef {Object} CycleStats
 * @property {number} count - Total recorded cycles
 * @property {number} avgUsedPercent - Average 5h usage
 * @property {number} minUsedPercent
 * @property {number} maxUsedPercent
 * @property {number} avgCostUsd - Average cost per cycle
 * @property {CycleEntry[]} recentCycles - Last 10 entries
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.env.USERPROFILE, '.claude', 'claudio-state');
const HISTORY_PATH = path.join(STATE_DIR, 'token-history.jsonl');

/** @type {number|null} */
let lastSavedResetAt = null;

let _dirEnsured = false;
function ensureDir() {
  if (_dirEnsured) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  _dirEnsured = true;
}

/**
 * On startup, read the last saved entry to avoid duplicates after restart.
 */
function initLastSaved() {
  if (!fs.existsSync(HISTORY_PATH)) return;
  try {
    const lines = fs.readFileSync(HISTORY_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;
    const last = JSON.parse(lines[lines.length - 1]);
    lastSavedResetAt = last.resetsAt || null;
  } catch {
    // Corrupted file — start fresh
  }
}

/**
 * Called on every scheduler tick. Captures a snapshot if the cycle
 * is about to reset and we haven't already saved this cycle.
 * @param {{remainingMin: number, resetsAt: number, usedPercent: number, sevenDayPercent: number, isStale: boolean}} cycleInfo
 * @param {RateLimitsOutput} rateLimits
 * @returns {boolean} true if a snapshot was captured
 */
function maybeCaptureCycleEnd(cycleInfo, rateLimits) {
  if (!cycleInfo || !rateLimits) return false;
  if (cycleInfo.remainingMin > 1) return false;
  if (cycleInfo.resetsAt === lastSavedResetAt) return false;
  if (cycleInfo.isStale) return false;

  const entry = {
    resetsAt: cycleInfo.resetsAt,
    capturedAt: new Date().toISOString(),
    fiveHourPercent: cycleInfo.usedPercent,
    sevenDayPercent: cycleInfo.sevenDayPercent,
    costUsd: rateLimits.cost ? rateLimits.cost.totalUsd : null,
    model: rateLimits.model || null
  };

  ensureDir();
  fs.appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  lastSavedResetAt = cycleInfo.resetsAt;
  return true;
}

/**
 * Read the last N entries from the history file.
 * @param {number} [maxLines=50]
 * @returns {CycleEntry[]}
 */
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

/**
 * Compute stats over recorded cycles.
 * @returns {CycleStats}
 */
function getStats() {
  const entries = readHistory(500);
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

module.exports = { initLastSaved, maybeCaptureCycleEnd, readHistory, getStats, HISTORY_PATH };
