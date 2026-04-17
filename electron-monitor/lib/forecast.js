/**
 * forecast.js — Predicción de cumplimiento de objetivos con deadline.
 *
 * Velocity = skills ejecutados con éxito por día (ventana configurable).
 * Effort restante = criterios no cumplidos del template.
 * Días necesarios = effort / (velocity * skillEffectiveness).
 *
 * Compara con deadline → on-track | at-risk | impossible | no-deadline.
 *
 * Asumpciones:
 *   - skillEffectiveness (0..1) = fracción media de criterios que satisface
 *     un skill. Default 0.5 (la mitad; conservador).
 *   - Velocity cuenta solo skills con outcome=ok en la ventana.
 *
 * Módulo puro.
 *
 * @typedef {Object} ForecastResult
 * @property {number} velocity - skills/día en ventana
 * @property {number|null} daysNeeded - null si velocity insuficiente
 * @property {number|null} daysUntilDeadline - null si no hay deadline
 * @property {string|null} predictedCompletionDate - ISO, null si unknowable
 * @property {'on-track'|'at-risk'|'impossible'|'no-deadline'|'insufficient-data'|'already-met'} status
 * @property {number} unmetCount
 */

const DAY_MS = 86400000;
const DEFAULT_VELOCITY_WINDOW_DAYS = 14;
const DEFAULT_SKILL_EFFECTIVENESS = 0.5;

/**
 * Velocity: skills ejecutados con éxito por día en la ventana.
 *
 * @param {Array<{skill: string, at: number, outcome: string}>} history
 * @param {{windowDays?: number, now?: number}} [opts]
 * @returns {number}
 */
function calculateVelocity(history, opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_VELOCITY_WINDOW_DAYS;
  const now = opts.now ?? Date.now();
  const cutoff = now - windowDays * DAY_MS;
  const successCount = (history || [])
    .filter(h => h && h.outcome === 'ok' && typeof h.at === 'number' && h.at >= cutoff)
    .length;
  return successCount / windowDays;
}

/**
 * Días necesarios para satisfacer `unmetCount` criterios dada velocity.
 *
 * @param {number} unmetCount
 * @param {number} velocity
 * @param {number} [skillEffectiveness] - 0..1
 * @returns {number|null} - null si velocity es 0 (unknowable)
 */
function estimateDaysToGoal(unmetCount, velocity, skillEffectiveness = DEFAULT_SKILL_EFFECTIVENESS) {
  if (unmetCount <= 0) return 0;
  if (velocity <= 0) return null;
  const effective = velocity * skillEffectiveness;
  return Math.ceil(unmetCount / effective);
}

function dateAddDays(now, days) {
  return new Date(now + days * DAY_MS).toISOString().slice(0, 10);
}

function parseDeadline(deadline, now) {
  if (!deadline || typeof deadline !== 'string') return null;
  const t = Date.parse(deadline);
  if (isNaN(t)) return null;
  const days = (t - now) / DAY_MS;
  return days;
}

/**
 * Forecast completo de un objetivo con deadline.
 *
 * @param {{objective: {deadline?: string}, history?: any[]}} project
 * @param {{satisfied: number, total: number}} evaluation
 * @param {{now?: number, windowDays?: number, skillEffectiveness?: number}} [opts]
 * @returns {ForecastResult}
 */
function forecastCompletion(project, evaluation, opts = {}) {
  const now = opts.now ?? Date.now();
  const total = evaluation?.total ?? 0;
  const satisfied = evaluation?.satisfied ?? 0;
  const unmetCount = Math.max(0, total - satisfied);
  const velocity = calculateVelocity(project?.history, { ...opts, now });
  const daysNeeded = estimateDaysToGoal(unmetCount, velocity, opts.skillEffectiveness);
  const daysUntilDeadline = parseDeadline(project?.objective?.deadline, now);
  const predictedCompletionDate = daysNeeded != null ? dateAddDays(now, daysNeeded) : null;

  if (unmetCount === 0) {
    return {
      velocity: Math.round(velocity * 100) / 100,
      daysNeeded: 0,
      daysUntilDeadline,
      predictedCompletionDate: dateAddDays(now, 0),
      status: 'already-met',
      unmetCount: 0,
    };
  }

  if (daysNeeded == null) {
    return {
      velocity: 0,
      daysNeeded: null,
      daysUntilDeadline,
      predictedCompletionDate: null,
      status: 'insufficient-data',
      unmetCount,
    };
  }

  if (daysUntilDeadline == null) {
    return {
      velocity: Math.round(velocity * 100) / 100,
      daysNeeded,
      daysUntilDeadline: null,
      predictedCompletionDate,
      status: 'no-deadline',
      unmetCount,
    };
  }

  let status;
  if (daysUntilDeadline < 0) status = 'impossible'; // deadline ya pasó
  else if (daysNeeded <= daysUntilDeadline) status = 'on-track';
  else status = 'at-risk';

  return {
    velocity: Math.round(velocity * 100) / 100,
    daysNeeded,
    daysUntilDeadline: Math.ceil(daysUntilDeadline),
    predictedCompletionDate,
    status,
    unmetCount,
  };
}

/**
 * Prioriza proyectos por urgencia: deadline ajustado y riesgo.
 * Útil para que el planner elija primero los que más peligro corren.
 *
 * @param {Array<{name: string, forecast: ForecastResult}>} projects
 * @returns {Array<{name: string, forecast: ForecastResult, priority: number}>}
 */
function prioritizeByUrgency(projects) {
  return (projects || [])
    .filter(p => p && p.forecast)
    .map(p => {
      let priority = 0;
      switch (p.forecast.status) {
        case 'impossible': priority = 100; break;
        case 'at-risk':
          // Más riesgo = más cercano al deadline / más skills faltan
          priority = 50 + Math.max(0, 30 - (p.forecast.daysUntilDeadline || 0));
          break;
        case 'on-track':
          priority = 10;
          break;
        case 'insufficient-data': priority = 5; break;
        case 'no-deadline': priority = 1; break;
        case 'already-met': priority = 0; break;
      }
      return { ...p, priority };
    })
    .sort((a, b) => b.priority - a.priority);
}

/**
 * Mensaje humano para mostrar en el drawer de proyecto.
 * @param {ForecastResult} f
 * @returns {string}
 */
function describeForecast(f) {
  if (!f) return '';
  switch (f.status) {
    case 'already-met':
      return 'Objetivo cumplido';
    case 'insufficient-data':
      return `Sin historial suficiente para estimar (${f.unmetCount} criterios pendientes)`;
    case 'no-deadline':
      return `Al ritmo actual se alcanza el ${f.predictedCompletionDate} (~${f.daysNeeded}d)`;
    case 'impossible':
      return `Deadline vencido hace ${Math.abs(f.daysUntilDeadline)}d`;
    case 'on-track':
      return `Al ritmo actual se alcanza el ${f.predictedCompletionDate} (${f.daysUntilDeadline - f.daysNeeded}d de margen) ✓`;
    case 'at-risk': {
      const delta = f.daysNeeded - (f.daysUntilDeadline || 0);
      return `NO se alcanza al ritmo actual — faltan ~${delta}d tras deadline`;
    }
    default:
      return '';
  }
}

module.exports = {
  calculateVelocity,
  estimateDaysToGoal,
  forecastCompletion,
  prioritizeByUrgency,
  describeForecast,
  DEFAULT_VELOCITY_WINDOW_DAYS,
  DEFAULT_SKILL_EFFECTIVENESS,
};
