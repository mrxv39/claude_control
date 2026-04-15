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
const tokenHistory = require('./token-history');
const analyzer = require('./project-analyzer');
const skillAnalyzer = require('./skill-analyzer');

let timer = null;
let running = false;
let paused = false;
let currentInterval = 60 * 1000;
let lastTaskStart = null;
let getSessionsFn = null;
let onStatusChange = null;
let lastTickDebug = null;

const STUCK_TIMEOUT = 6 * 60 * 1000; // 6 min — if task runs longer, force reset

// Priority order for auto-enqueue
// Community skills (webapp-testing, frontend-design, trailofbits-security, pdf, ccusage)
// are filtered by applicableSkills analysis — safe to include here
const SCORE_SKILLS = [
  { maxScore: 3, skills: ['security-review', 'supabase-audit', 'audit-claude-md', 'trailofbits-security'] },
  { maxScore: 5, skills: ['audit-claude-md', 'dep-update', 'perf-audit', 'add-tests'] },
  { maxScore: 7, skills: ['add-tests', 'ui-polish', 'perf-audit', 'fix-types', 'webapp-testing', 'frontend-design'] },
  { maxScore: 10, skills: ['git-cleanup', 'simplify', 'fix-types', 'pdf', 'ccusage'] },
];

function isOutsideWorkHours() {
  const config = store.load();
  const tz = config.timezone || 'Europe/Madrid';
  let hour;
  try {
    const localStr = new Date().toLocaleString('en-US', { timeZone: tz, hour12: false, hour: '2-digit' });
    hour = parseInt(localStr, 10);
  } catch {
    hour = new Date().getHours(); // fallback to system timezone
  }
  const { start, end } = config.workHours;
  if (start < end) {
    return hour < start || hour >= end;
  } else {
    return hour >= end && hour < start;
  }
}

// Budget disabled for Max plan — tokens are prepaid, unused = wasted

/**
 * Returns the set of project paths with active Claude sessions (BUSY).
 * Used to avoid running autonomous tasks on projects the user is working on.
 */
async function getBusyProjectPaths() {
  if (!getSessionsFn) return new Set();
  try {
    const sessions = await getSessionsFn();
    const paths = sessions
      .filter(s => s.isClaude && s.status === 'BUSY')
      .map(s => s.cwd)
      .filter(Boolean);
    return new Set(paths);
  } catch {
    return new Set();
  }
}

async function hasUserBusySessions() {
  const busy = await getBusyProjectPaths();
  return busy.size > 0;
}

/**
 * Get priority level for a project based on last commit age.
 * Manual overrides take precedence. Blacklist always wins.
 */
/**
 * @param {string} name
 * @param {Object} proj - Project data with checks.lastCommitDays
 * @param {OrchestratorConfig} config
 * @returns {'high'|'medium'|'low'|'ignored'}
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
  const maxEnqueue = burstMode ? 20 : 10;

  const eligible = Object.entries(projects)
    .filter(([name]) => !busyProjects.has(name))
    .map(([name, proj]) => ({ name, proj, priority: getProjectPriority(name, proj, config) }))
    .filter(p => p.priority !== 'ignored');

  const priorityOrder = { high: 1, medium: 2, low: 3 };
  const sorted = eligible.sort((a, b) => {
    const pDiff = (priorityOrder[a.priority] || 4) - (priorityOrder[b.priority] || 4);
    if (pDiff !== 0) return pDiff;
    return (a.proj.score || 5) - (b.proj.score || 5);
  });

  // Read log once outside the loop
  const recentLog = store.readLog(100);

  // Build ordered skill list per project: primary skills (matching score) first, then rest
  // Filters out inapplicable skills if applicableSkills analysis exists
  function getSkillsForProject(proj) {
    const score = proj.score || 5;
    // Find primary skills (first matching rule), then collect rest as secondary
    let primaryRule = null;
    for (const rule of SCORE_SKILLS) {
      if (score <= rule.maxScore) { primaryRule = rule; break; }
    }
    if (!primaryRule) primaryRule = SCORE_SKILLS[SCORE_SKILLS.length - 1];
    const primary = [...primaryRule.skills];
    const seen = new Set(primary);
    const secondary = [];
    for (const rule of SCORE_SKILLS) {
      if (rule === primaryRule) continue;
      for (const s of rule.skills) {
        if (!seen.has(s)) { secondary.push(s); seen.add(s); }
      }
    }
    let allSkills = [...primary, ...secondary];

    // Filter by applicability analysis if available
    const applicable = proj.applicableSkills && proj.applicableSkills.skills;
    if (applicable) {
      allSkills = allSkills.filter(s => applicable[s] !== false);
    }

    return allSkills;
  }

  // Helper: check if a project has any available (not recently ran) skill
  function hasAvailableSkill(name, proj) {
    return getSkillsForProject(proj).some(skill => {
      if (!executor.SKILLS[skill]) return false;
      return !recentLog.some(
        l => l.project === name && l.skill === skill &&
             l.timestamp && (Date.now() - new Date(l.timestamp).getTime()) < 7 * 24 * 60 * 60 * 1000
      );
    });
  }

  // Only skip 'low' projects if high/medium actually have available skills
  const higherHasWork = sorted
    .filter(p => p.priority === 'high' || p.priority === 'medium')
    .some(p => hasAvailableSkill(p.name, p.proj));

  for (const { name, proj, priority } of sorted) {
    if (enqueued >= maxEnqueue) break;
    if (priority === 'low' && higherHasWork) continue;

    const skills = getSkillsForProject(proj);
    for (const skill of skills) {
      if (enqueued >= maxEnqueue) break;
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
      }
    }
  }

  return enqueued;
}

/**
 * Run skill applicability analysis on one project per call.
 * Only for medium/high priority projects without recent analysis.
 * Uses heuristic (free) by default, Claude mode in pace/coast.
 */
