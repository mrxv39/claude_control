/**
 * orchestrator-store.js — Persistent config & state for the orchestrator.
 *
 * Files:
 *   ~/.claude/claudio-state/orchestrator.json   — config + project data + queue
 *   ~/.claude/claudio-state/orchestrator-log.jsonl — execution history (append-only)
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
  priorityRules: { high: 7, medium: 30 },
  priorityOverrides: {},  // { projectName: 'high'|'medium'|'ignored' }
  idleEnabled: true,
  idleMinutes: 15,
  projects: {},
  queue: []
};

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

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

function save(data) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

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

function logExecution(entry) {
  ensureDir();
  entry.timestamp = entry.timestamp || new Date().toISOString();
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
}

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
