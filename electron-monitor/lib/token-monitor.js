/**
 * token-monitor.js — Detects user idle time by reading Claude session JSONL files.
 *
 * Scans ~/.claude/projects/ for recent user activity (last message timestamp).
 * Used to trigger autonomous task execution when the user is idle.
 */

/**
 * @typedef {Object} CycleInfo
 * @property {number} usedPercent - Current 5h usage %
 * @property {number} sevenDayPercent - 7-day usage %
 * @property {number} remainingMin - Minutes until cycle reset
 * @property {number} progress - 0..1 elapsed fraction of 5h cycle
 * @property {number} resetsAt - Unix timestamp (seconds) when cycle resets
 * @property {boolean} isStale - true if rate data is >10 min old
 */

/**
 * @typedef {Object} PacingDecision
 * @property {'burst'|'accelerate'|'pace'|'coast'|'wait'} action
 * @property {string} reason - Human-readable explanation
 * @property {CycleInfo} [cycle]
 * @property {number} [targetUsage] - Target % at current progress
 * @property {number} [delta] - targetUsage - usedPercent
 */

const fs = require('fs');
const path = require('path');

const PROJECTS_DIR = path.join(process.env.USERPROFILE, '.claude', 'projects');
const RATE_LIMITS_PATH = path.join(process.env.USERPROFILE, '.claude', 'claudio-state', 'rate-limits.json');

/** @type {{ts: Date|null, at: number}} */
let _activityCache = { ts: null, at: 0 };
const ACTIVITY_CACHE_TTL = 30 * 1000; // 30s — idle detection doesn't need sub-second precision

/**
 * Get the timestamp of the most recent user message across all sessions.
 * Reads the tail of each JSONL file looking for "type":"user" entries.
 * Results are cached for 30s to reduce I/O.
 * @returns {Date|null}
 */
function getLastUserActivity() {
  const now = Date.now();
  if (_activityCache.at && (now - _activityCache.at) < ACTIVITY_CACHE_TTL) {
    return _activityCache.ts;
  }

  if (!fs.existsSync(PROJECTS_DIR)) {
    _activityCache = { ts: null, at: now };
    return null;
  }

  let latestTs = null;

  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    // Sort by directory mtime (most recent first) and limit to top 15
    // to avoid scanning all 68+ project dirs every 30s
    const cutoff = now - 60 * 60 * 1000;
    const dirsWithMtime = [];
    for (const dir of projectDirs) {
      const dirPath = path.join(PROJECTS_DIR, dir.name);
      try {
        const stat = fs.statSync(dirPath);
        if (stat.mtimeMs >= cutoff) dirsWithMtime.push({ dirPath, mtimeMs: stat.mtimeMs });
      } catch { continue; }
    }
    dirsWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const topDirs = dirsWithMtime.slice(0, 15);

    for (const { dirPath } of topDirs) {
      let jsonlFiles;
      try {
        jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) continue;
        } catch { continue; }

        const ts = getLastUserTimestampFromFile(filePath);
        if (ts && (!latestTs || ts > latestTs)) {
          latestTs = ts;
        }
      }
    }
  } catch {}

  _activityCache = { ts: latestTs, at: now };
  return latestTs;
}

/**
 * Read the tail of a JSONL file and find the last "type":"user" timestamp.
 * Only reads the last 8KB for performance.
 * @param {string} filePath
 * @returns {Date|null}
 */
function getLastUserTimestampFromFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;

    // Read last 8KB
    const readSize = Math.min(stat.size, 8192);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(Boolean);

    // Search from end for last user message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'user') {
          // Use file mtime as proxy if no timestamp field
          if (obj.timestamp) return new Date(obj.timestamp);
          // Use the message timestamp from the JSONL position
          return new Date(stat.mtimeMs - (lines.length - 1 - i) * 1000);
        }
      } catch {}
    }

    // If no user message in tail, use file mtime as rough estimate
    // (the file was at least written to recently)
    return null;
  } catch {
    return null;
  }
}

/**
 * Get minutes since the last user activity.
 * @returns {number} Minutes idle, or Infinity if no activity detected
 */
function getIdleMinutes() {
  const lastActivity = getLastUserActivity();
  if (!lastActivity) return Infinity;
  return (Date.now() - lastActivity.getTime()) / (60 * 1000);
}

/** @type {{result: boolean, at: number}} */
let _recentWriteCache = { result: false, at: 0 };
const RECENT_WRITE_CACHE_TTL = 10 * 1000; // 10s — avoids re-scanning dirs on every call

/**
 * Check if the user is considered idle (no activity for N minutes).
 * Uses both JSONL timestamps AND file modification times for reliability.
 * @param {number} [minutes=15]
 * @returns {boolean}
 */
function isUserIdle(minutes = 15) {
  const idleTime = getIdleMinutes();
  if (idleTime < minutes) return false;

  // Secondary: check if any JSONL was modified in the last 2 min (user mid-prompt).
  // Cached for 10s to avoid redundant directory walks when called multiple times per tick.
  const now = Date.now();
  if (_recentWriteCache.at && (now - _recentWriteCache.at) < RECENT_WRITE_CACHE_TTL) {
    return !_recentWriteCache.result;
  }

  let hasRecentWrite = false;
  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    const cutoff = now - 2 * 60 * 1000;
    for (const dir of projectDirs) {
      const dirPath = path.join(PROJECTS_DIR, dir.name);
      try {
        const dirStat = fs.statSync(dirPath);
        if (dirStat.mtimeMs < cutoff) continue;

        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const stat = fs.statSync(path.join(dirPath, file));
          if (stat.mtimeMs > cutoff) { hasRecentWrite = true; break; }
        }
        if (hasRecentWrite) break;
      } catch {}
    }
  } catch {}

  _recentWriteCache = { result: hasRecentWrite, at: now };
  return !hasRecentWrite;
}

