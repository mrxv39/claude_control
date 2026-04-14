/**
 * scheduler.js — Autonomous task scheduler with smart pacing.
 *
 * Three modes (evaluated by priority):
 *   1. OFF-HOURS: outside work hours → always execute if budget available
 *   2. IDLE: within work hours, user inactive >15min → execute opportunistically
 *   3. CAPACITY: within work hours, pacing says execute → smart token usage
 *
 * Pacing strategy: compares actual 5h usage against a target curve
 * (progress^0.6 × maxTarget). Actions: burst, accelerate, pace, coast.
 * Dynamic tick interval: 15s (burst) to 120s (coast).
 */

const store = require('./orchestrator-store');
const executor = require('./executor');
const tokenMonitor = require('./token-monitor');

let timer = null;
let running = false;
let paused = false;
let currentInterval = 60 * 1000;
let lastTaskStart = null;
let getSessionsFn = null;
let onStatusChange = null;

const STUCK_TIMEOUT = 6 * 60 * 1000; // 6 min — if task runs longer, force reset

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
  if (start < end) {
    return hour < start || hour >= end;
  } else {
    return hour >= end && hour < start;
  }
}

// Budget disabled for Max plan — tokens are prepaid, unused = wasted

async function hasUserBusySessions() {
  if (!getSessionsFn) return false;
  try {
    const sessions = await getSessionsFn();
    return sessions.some(s => s.isClaude && s.status === 'BUSY');
  } catch {
    return false;
  }
}

/**
 * Get priority level for a project based on last commit age.
 * Manual overrides take precedence. Blacklist always wins.
 */
function getProjectPriority(name, proj, config) {
  const blacklist = config.blacklist || [];
  if (blacklist.includes(name)) return 'ignored';

  const overrides = config.priorityOverrides || {};
  if (overrides[name]) return overrides[name];

  const days = proj.checks && proj.checks.lastCommitDays;
  if (days === null || days === undefined) return 'ignored';

  const rules = config.priorityRules || { high: 7, medium: 30, low: 90 };
  if (days <= rules.high) return 'high';
  if (days <= rules.medium) return 'medium';
  if (days <= (rules.low || 90)) return 'low';
  return 'ignored';
}

/**
 * Auto-enqueue tasks based on project priority and health scores.
 * @param {boolean} burstMode — if true, enqueue up to 10 tasks instead of 5
 */
