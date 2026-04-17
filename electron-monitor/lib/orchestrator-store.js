/**
 * orchestrator-store.js — Persistent config & state for the orchestrator.
 *
 * Files:
 *   ~/.claude/claudio-state/orchestrator.json   — config + project data + queue
 *   ~/.claude/claudio-state/orchestrator-log.jsonl — execution history (append-only)
 */

/**
 * @typedef {Object} QueueTask
 * @property {string} id - Unique task ID
 * @property {string} project - Project name
 * @property {string} skill - Skill to execute
 * @property {string} [projectPath] - Absolute path to project
 * @property {'pending'|'running'|'done'|'failed'} status
 * @property {string} createdAt - ISO timestamp
 * @property {string} [startedAt] - ISO timestamp
 * @property {string} [completedAt] - ISO timestamp
 * @property {string} [branch] - Git branch created
 * @property {number} [costUsd]
 * @property {number} [duration] - Seconds
 * @property {boolean} [hasChanges]
 * @property {boolean} [auto] - Auto-enqueued by scheduler
 * @property {boolean} [retried]
 * @property {string} [mode] - Execution mode (off-hours|idle|capacity)
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} skill
 * @property {'done'|'failed'} status
 * @property {string} [project]
 * @property {string} [branch]
 * @property {string} [taskId]
 * @property {string} timestamp - ISO timestamp
 * @property {number} [costUsd]
 * @property {number} [duration]
 * @property {boolean} [hasChanges]
 */

/**
 * @typedef {Object} OrchestratorConfig
 * @property {string[]} projectDirs
 * @property {{start: number, end: number}} workHours
 * @property {number} dailyBudgetUsd
 * @property {number} todaySpentUsd
 * @property {string} todayDate - YYYY-MM-DD
 * @property {string|null} lastFullScan - ISO timestamp
 * @property {string[]} blacklist - Project names to ignore
 * @property {{high: number, medium: number, low: number}} priorityRules - Max days per priority tier
 * @property {Object<string, 'high'|'medium'|'low'|'ignored'>} priorityOverrides
 * @property {boolean} idleEnabled
 * @property {number} idleMinutes
 * @property {boolean} capacityEnabled
 * @property {number} capacityThreshold
 * @property {boolean} pacingEnabled
 * @property {number} pacingMaxTarget - Max % to aim for in 5h cycle
 * @property {number} pacingExponent - Curve shape (lower = more conservative early)
 * @property {number} sevenDayThrottle - Coast when 7d > this %
 * @property {number} sevenDayCaution - Reduce target when 7d > this %
 * @property {string} timezone - IANA timezone (e.g. 'Europe/Madrid')
 * @property {Object<string, Object>} projects - Project name -> project data
 * @property {QueueTask[]} queue
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.env.USERPROFILE, '.claude', 'claudio-state');
const CONFIG_PATH = path.join(STATE_DIR, 'orchestrator.json');
const LOG_PATH = path.join(STATE_DIR, 'orchestrator-log.jsonl');

const DEFAULT_PROJECT_DIR = path.join(process.env.USERPROFILE, 'Desktop', 'proyectos');

const DEFAULTS = {
  projectDirs: [DEFAULT_PROJECT_DIR],
  workHours: { start: 9, end: 23 },
  dailyBudgetUsd: 2.00,
  todaySpentUsd: 0.00,
  todayDate: new Date().toISOString().slice(0, 10),
  lastFullScan: null,
  blacklist: ['substract'],
  priorityRules: { high: 7, medium: 30, low: 90 },
  priorityOverrides: {},  // { projectName: 'high'|'medium'|'low'|'ignored' }
  idleEnabled: true,
  idleMinutes: 15,
  capacityEnabled: true,
  capacityThreshold: 50,  // fallback when pacing disabled
  pacingEnabled: true,
  pacingMaxTarget: 95,    // max % to aim for in 5h cycle
  pacingExponent: 0.6,    // curve shape: lower = more conservative early
  sevenDayThrottle: 80,   // forced coast when 7d > this %
  sevenDayCaution: 60,    // reduce maxTarget when 7d > this %
  timezone: 'Europe/Madrid',
  projects: {},
  queue: []
};

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

/** @returns {OrchestratorConfig} Config merged with defaults, daily spend reset if date changed. */
function load() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // Reset daily spend if date changed
    const today = new Date().toISOString().slice(0, 10);
    if (data.todayDate !== today) {
      data.todaySpentUsd = 0;
      data.todayDate = today;
    }
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