/** @type {{data: import('./statusline-writer').RateLimitsOutput|null, at: number}} */
let _rateLimitsCache = { data: null, at: 0 };
const RATE_LIMITS_CACHE_TTL = 5 * 1000; // 5s — sufficient since file updates every ~10s

/**
 * Read rate limits from the shared file written by statusline-writer.js.
 * @returns {import('./statusline-writer').RateLimitsOutput|null} null if stale or missing
 */
function getRateLimits() {
  const now = Date.now();
  if (_rateLimitsCache.at && (now - _rateLimitsCache.at) < RATE_LIMITS_CACHE_TTL) {
    return _rateLimitsCache.data;
  }

  try {
    if (!fs.existsSync(RATE_LIMITS_PATH)) {
      _rateLimitsCache = { data: null, at: now };
      return null;
    }
    const raw = fs.readFileSync(RATE_LIMITS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // Consider stale if older than 10 minutes
    if (data.updatedAt && (now - data.updatedAt) > 10 * 60 * 1000) {
      _rateLimitsCache = { data: null, at: now };
      return null;
    }
    _rateLimitsCache = { data, at: now };
    return data;
  } catch {
    _rateLimitsCache = { data: null, at: now };
    return null;
  }
}

/**
 * Get enriched cycle state from rate limits data.
 * Derives progress (0..1), remaining minutes, and staleness from resetsAt.
 * @returns {CycleInfo|null}
 */
function getCycleInfo() {
  const rl = getRateLimits();
  if (!rl || !rl.fiveHour || !rl.sevenDay) return null;

  const now = Date.now() / 1000; // unix seconds
  const resetsAt = rl.fiveHour.resetsAt;
  const cycleLen = 5 * 3600;
  const cycleStart = resetsAt - cycleLen;
  const elapsed = Math.max(0, now - cycleStart);
  const remaining = Math.max(0, resetsAt - now);
  const progress = Math.min(1, elapsed / cycleLen);

  return {
    usedPercent: rl.fiveHour.usedPercent,
    sevenDayPercent: rl.sevenDay.usedPercent,
    remainingMin: Math.round(remaining / 60),
    progress,
    resetsAt,
    isStale: !rl.updatedAt || (Date.now() - rl.updatedAt) > 10 * 60 * 1000
  };
}

/**
 * Core pacing function. Compares actual usage against an ideal curve
 * parameterized by time elapsed in the 5h cycle.
 *
 * Curve: targetUsage = progress^exponent × maxTarget
 * @param {{pacingMaxTarget?: number, pacingExponent?: number, sevenDayThrottle?: number, sevenDayCaution?: number}} [config]
 * @returns {PacingDecision}
 */
function getPacingDecision(config = {}) {
  const maxTarget = config.pacingMaxTarget || 95;
  const exponent = config.pacingExponent || 0.6;
  const sevenDayThrottle = config.sevenDayThrottle || 80;
  const sevenDayCaution = config.sevenDayCaution || 60;

  const cycle = getCycleInfo();
  if (!cycle) return { action: 'wait', reason: 'sin datos de rate limit' };

  // 7-day guard
  if (cycle.sevenDayPercent > sevenDayThrottle) {
    return { action: 'coast', reason: `7d al ${cycle.sevenDayPercent}% (>${sevenDayThrottle}%)`, cycle, targetUsage: 0, delta: 0 };
  }

  // 7-day caution: reduce target
  let effectiveMax = maxTarget;
  if (cycle.sevenDayPercent > sevenDayCaution) {
    effectiveMax = Math.min(effectiveMax, 70);
  }

  const targetUsage = Math.round(Math.pow(cycle.progress, exponent) * effectiveMax);
  const delta = targetUsage - cycle.usedPercent;

  let action, reason;
  if (cycle.remainingMin <= 30 && delta > 10) {
    action = 'burst';
    reason = `${cycle.remainingMin}m left, ${delta}% bajo target`;
  } else if (delta > 15) {
    action = 'burst';
    reason = `${delta}% bajo target`;
  } else if (delta > 5) {
    action = 'accelerate';
    reason = `${delta}% bajo target`;
  } else if (delta > -5) {
    action = 'pace';
    reason = `on track (delta ${delta > 0 ? '+' : ''}${delta}%)`;
  } else {
    action = 'coast';
    reason = `${-delta}% sobre target`;
  }

  return { action, reason, cycle, targetUsage, delta };
}

/**
 * Recommended scheduler tick interval based on pacing action.
 * @param {string} action - Pacing action
 * @returns {number} Interval in milliseconds
 */
function getRecommendedInterval(action) {
  switch (action) {
    case 'burst':      return 15 * 1000;
    case 'accelerate': return 30 * 1000;
    case 'pace':       return 60 * 1000;
    case 'coast':      return 120 * 1000;
    default:           return 60 * 1000;
  }
}

/**
 * Check if there's spare capacity in the 5-hour window.
 * @returns {boolean} true if pacing says execute (not coast/wait)
 */
function hasSpareCapacity() {
  const decision = getPacingDecision();
  return decision.action !== 'wait' && decision.action !== 'coast';
}

module.exports = {
  getLastUserActivity, getIdleMinutes, isUserIdle,
  getRateLimits, hasSpareCapacity,
  getCycleInfo, getPacingDecision, getRecommendedInterval
};
