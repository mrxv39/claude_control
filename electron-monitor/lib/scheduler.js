/**
 * scheduler.js — Autonomous task scheduler.
 *
 * Two modes (both active simultaneously):
 *   1. OFF-HOURS: outside work hours → always execute if budget available
 *   2. IDLE: within work hours, user inactive >15min → execute opportunistically
 *
 * Every 60s checks conditions and executes next task if appropriate.
 * Stops immediately if user becomes active (new JSONL activity or BUSY session).
 */

const store = require('./orchestrator-store');
const executor = require('./executor');
const tokenMonitor = require('./token-monitor');

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
 * Manual overrides take precedence. Blacklist always wins.
 * Returns 'high' (≤7d), 'medium' (8-30d), or 'ignored' (>30d / blacklisted).
 */
function getProjectPriority(name, proj, config) {
  const blacklist = config.blacklist || [];
  if (blacklist.includes(name)) return 'ignored';

  // Manual override takes precedence
  const overrides = config.priorityOverrides || {};
  if (overrides[name]) return overrides[name];

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

let currentMode = null; // 'off-hours' | 'idle' | null

async function tick() {
  if (running || paused) return;

  const config = store.load();
  const outsideHours = isOutsideWorkHours();
  const idle = config.idleEnabled && tokenMonitor.isUserIdle(config.idleMinutes || 15);
  const busy = await hasUserBusySessions();

  // Determine execution mode
  if (outsideHours && !busy) {
    currentMode = 'off-hours';
  } else if (!outsideHours && idle && !busy) {
    currentMode = 'idle';
  } else {
    currentMode = null;
    // If user is active and we were in idle mode, emergency stop
    if (!idle && running) {
      executor.emergencyStop();
      running = false;
      notifyStatus('stopped', 'Usuario activo — ejecución detenida');
      return;
    }
    const reason = busy ? 'Sesiones activas — esperando' :
                   !outsideHours && !idle ? `Idle: ${Math.round(tokenMonitor.getIdleMinutes())}/${config.idleMinutes || 15} min` :
                   'Esperando';
    notifyStatus('waiting', reason);
    return;
  }

  if (!hasBudget()) {
    notifyStatus('waiting', 'Sin presupuesto restante hoy');
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
  const modeLabel = currentMode === 'idle' ? '[IDLE]' : '[OFF-HOURS]';
  store.updateQueueTask(task.id, { status: 'running', startedAt: new Date().toISOString(), mode: currentMode });
  notifyStatus('running', `${modeLabel} Ejecutando ${task.skill} en ${task.project}`);

  try {
    const result = await executor.execute(task, (line) => {
      // If in idle mode, check if user came back
      if (currentMode === 'idle' && !tokenMonitor.isUserIdle(2)) {
        executor.emergencyStop();
        notifyStatus('stopped', 'Usuario activo — ejecución detenida');
      } else {
        notifyStatus('running', `${modeLabel} ${task.skill} en ${task.project}`);
      }
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
  const idleMin = tokenMonitor.getIdleMinutes();
  return {
    running,
    paused,
    currentMode,
    outsideWorkHours: isOutsideWorkHours(),
    idleEnabled: config.idleEnabled !== false,
    idleMinutes: config.idleMinutes || 15,
    userIdleFor: Math.round(idleMin),
    userIsIdle: tokenMonitor.isUserIdle(config.idleMinutes || 15),
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