function autoEnqueue(burstMode = false) {
  const config = store.load();
  const projects = config.projects;
  const queue = config.queue;

  const busyProjects = new Set(
    queue.filter(t => t.status === 'pending' || t.status === 'running').map(t => t.project)
  );

  let enqueued = 0;
  const maxEnqueue = burstMode ? 10 : 5;

  const eligible = Object.entries(projects)
    .filter(([name]) => !busyProjects.has(name))
    .map(([name, proj]) => ({ name, proj, priority: getProjectPriority(name, proj, config) }))
    .filter(p => p.priority !== 'ignored');

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const sorted = eligible.sort((a, b) => {
    const pDiff = (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3);
    if (pDiff !== 0) return pDiff;
    return (a.proj.score || 5) - (b.proj.score || 5);
  });

  // Only enqueue 'low' projects if no high/medium are eligible
  const hasHigherPriority = sorted.some(p => p.priority === 'high' || p.priority === 'medium');

  // Read log once outside the loop (was inside triple-nested loop before)
  const recentLog = store.readLog(100);

  for (const { name, proj, priority } of sorted) {
    if (enqueued >= maxEnqueue) break;
    if (priority === 'low' && hasHigherPriority) continue;

    for (const rule of SCORE_SKILLS) {
      if ((proj.score || 5) <= rule.maxScore) {
        for (const skill of rule.skills) {
          const recentlyRan = recentLog.some(
            l => l.project === name && l.skill === skill &&
                 l.timestamp && (Date.now() - new Date(l.timestamp).getTime()) < 7 * 24 * 60 * 60 * 1000
          );
          if (recentlyRan) continue;

          if (executor.SKILLS[skill]) {
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
        break;
      }
    }
  }

  return enqueued;
}

/**
 * Select next task based on pacing action.
 * burst/accelerate → expensive tasks first (maximize token burn)
 * pace/coast → cheap tasks first (preserve budget)
 */
function selectTask(pacingAction) {
  const config = store.load();
  const pending = config.queue.filter(t => t.status === 'pending');
  if (!pending.length) return null;

  const preferExpensive = (pacingAction === 'burst' || pacingAction === 'accelerate');

  const sorted = pending.sort((a, b) => {
    const costA = (executor.SKILLS[a.skill] || {}).budgetUsd || 0;
    const costB = (executor.SKILLS[b.skill] || {}).budgetUsd || 0;
    return preferExpensive ? (costB - costA) : (costA - costB);
  });

  return sorted[0];
}

let currentMode = null; // 'off-hours' | 'idle' | 'capacity' | null
let lastPacingDecision = null;

async function tick() {
  // Detect stuck tasks: if running for longer than STUCK_TIMEOUT, force reset
  if (running && lastTaskStart && (Date.now() - lastTaskStart) > STUCK_TIMEOUT) {
    executor.emergencyStop();
    running = false;
    lastTaskStart = null;
    notifyStatus('recovered', 'Tarea stuck detectada — reset forzado');
  }

  if (running || paused) return;

  const config = store.load();
  const outsideHours = isOutsideWorkHours();
  const idle = config.idleEnabled && tokenMonitor.isUserIdle(config.idleMinutes || 15);
  const busy = await hasUserBusySessions();

  // Get pacing decision
  const pacingConfig = {
    pacingMaxTarget: config.pacingMaxTarget || 95,
    pacingExponent: config.pacingExponent || 0.6,
    sevenDayThrottle: config.sevenDayThrottle || 80,
    sevenDayCaution: config.sevenDayCaution || 60
  };
  const pacing = config.pacingEnabled !== false
    ? tokenMonitor.getPacingDecision(pacingConfig)
    : null;
  lastPacingDecision = pacing;

  // Fallback for when pacing is disabled: use old threshold
  const oldCapacity = !pacing && config.capacityEnabled &&
    tokenMonitor.hasSpareCapacity(config.capacityThreshold || 50);

  const pacingAction = pacing ? pacing.action : 'wait';

  // Update tick interval based on pacing
  const newInterval = tokenMonitor.getRecommendedInterval(pacingAction);
  if (newInterval !== currentInterval) {
    currentInterval = newInterval;
  }

  // Stale data guard: if data is stale and we're not in off-hours, wait
  if (pacing && pacing.cycle && pacing.cycle.isStale && !outsideHours) {
    currentMode = null;
    notifyStatus('waiting', 'Rate data stale — esperando actualización');
    return;
  }

  // Determine execution mode (priority: off-hours > idle > capacity)
  if (outsideHours && !busy) {
    currentMode = 'off-hours';
  } else if (!outsideHours && idle && !busy) {
    currentMode = 'idle';
  } else if (!outsideHours && !busy && pacing && pacingAction !== 'coast' && pacingAction !== 'wait') {
    currentMode = 'capacity';
  } else if (!outsideHours && !busy && oldCapacity) {
    // Fallback when pacing disabled
    currentMode = 'capacity';
  } else {
    currentMode = null;
    const rateLimits = tokenMonitor.getRateLimits();
    const usedPct = rateLimits ? rateLimits.fiveHour.usedPercent : null;
    const pacingStr = pacing ? ` | ${pacing.action}: ${pacing.reason}` : '';
    const reason = busy ? 'Sesiones activas — esperando' :
                   pacingAction === 'coast' ? `Coast — ${pacing.reason}` :
                   !outsideHours && !idle ? `Idle: ${Math.round(tokenMonitor.getIdleMinutes())}/${config.idleMinutes || 15} min${pacingStr}` :
                   'Esperando';
    notifyStatus('waiting', reason);
    return;
  }


  // Burst mode: allow multiple tasks per tick
  const isBurst = pacingAction === 'burst';
  const maxTasksPerTick = isBurst ? 3 : 1;
  let tasksThisTick = 0;

  while (tasksThisTick < maxTasksPerTick) {
    // Re-check for busy sessions before each additional task
    if (tasksThisTick > 0 && await hasUserBusySessions()) break;

    // Get next task (cost-aware selection)
    let task = selectTask(pacingAction);

    // If no tasks, try auto-enqueue
    if (!task) {
      const n = autoEnqueue(isBurst);
      if (n > 0) {
        task = selectTask(pacingAction);
        notifyStatus('enqueued', `Auto-encoladas ${n} tareas`);
      }
    }

    if (!task) {
      if (tasksThisTick === 0) notifyStatus('idle', 'Sin tareas pendientes');
      break;
    }

    // Execute
    running = true;
    lastTaskStart = Date.now();
    const modeLabel = { 'off-hours': '[OFF-HOURS]', 'idle': '[IDLE]', 'capacity': '[CAP]' }[currentMode] || '[AUTO]';
    const pacingLabel = pacing ? ` ${pacing.action.toUpperCase()}` : '';
    store.updateQueueTask(task.id, { status: 'running', startedAt: new Date().toISOString(), mode: currentMode });
    notifyStatus('running', `${modeLabel}${pacingLabel} ${task.skill} en ${task.project}`);

    let result;
    try {
      result = await executor.execute(task, () => {
        if (currentMode === 'idle' && !tokenMonitor.isUserIdle(2)) {
          executor.emergencyStop();
          notifyStatus('stopped', 'Usuario activo — ejecución detenida');
        } else {
          notifyStatus('running', `${modeLabel}${pacingLabel} ${task.skill} en ${task.project}`);
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
    tasksThisTick++;

    // Only continue burst loop if task was fast (<90s)
    if (!result || result.duration > 90) break;
  }
}

function notifyStatus(state, message) {
  if (onStatusChange) onStatusChange({ state, message, timestamp: new Date().toISOString() });
}

/**
 * Schedule next tick with dynamic interval.
 * Uses setTimeout chain instead of setInterval for adaptive pacing.
 */
function scheduleTick() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await tick();
    if (!paused && timer !== null) scheduleTick();
  }, currentInterval);
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
  // First tick after 5s delay (let app initialize), then dynamic scheduling
  timer = setTimeout(async () => {
    await tick();
    if (!paused && timer !== null) scheduleTick();
  }, 5000);
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
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
  if (!timer) scheduleTick();
}

function getStatus() {
  const config = store.load();
  const idleMin = tokenMonitor.getIdleMinutes();
  return {
    running,
    paused,
    currentMode,
    rateLimits: tokenMonitor.getRateLimits(),
    pacingDecision: lastPacingDecision,
    pacingEnabled: config.pacingEnabled !== false,
    capacityEnabled: config.capacityEnabled !== false,
    capacityThreshold: config.capacityThreshold || 50,
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
    tickInterval: currentInterval,
    lastMessage: null
  };
}

module.exports = { start, stop, pause, resume, getStatus, autoEnqueue, getProjectPriority };