async function maybeRunSkillAnalysis(pacingAction) {
  const config = store.load();
  const projects = config.projects;
  if (!projects) return;

  const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const useClaude = (pacingAction === 'pace' || pacingAction === 'coast');

  for (const [name, proj] of Object.entries(projects)) {
    const priority = getProjectPriority(name, proj, config);
    if (priority === 'ignored' || priority === 'low') continue;

    const analysis = proj.applicableSkills;
    if (analysis && analysis.analyzedAt) {
      const age = Date.now() - new Date(analysis.analyzedAt).getTime();
      if (age < STALE_MS) {
        // Skip if no new commits since analysis
        if (!proj.lastModified || new Date(proj.lastModified) < new Date(analysis.analyzedAt)) continue;
      }
    }

    // Analyze this one project, then return (one per tick)
    try {
      const result = await skillAnalyzer.analyzeSkills(
        { name, path: proj.path, stack: proj.stack },
        { useClaude }
      );
      store.setProject(name, { ...proj, applicableSkills: result });
      notifyStatus('analysis', `Skill analysis: ${name} (${result.method})`);
    } catch {}
    return; // only one per tick
  }
}

/**
 * Select next task based on pacing action.
 * burst/accelerate → expensive tasks first (maximize token burn)
 * pace/coast → cheap tasks first (preserve budget)
 */
