/**
 * undo.js — Rollback de una ejecución autónoma.
 *
 * Estrategia:
 *   1. Si la rama `claudio/auto/*` existe y NO ha sido merged → `git branch -D`.
 *   2. Si la rama ya fue merged a master (auto-merge trivial) → `git revert`
 *      del commit de merge (deja un commit de reversión).
 *   3. Si no se encuentra ni rama ni commit → nothing.
 *
 * Ventana de undo configurable (default 6h): pasado ese tiempo, las ejecuciones
 * se consideran "sancionadas por el tiempo" y el undo ya no se ofrece.
 *
 * Funciones puras para decisión + DI para ejecución git.
 *
 * @typedef {Object} ExecutionRecord
 * @property {string} skill
 * @property {number} at - epoch ms de inicio
 * @property {string} [branch] - rama creada
 * @property {string} [mergedCommit] - sha si fue auto-merged
 *
 * @typedef {'delete-branch'|'revert-commit'|'nothing'} UndoAction
 */

const { spawn } = require('child_process');

const DEFAULT_UNDO_WINDOW_HOURS = 6;
const DAY_MS = 86400000;

/**
 * Determina si un run es elegible para undo dado su edad.
 * @param {ExecutionRecord} execution
 * @param {{now?: number, windowHours?: number}} [opts]
 * @returns {{eligible: boolean, reason: string}}
 */
function isUndoEligible(execution, opts = {}) {
  const now = opts.now ?? Date.now();
  const windowHours = opts.windowHours ?? DEFAULT_UNDO_WINDOW_HOURS;
  if (!execution || typeof execution.at !== 'number') {
    return { eligible: false, reason: 'sin registro de ejecución' };
  }
  const ageHours = (now - execution.at) / 3600000;
  if (ageHours < 0) {
    return { eligible: false, reason: 'ejecución en el futuro (?)' };
  }
  if (ageHours > windowHours) {
    return { eligible: false, reason: `ventana de undo vencida (${Math.round(ageHours)}h > ${windowHours}h)` };
  }
  return { eligible: true, reason: `ejecutada hace ${Math.round(ageHours * 10) / 10}h (dentro de ${windowHours}h)` };
}

/**
 * Decide qué acción de rollback aplica.
 *
 * @param {ExecutionRecord} execution
 * @param {{branchExists?: boolean, mergedToMaster?: boolean}} gitState
 * @returns {{action: UndoAction, target: string|null, reason: string}}
 */
function planUndo(execution, gitState = {}) {
  if (!execution || !execution.branch) {
    return { action: 'nothing', target: null, reason: 'sin información de rama' };
  }

  // Prioridad 1: si la rama sigue existiendo (no merged aún) → delete
  if (gitState.branchExists) {
    return {
      action: 'delete-branch',
      target: execution.branch,
      reason: 'rama aún no mergeada — se borra directamente',
    };
  }

  // Prioridad 2: si fue merged, revertir el commit
  if (gitState.mergedToMaster && execution.mergedCommit) {
    return {
      action: 'revert-commit',
      target: execution.mergedCommit,
      reason: 'rama ya mergeada — se revierte el commit',
    };
  }

  return {
    action: 'nothing',
    target: null,
    reason: 'rama no encontrada y sin commit de merge — nada que deshacer',
  };
}

// ---- I/O inyectable ----

function defaultGitRunner(args, cwd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('git timeout')); }, timeoutMs);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `git exit ${code}`)); });
  });
}

/**
 * Inspecciona el repo para rellenar gitState antes de planUndo.
 * @param {{projectPath: string, branch: string, mergedCommit?: string}} input
 * @param {{gitRun?: Function, base?: string}} [opts]
 * @returns {Promise<{branchExists: boolean, mergedToMaster: boolean}>}
 */
async function inspectGitState(input, opts = {}) {
  const gitRun = opts.gitRun || defaultGitRunner;
  const base = opts.base || 'master';
  let branchExists = false;
  let mergedToMaster = false;

  try {
    await gitRun(['rev-parse', '--verify', input.branch], input.projectPath);
    branchExists = true;
  } catch { /* rama ya no existe */ }

  if (input.mergedCommit) {
    try {
      // Verificar que el commit está en base
      await gitRun(['merge-base', '--is-ancestor', input.mergedCommit, base], input.projectPath);
      mergedToMaster = true;
    } catch { /* no está en base */ }
  }

  return { branchExists, mergedToMaster };
}

/**
 * Ejecuta el plan de undo resultante.
 *
 * @param {{projectPath: string, plan: {action: UndoAction, target: string|null}}} input
 * @param {{gitRun?: Function, base?: string}} [opts]
 * @returns {Promise<{ok: boolean, action: UndoAction, error?: string}>}
 */
async function executeUndo(input, opts = {}) {
  const gitRun = opts.gitRun || defaultGitRunner;
  const base = opts.base || 'master';
  const { action, target } = input.plan || {};

  if (action === 'nothing') return { ok: true, action };

  if (action === 'delete-branch') {
    try {
      await gitRun(['branch', '-D', target], input.projectPath);
      return { ok: true, action };
    } catch (e) {
      return { ok: false, action, error: e.message };
    }
  }

  if (action === 'revert-commit') {
    try {
      await gitRun(['checkout', base], input.projectPath);
      await gitRun(['revert', '--no-edit', target], input.projectPath);
      return { ok: true, action };
    } catch (e) {
      return { ok: false, action, error: e.message };
    }
  }

  return { ok: false, action, error: `acción desconocida: ${action}` };
}

/**
 * Flujo completo: eligibility → inspect → plan → execute.
 *
 * @param {{execution: ExecutionRecord, projectPath: string, now?: number, windowHours?: number}} input
 * @param {{gitRun?: Function, base?: string}} [opts]
 * @returns {Promise<{ok: boolean, action: UndoAction, reason: string, error?: string}>}
 */
async function undoExecution(input, opts = {}) {
  const elig = isUndoEligible(input.execution, { now: input.now, windowHours: input.windowHours });
  if (!elig.eligible) return { ok: false, action: 'nothing', reason: elig.reason };

  const exec = input.execution;
  if (!exec.branch) return { ok: false, action: 'nothing', reason: 'ejecución sin rama registrada' };

  const state = await inspectGitState(
    { projectPath: input.projectPath, branch: exec.branch, mergedCommit: exec.mergedCommit },
    opts
  );
  const plan = planUndo(exec, state);
  if (plan.action === 'nothing') return { ok: false, action: 'nothing', reason: plan.reason };

  const result = await executeUndo({ projectPath: input.projectPath, plan }, opts);
  return { ...result, reason: plan.reason };
}

module.exports = {
  isUndoEligible,
  planUndo,
  inspectGitState,
  executeUndo,
  undoExecution,
  DEFAULT_UNDO_WINDOW_HOURS,
};
