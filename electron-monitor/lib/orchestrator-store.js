/**
 * orchestrator-store.js — Persistent config & state for the orchestrator.
 *
 * Files:
 *   ~/.claude/claudio-state/orchestrator.json   — config + project data + queue
 *   ~/.claude/claudio-state/orchestrator-log.jsonl — execution history (append-only)
 */

/**
 * @typedef {Object} OrchestratorConfig
 * @property {string[]} projectDirs
 * @property {{start: number, end: number}} workHours
 * @property {number} dailyBudgetUsd
 * @property {number} todaySpentUsd
 * @property {string} todayDate
 * @property {Object<string, Object>} projects
 * @property {Object[]} queue
 * @property {string} timezone
 * @property {boolean} pacingEnabled
 * @property {number} pacingMaxTarget
 * @property {number} pacingExponent
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

function getProjects() {
  return load().projects;
}

function setProject(name, info) {
  const data = load();
  data.projects[name] = info;
  save(data);
}

function setProjects(projects) {
  const data = load();
  data.projects = projects;
  save(data);
}

// --- Queue helpers ---

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

function dequeue(taskId) {
  const data = load();
  data.queue = data.queue.filter(t => t.id !== taskId);
  save(data);
}

function updateQueueTask(taskId, partial) {
  const data = load();
  const task = data.queue.find(t => t.id === taskId);
  if (task) Object.assign(task, partial);
  save(data);
  return task || null;
}

function nextPendingTask() {
  const data = load();
  return data.queue.find(t => t.status === 'pending') || null;
}

// --- Budget helpers ---

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
