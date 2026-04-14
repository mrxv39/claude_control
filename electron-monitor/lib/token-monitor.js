/**
 * token-monitor.js — Detects user idle time by reading Claude session JSONL files.
 *
 * Scans ~/.claude/projects/ for recent user activity (last message timestamp).
 * Used to trigger autonomous task execution when the user is idle.
 */

const fs = require('fs');
const path = require('path');

const PROJECTS_DIR = path.join(process.env.USERPROFILE, '.claude', 'projects');
const RATE_LIMITS_PATH = path.join(process.env.USERPROFILE, '.claude', 'claudio-state', 'rate-limits.json');

/**
 * Get the timestamp of the most recent user message across all sessions.
 * Reads the tail of each JSONL file looking for "type":"user" entries.
 * Returns Date or null if no recent activity found.
 */
function getLastUserActivity() {
  if (!fs.existsSync(PROJECTS_DIR)) return null;

  let latestTs = null;

  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of projectDirs) {
      const dirPath = path.join(PROJECTS_DIR, dir.name);
      let jsonlFiles;
      try {
        jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file);
        const ts = getLastUserTimestampFromFile(filePath);
        if (ts && (!latestTs || ts > latestTs)) {
          latestTs = ts;
        }
      }
    }
  } catch {}

  return latestTs;
}

/**
 * Read the tail of a JSONL file and find the last "type":"user" timestamp.
 * Only reads the last 8KB for performance.
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
 * Returns Infinity if no activity detected.
 */
function getIdleMinutes() {
  const lastActivity = getLastUserActivity();
  if (!lastActivity) return Infinity;
  return (Date.now() - lastActivity.getTime()) / (60 * 1000);
}

/**
 * Check if the user is considered idle (no activity for N minutes).
 * Uses both JSONL timestamps AND file modification times for reliability.
 */
function isUserIdle(minutes = 15) {
  // Primary: check JSONL user messages
  const idleTime = getIdleMinutes();
  if (idleTime < minutes) return false;

  // Secondary: check if any JSONL was modified recently (user might be mid-prompt)
  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of projectDirs) {
      const dirPath = path.join(PROJECTS_DIR, dir.name);
      try {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const stat = fs.statSync(path.join(dirPath, file));
          const fileAge = (Date.now() - stat.mtimeMs) / (60 * 1000);
          if (fileAge < 2) return false; // file modified in last 2 min → not idle
        }
      } catch {}
    }
  } catch {}

  return true;
}

/**
 * Read rate limits from the shared file written by statusline-writer.js.
 * Returns { fiveHour: { usedPercent, resetsAt }, sevenDay: { usedPercent, resetsAt }, updatedAt }
 * or null if no data available.
 */
function getRateLimits() {
  try {
    if (!fs.existsSync(RATE_LIMITS_PATH)) return null;
    const raw = fs.readFileSync(RATE_LIMITS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // Consider stale if older than 10 minutes
    if (data.updatedAt && (Date.now() - data.updatedAt) > 10 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Check if there's spare capacity in the 5-hour window.
 * @param {number} threshold — max % used to consider "spare" (default 50)
 * @returns {boolean} true if usage < threshold
 */
function hasSpareCapacity(threshold = 50) {
  const rl = getRateLimits();
  if (!rl) return false; // no data → be conservative
  return rl.fiveHour.usedPercent < threshold;
}

module.exports = { getLastUserActivity, getIdleMinutes, isUserIdle, getRateLimits, hasSpareCapacity };
