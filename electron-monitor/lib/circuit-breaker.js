/**
 * circuit-breaker.js — Tracking de fallos consecutivos por proyecto.
 *
 * Regla: 3 fallos consecutivos dentro de una ventana de 24h → "tripped"
 * (el caller pausa el proyecto). Un éxito en medio resetea el contador.
 * Un skill que exceda `timeoutMs` se cuenta como fallo.
 *
 * El módulo es puro: no persiste. Opera sobre una lista de fallos
 * (e.g. `project.failures24h` en orchestrator.json) y devuelve mutaciones.
 *
 * @typedef {Object} FailureRecord
 * @property {string} skill
 * @property {number} at - epoch ms
 * @property {string} [reason] - 'fail' | 'timeout' | free-form
 */

const DAY_MS = 86400000;
const DEFAULT_WINDOW_MS = DAY_MS;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_SKILL_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

/**
 * Elimina fallos más antiguos que la ventana.
 * @param {FailureRecord[]} failures
 * @param {number} now
 * @param {number} [windowMs]
 * @returns {FailureRecord[]}
 */
function pruneOld(failures, now, windowMs = DEFAULT_WINDOW_MS) {
  if (!Array.isArray(failures)) return [];
  const cutoff = now - windowMs;
  return failures.filter(f => f && typeof f.at === 'number' && f.at >= cutoff);
}

/**
 * Actualiza la lista tras una ejecución. Devuelve la nueva lista y si
 * se ha disparado el breaker.
 *
 * @param {FailureRecord[]} currentFailures
 * @param {{skill: string, outcome: 'ok'|'fail', at: number, durationMs?: number}} execution
 * @param {{now?: number, threshold?: number, windowMs?: number, skillTimeoutMs?: number}} [opts]
 * @returns {{failures: FailureRecord[], tripped: boolean, reason: string|null}}
 */
function recordExecution(currentFailures, execution, opts = {}) {
  const now = opts.now ?? Date.now();
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const skillTimeoutMs = opts.skillTimeoutMs ?? DEFAULT_SKILL_TIMEOUT_MS;

  if (!execution || !execution.skill) {
    return { failures: pruneOld(currentFailures, now, windowMs), tripped: false, reason: null };
  }

  const isTimeout = typeof execution.durationMs === 'number' && execution.durationMs >= skillTimeoutMs;
  const isFailure = execution.outcome === 'fail' || isTimeout;

  if (!isFailure) {
    // Éxito: reset del contador (fallos consecutivos rotos)
    return { failures: [], tripped: false, reason: null };
  }

  const pruned = pruneOld(currentFailures, now, windowMs);
  const next = [
    ...pruned,
    { skill: execution.skill, at: execution.at ?? now, reason: isTimeout ? 'timeout' : 'fail' },
  ];
  const tripped = next.length >= threshold;
  const reason = tripped
    ? `${next.length} fallos en ${Math.round(windowMs / 3600000)}h (último: ${isTimeout ? 'timeout' : 'fail'} de ${execution.skill})`
    : null;
  return { failures: next, tripped, reason };
}

/**
 * Dado un set de fallos, ¿está disparado el breaker? Útil tras restart
 * para chequear el estado sin re-procesar la última ejecución.
 * @param {FailureRecord[]} failures
 * @param {{now?: number, threshold?: number, windowMs?: number}} [opts]
 * @returns {boolean}
 */
function isTripped(failures, opts = {}) {
  const now = opts.now ?? Date.now();
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  return pruneOld(failures, now, windowMs).length >= threshold;
}

/**
 * Reset manual (p.ej. cuando el usuario reactiva el proyecto tras revisar).
 * @returns {FailureRecord[]}
 */
function reset() {
  return [];
}

module.exports = {
  pruneOld,
  recordExecution,
  isTripped,
  reset,
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW_MS,
  DEFAULT_SKILL_TIMEOUT_MS,
};