/** @param {OrchestratorConfig} data */
function save(data) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/** @param {Partial<OrchestratorConfig>} partial @returns {OrchestratorConfig} */
function update(partial) {
  const data = load();
  Object.assign(data, partial);
  save(data);
  return data;
}

// --- Project helpers ---

/** @returns {Object<string, Object>} All projects keyed by name */
function getProjects() {
  return load().projects;
}

/**
 * @param {string} name
 * @param {Object} info - Project data to store
 */
function setProject(name, info) {
  const data = load();
  data.projects[name] = info;
  save(data);
}

/** @param {Object<string, Object>} projects */
function setProjects(projects) {
  const data = load();
  data.projects = projects;
  save(data);
}

// --- Queue helpers ---

/** @returns {QueueTask[]} */
function getQueue() {
  return load().queue;
}

/** @param {{project: string, skill: string, id?: string, status?: string}} task @returns {Object} Task with id, status, createdAt */
function enqueue(task) {
  const data = load();
  task.id = task.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  task.status = task.status || 'pending';
  task.createdAt = task.createdAt || new Date().toISOString();
  data.queue.push(task);
  save(data);
  return task;
}

/** @param {string} taskId */
function dequeue(taskId) {
  const data = load();
  data.queue = data.queue.filter(t => t.id !== taskId);
  save(data);
}

/**
 * @param {string} taskId
 * @param {Partial<QueueTask>} partial
 * @returns {QueueTask|null}
 */
function updateQueueTask(taskId, partial) {
  const data = load();
  const task = data.queue.find(t => t.id === taskId);
  if (task) Object.assign(task, partial);
  save(data);
  return task || null;
}

/** @returns {QueueTask|null} */
function nextPendingTask() {
  const data = load();
  return data.queue.find(t => t.status === 'pending') || null;
}

// --- Budget helpers ---

/**
 * Add to today's spend. Resets if date changed.
 * @param {number} usd
 * @returns {OrchestratorConfig}
 */
function addSpend(usd) {
  const data = load();
  const today = new Date().toISOString().slice(0, 10);
  if (data.todayDate !== today) {
    data.todaySpentUsd = 0;
    data.todayDate = today;
  }
  data.todaySpentUsd = Math.round((data.todaySpentUsd + usd) * 1000) / 1000;
  save(data);
  return data;
}

/** @returns {number} Remaining daily budget in USD */
function budgetRemaining() {
  const data = load();
  const today = new Date().toISOString().slice(0, 10);
  if (data.todayDate !== today) return data.dailyBudgetUsd;
  return Math.max(0, data.dailyBudgetUsd - data.todaySpentUsd);
}

// --- Execution log (append-only JSONL) ---

/** @param {{skill: string, status: string, project?: string, branch?: string, taskId?: string}} entry */
function logExecution(entry) {
  ensureDir();
  entry.timestamp = entry.timestamp || new Date().toISOString();
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
}

/** @param {number} [maxLines=50] @returns {Object[]} Last N log entries */
function readLog(maxLines = 50) {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  load, save, update,
  getProjects, setProject, setProjects,
  getQueue, enqueue, dequeue, updateQueueTask, nextPendingTask,
  addSpend, budgetRemaining,
  logExecution, readLog,
  CONFIG_PATH, LOG_PATH, STATE_DIR
};
