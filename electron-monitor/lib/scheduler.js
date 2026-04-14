/**
 * scheduler.js — Autonomous task scheduler for off-hours execution.
 *
 * Every 60s checks:
 *   1. Are we outside work hours?
 *   2. Is there budget remaining?
 *   3. Are there no user BUSY sessions? (don't compete for resources)
 *   4. Is there a pending task in the queue?
 *
 * If all yes → execute the next task via executor.js
 * If queue is empty and analysis exists → auto-enqueue based on project scores.
 */

const store = require('./orchestrator-store');
const executor = require('./executor');

const CHECK_INTERVAL = 60 * 1000; // 60 seconds

let timer = null;
let running = false;
let paused = false;
let getSessionsFn = null; // injected: () => Promise<sessions[]>
let onStatusChange = null; // injected: (status) => void

// Priority order for auto-enqueue
const SCORE_SKILLS = [
  { maxScore: 3, skills: ['security-review', 'audit-claude-md'] },
  { maxScore: 5, skills: ['audit-claude-md', 'dep-update'] },
  { maxScore: 7, skills: ['add-tests'] },
  { maxScore: 10, skills: ['git-cleanup'] },
];

function isOutsideWorkHours() {
  const config = store.load();
  const hour = new Date().getHours();
  const { start, end } = config.workHours;
  // If start < end (e.g., 9-23): outside = hour < start || hour >= end
  // If start > end (e.g., 23-9): outside = hour >= end && hour < start (inverted)
  if (start < end) {
    return hour < start || hour >= end;
  } else {
    return hour >= end && hour < start;
  }
}

function hasBudget() {
  return store.budgetRemaining() > 0.01;
}

async function hasUserBusySessions() {
  if (!getSessionsFn) return false;
  try {
    const sessions = await getSessionsFn();
    return sessions.some(s => s.isClaude && s.status === 'BUSY');
  } catch {
    return false; // assume no busy sessions if we can't check
  }
}

/**
 * Get priority level for a project based on last commit age.
 * Returns 'high' (≤7d), 'medium' (8-30d), or 'ignored' (>30d / blacklisted).
 */
function getProjectPriority(name, proj, config) {
  const blacklist = config.blacklist || [];
  if (blacklist.includes(name)) return 'ignored';

  const days = proj.checks && proj.checks.lastCommitDays;
  if (days === null || days === undefined) return 'ignored';

  const rules = config.priorityRules || { high: 7, medium: 30 };
  if (days <= rules.high) return 'high';
  if (days <= rules.medium) return 'medium';
  return 'ignored';
}

/**
 * Auto-enqueue tasks based on project priority and health scores.
 * Only enqueues for active projects (not blacklisted, not stale).
 * Priority: high (recent commits) before medium. Within each, worst score first.
 */