function selectTask(pacingAction, busyProjectPaths) {
  const config = store.load();
  let pending = config.queue.filter(t => t.status === 'pending');

  // Skip tasks whose project has an active Claude session
  if (busyProjectPaths && busyProjectPaths.size > 0) {
    pending = pending.filter(t => !busyProjectPaths.has(t.projectPath));
  }

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

  if (running || paused) {
    lastTickDebug = { outsideHours: null, idle: null, busy: null, pacingAction: null, reason: running ? 'task running' : 'paused' };
    return;
  }

  const config = store.load();
  const outsideHours = isOutsideWorkHours();
  const idle = config.idleEnabled && tokenMonitor.isUserIdle(config.idleMinutes || 15);
  const busyPaths = await getBusyProjectPaths();
  const busy = busyPaths.size > 0;

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

  // Capture end-of-cycle token usage snapshot
  if (pacing && pacing.cycle) {
    tokenHistory.maybeCaptureCycleEnd(pacing.cycle, tokenMonitor.getRateLimits());
  }

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
    lastTickDebug = { outsideHours, idle, busy, pacingAction, reason: 'rate data stale' };
    notifyStatus('waiting', 'Rate data stale — esperando actualización');
    return;
  }

  // Determine execution mode (priority: off-hours > idle > capacity)
  // Note: busy check is per-project (at task selection), not global.
  // The scheduler can run tasks on non-busy projects while the user works on others.
  lastTickDebug = { outsideHours, idle, busy, busyProjects: busyPaths.size, pacingAction, reason: null };
  if (outsideHours) {
    currentMode = 'off-hours';
  } else if (idle) {
    currentMode = 'idle';
  } else if (pacing && pacingAction !== 'coast' && pacingAction !== 'wait') {
    currentMode = 'capacity';
  } else if (oldCapacity) {
    // Fallback when pacing disabled
    currentMode = 'capacity';
  } else {
    currentMode = null;
    const pacingStr = pacing ? ` | ${pacing.action}: ${pacing.reason}` : '';
    const reason = pacingAction === 'coast' ? `Coast — ${pacing.reason}` :
                   !outsideHours && !idle ? `Idle: ${Math.round(tokenMonitor.getIdleMinutes())}/${config.idleMinutes || 15} min${pacingStr}` :
                   'Esperando';
    lastTickDebug = { outsideHours, idle, busy, busyProjects: busyPaths.size, pacingAction, reason };
    notifyStatus('waiting', reason);
    return;
  }


  // Run skill analysis on one project per tick (non-blocking, only pace/coast uses Claude)
  if (pacingAction !== 'burst') {
    await maybeRunSkillAnalysis(pacingAction);
  }

  // Parallel execution: run up to MAX_PARALLEL tasks on different projects
  const isBurst = pacingAction === 'burst' || pacingAction === 'accelerate';
  const MAX_PARALLEL = isBurst ? 3 : 2;

  // Pre-fill queue if running low on pending tasks
  const pendingCount = store.getQueue().filter(t => t.status === 'pending').length;
  if (pendingCount < 5) {
    const n = autoEnqueue(isBurst);
    if (n > 0) notifyStatus('enqueued', `Auto-encoladas ${n} tareas`);
  }

  // Select up to MAX_PARALLEL tasks on DIFFERENT projects
  const tasks = [];
  const selectedProjects = new Set();
  for (let i = 0; i < MAX_PARALLEL; i++) {
    // Exclude already-selected projects (one task per project per tick)
    const excludePaths = new Set([...busyPaths]);
    selectedProjects.forEach(p => excludePaths.add(p));

    let task = selectTask(pacingAction, excludePaths);
    if (!task && i === 0) {
      const n = autoEnqueue(isBurst);
      if (n > 0) {
        task = selectTask(pacingAction, excludePaths);
        notifyStatus('enqueued', `Auto-encoladas ${n} tareas`);
      }
    }
    if (!task) break;
    tasks.push(task);
    selectedProjects.add(task.projectPath);
  }

  if (tasks.length === 0) {
    notifyStatus('idle', 'Sin tareas pendientes');
    return;
  }

  running = true;
  lastTaskStart = Date.now();
  const modeLabel = { 'off-hours': '[OFF-HOURS]', 'idle': '[IDLE]', 'capacity': '[CAP]' }[currentMode] || '[AUTO]';
  const pacingLabel = pacing ? ` ${pacing.action.toUpperCase()}` : '';

  // Mark all as running
  for (const task of tasks) {
    store.updateQueueTask(task.id, { status: 'running', startedAt: new Date().toISOString(), mode: currentMode });
  }
  const taskNames = tasks.map(t => `${t.skill}@${t.project}`).join(', ');
  notifyStatus('running', `${modeLabel}${pacingLabel} [${tasks.length}x] ${taskNames}`);

  // Execute all in parallel
  const results = await Promise.allSettled(tasks.map(async (task) => {
    try {
      const result = await executor.execute(task, () => {
        if (currentMode === 'idle' && !tokenMonitor.isUserIdle(2)) {
          executor.emergencyStop();
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
        // Retry once if failed by timeout
        if (result.duration >= 110 && !task.retried) {
          store.enqueue({ project: task.project, skill: task.skill, projectPath: task.projectPath, auto: true, retried: true });
          notifyStatus('retry', `Re-encolada ${task.skill} en ${task.project} (timeout retry)`);
        }
      }

      // Re-analyze project to update score
      if (result.status === 'done') {
        try {
          const updated = await analyzer.analyze({ name: task.project, path: task.projectPath });
          store.setProject(task.project, { ...store.load().projects[task.project], ...updated, lastAnalysis: new Date().toISOString() });
        } catch {}
      }

      return result;
    } catch (err) {
      store.updateQueueTask(task.id, { status: 'failed', error: err.message });
      notifyStatus('failed', `Error en ${task.skill}: ${err.message}`);
      return { status: 'failed' };
    }
  }));

  running = false;
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

  tokenHistory.initLastSaved();

  if (timer) return; // already running
  // First tick after 5s delay (let app initialize), then dynamic scheduling
  timer = setTimeout(async () => {
    // Pre-populate queue if empty so first tick has work to do
    const pending = store.getQueue().filter(t => t.status === 'pending');
    if (pending.length === 0) autoEnqueue();

    await tick();
    if (!paused && timer !== null) scheduleTick();
  }, 5000);
}

/** Stop the scheduler and kill any running tasks. */
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

/** @returns {{running: boolean, paused: boolean, currentMode: string, rateLimits: Object, pacingDecision: Object}} */
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
    lastTickDebug,
    lastMessage: null
  };
}

module.exports = { start, stop, pause, resume, getStatus, autoEnqueue, getProjectPriority };
