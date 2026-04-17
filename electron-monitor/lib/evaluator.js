/**
 * evaluator.js — Puentea project-analyzer + goals, detecta transiciones de estado.
 *
 * Dado un proyecto con objetivo y su análisis actual:
 *   - Corre goals.evaluate contra el template del objetivo
 *   - Detecta si acaba de alcanzar el objetivo (transición a mantenimiento)
 *   - Detecta si un proyecto en mantenimiento retrocedió (volvió a no cumplir)
 *   - Decide si un proyecto en mantenimiento necesita re-evaluación periódica
 *
 * Módulo puro (sin I/O). La ejecución real de project-analyzer y la persistencia
 * quedan en el scheduler.
 *
 * @typedef {'reached'|'regressed'|'maintained'|'in-progress'} Transition
 *
 * @typedef {Object} ProjectConfig
 * @property {boolean} active
 * @property {{template: string, note?: string, deadline?: string}|null} objective
 * @property {Array<{skill: string, at: number, outcome: 'ok'|'fail', scoreBefore?: number, scoreAfter?: number}>} history
 * @property {number|null} maintenanceSince - epoch ms cuando cumplió objetivo la 1a vez
 *
 * @typedef {Object} EvaluationOutcome
 * @property {import('./goals').Template extends infer T ? T : any} evaluation - ver goals.evaluate output
 * @property {Transition} transition
 * @property {boolean} needsReevaluation
 * @property {number|null} daysSinceMaintenance
 */

const goals = require('./goals');

const DAY_MS = 86400000;
const DEFAULT_REEVAL_DAYS = 7;

function daysSince(ts, now) {
  if (ts == null) return null;
  return Math.floor((now - ts) / DAY_MS);
}

/**
 * Evalúa el estado actual de un proyecto respecto a su objetivo.
 *
 * @param {ProjectConfig} project
 * @param {{checks: Object, score: number}} analysis
 * @param {{now?: number, reevalIntervalDays?: number}} [opts]
 * @returns {EvaluationOutcome}
 */
function evaluateProject(project, analysis, opts = {}) {
  const now = opts.now ?? Date.now();
  const reevalDays = opts.reevalIntervalDays ?? DEFAULT_REEVAL_DAYS;

  if (!project?.objective?.template) {
    return {
      evaluation: null,
      transition: 'in-progress',
      needsReevaluation: false,
      daysSinceMaintenance: null,
    };
  }

  const evaluation = goals.evaluate(project.objective.template, {
    analysis,
    history: project.history || [],
    now,
  });

  const wasInMaintenance = project.maintenanceSince != null;
  const meetsNow = evaluation.met;

  let transition;
  if (meetsNow && !wasInMaintenance) transition = 'reached';
  else if (!meetsNow && wasInMaintenance) transition = 'regressed';
  else if (meetsNow && wasInMaintenance) transition = 'maintained';
  else transition = 'in-progress';

  const daysInMaintenance = wasInMaintenance ? daysSince(project.maintenanceSince, now) : null;
  const needsReevaluation = wasInMaintenance && daysInMaintenance >= reevalDays;

  return {
    evaluation,
    transition,
    needsReevaluation,
    daysSinceMaintenance: daysInMaintenance,
  };
}

/**
 * Aplica la transición al estado del proyecto, devolviendo una copia nueva.
 * No muta el input.
 *
 * @param {ProjectConfig} project
 * @param {Transition} transition
 * @param {number} [now]
 * @returns {ProjectConfig}
 */
function applyTransition(project, transition, now) {
  const t = now ?? Date.now();
  const next = { ...project };
  switch (transition) {
    case 'reached':
      next.maintenanceSince = t;
      break;
    case 'regressed':
      next.maintenanceSince = null;
      break;
    case 'maintained':
    case 'in-progress':
      // No change
      break;
    default:
      break;
  }
  return next;
}

/**
 * ¿El proyecto está maduro para una nueva evaluación? (Útil para el scheduler al
 * decidir si vale la pena re-analizar un proyecto en mantenimiento.)
 *
 * @param {ProjectConfig} project
 * @param {number} [now]
 * @param {number} [intervalDays]
 * @returns {boolean}
 */
function shouldReevaluate(project, now, intervalDays = DEFAULT_REEVAL_DAYS) {
  if (!project) return false;
  if (!project.maintenanceSince) return true; // no en mantenimiento
  const t = now ?? Date.now();
  return daysSince(project.maintenanceSince, t) >= intervalDays;
}

/**
 * Devuelve los criterios NO cumplidos de la evaluación, ordenados por criticidad.
 * Útil para que el planner sepa qué skill ejecutar siguiente.
 *
 * @param {{criteria: Array<{id: string, label: string, met: boolean, detail: string}>}} evaluation
 * @returns {Array<{id: string, label: string, detail: string}>}
 */
function unmetCriteria(evaluation) {
  if (!evaluation?.criteria) return [];
  return evaluation.criteria.filter(c => !c.met).map(c => ({
    id: c.id,
    label: c.label,
    detail: c.detail,
  }));
}

module.exports = {
  evaluateProject,
  applyTransition,
  shouldReevaluate,
  unmetCriteria,
  DEFAULT_REEVAL_DAYS,
};