function autoEnqueue() {
  const config = store.load();
  const projects = config.projects;
  const queue = config.queue;

  // Get projects with pending/running tasks
  const busyProjects = new Set(
    queue.filter(t => t.status === 'pending' || t.status === 'running').map(t => t.project)
  );

  let enqueued = 0;
  const maxEnqueue = 5; // don't flood the queue

  // Filter and classify projects by priority
  const eligible = Object.entries(projects)
    .filter(([name]) => !busyProjects.has(name))
    .map(([name, proj]) => ({ name, proj, priority: getProjectPriority(name, proj, config) }))
    .filter(p => p.priority !== 'ignored');

  // Sort: high priority first, then by score ascending (worst first)
  const priorityOrder = { high: 0, medium: 1 };
  const sorted = eligible.sort((a, b) => {
    const pDiff = (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
    if (pDiff !== 0) return pDiff;
    return (a.proj.score || 5) - (b.proj.score || 5);
  });

  for (const { name, proj } of sorted) {
    if (enqueued >= maxEnqueue) break;

    // Find applicable skills for this score
    for (const rule of SCORE_SKILLS) {
      if ((proj.score || 5) <= rule.maxScore) {
        for (const skill of rule.skills) {
          // Check if this exact skill was already run recently (last 7 days)
          const recentLog = store.readLog(100);
          const recentlyRan = recentLog.some(
            l => l.project === name && l.skill === skill &&
                 l.timestamp && (Date.now() - new Date(l.timestamp).getTime()) < 7 * 24 * 60 * 60 * 1000
          );
          if (recentlyRan) continue;

          // Check budget for this skill
          const skillDef = executor.SKILLS[skill];
          if (skillDef && store.budgetRemaining() > skillDef.budgetUsd) {
            store.enqueue({
              project: name,
              skill,
              projectPath: proj.path,
              auto: true
            });
            enqueued++;
            if (enqueued >= maxEnqueue) break;
          }
        }
        break; // only match the first score rule
      }
    }
  }

  return enqueued;
}

async function tick() {
  if (running || paused) return;

  // Check conditions
  if (!isOutsideWorkHours()) {
    notifyStatus('waiting', 'Dentro de horario laboral');
    return;
  }
  if (!hasBudget()) {
    notifyStatus('waiting', 'Sin presupuesto restante hoy');
    return;
  }
  if (await hasUserBusySessions()) {
    notifyStatus('waiting', 'Sesiones del usuario activas — esperando');
    return;
  }

  // Get next pending task
  let task = store.nextPendingTask();

  // If no tasks, try auto-enqueue
  if (!task) {
    const n = autoEnqueue();
    if (n > 0) {
      task = store.nextPendingTask();
      notifyStatus('enqueued', `Auto-encoladas ${n} tareas`);
    }
  }

  if (!task) {
    notifyStatus('idle', 'Sin tareas pendientes');
    return;
  }

  // Execute
  running = true;
  store.updateQueueTask(task.id, { status: 'running', startedAt: new Date().toISOString() });
  notifyStatus('running', `Ejecutando ${task.skill} en ${task.project}`);

  try {
    const result = await executor.execute(task, (line) => {
      notifyStatus('running', `${task.skill} en ${task.project}: procesando...`);
    });

    store.updateQueueTask(task.id, {
      status: result.status,
      branch: result.branch,
      costUsd: result.costUsd,
      duration: result.duration,
      hasChanges: result.hasChanges,
      completedAt: new Date().toISOString()
    });

    if (result.status === 'done' && result.hasChanges) {
      notifyStatus('done', `${task.skill} en ${task.project} — rama: ${result.branch}`);
    } else if (result.status === 'done') {
      notifyStatus('done', `${task.skill} en ${task.project} — sin cambios`);
    } else {
      notifyStatus('failed', `${task.skill} en ${task.project} — error`);
    }
  } catch (err) {
    store.updateQueueTask(task.id, { status: 'failed', error: err.message });
    notifyStatus('failed', `Error en ${task.skill}: ${err.message}`);
  }

  running = false;
}

function notifyStatus(state, message) {
  if (onStatusChange) onStatusChange({ state, message, timestamp: new Date().toISOString() });
}

/**
 * Start the scheduler loop.
 * @param {Object} opts
 * @param {Function} opts.getSessions - () => Promise<sessions[]>
 * @param {Function} opts.onStatus - ({ state, message }) => void
 */
function start(opts = {}) {
  getSessionsFn = opts.getSessions || null;
  onStatusChange = opts.onStatus || null;
  paused = false;

  if (timer) return; // already running
  timer = setInterval(tick, CHECK_INTERVAL);
  // Run first tick after a short delay (let app initialize)
  setTimeout(tick, 5000);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  executor.emergencyStop();
  running = false;
}

function pause() {
  paused = true;
  executor.emergencyStop();
  running = false;
}

function resume() {
  paused = false;
}

function getStatus() {
  const config = store.load();
  return {
    running,
    paused,
    outsideWorkHours: isOutsideWorkHours(),
    budgetRemaining: store.budgetRemaining(),
    todaySpent: config.todaySpentUsd,
    dailyBudget: config.dailyBudgetUsd,
    workHours: config.workHours,
    pendingTasks: config.queue.filter(t => t.status === 'pending').length,
    runningTask: running ? (executor.execute._currentTask || null) : null,
    lastMessage: null
  };
}

module.exports = { start, stop, pause, resume, getStatus, autoEnqueue, getProjectPriority };
