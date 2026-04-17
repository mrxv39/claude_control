/**
 * token-report.js — Análisis post-hoc de ciclos 5h para maximizar el aprovechamiento
 * del plan Max (objetivo: AVG 7d ≥ 90%).
 *
 * Funciones puras que consumen:
 *   - `entries` — output de token-history.readHistory(), cada uno con
 *     {resetsAt, capturedAt, fiveHourPercent, sevenDayPercent, costUsd, model}.
 *     `resetsAt` es Unix seconds (ventana del ciclo: [resetsAt-5h, resetsAt]).
 *   - `events` — eventos del autonomous-orchestrator con {type, at, ...}.
 *     `at` es epoch ms.
 *
 * Salidas: media rolling, clasificación por ciclo, causa probable, ranking
 * peores-primero, buckets diarios, métricas globales.
 */

const CYCLE_HOURS = 5;
const CYCLE_MS = CYCLE_HOURS * 3600 * 1000;
const DAY_MS = 86400000;

const DEFAULT_TARGET_PCT = 90;
const DEFAULT_AVG_WINDOW_DAYS = 7;
const ACCEPTABLE_PCT = 70;

/**
 * Ventana [start, end] en epoch ms del ciclo de 5h que termina en resetsAt.
 * @param {number} resetsAtSec - Unix seconds
 * @returns {{startMs: number, endMs: number}}
 */
function cycleWindow(resetsAtSec) {
  const endMs = resetsAtSec * 1000;
  return { startMs: endMs - CYCLE_MS, endMs };
}

/**
 * Media rolling del uso de 5h en una ventana de N días.
 * @param {Array<{resetsAt: number, fiveHourPercent: number}>} entries
 * @param {{windowDays?: number, now?: number}} [opts]
 * @returns {{avg: number, count: number, windowDays: number, status: 'ok'|'no-data'}}
 */
function computeAverage(entries, opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_AVG_WINDOW_DAYS;
  const now = opts.now ?? Date.now();
  const cutoff = now - windowDays * DAY_MS;
  const inWindow = (entries || []).filter(e => e && (e.resetsAt * 1000) >= cutoff);
  if (!inWindow.length) {
    return { avg: 0, count: 0, windowDays, status: 'no-data' };
  }
  const sum = inWindow.reduce((s, e) => s + (e.fiveHourPercent || 0), 0);
  return {
    avg: Math.round(sum / inWindow.length),
    count: inWindow.length,
    windowDays,
    status: 'ok',
  };
}

/**
 * Clasifica un ciclo por uso.
 *   - optimal: ≥ target
 *   - acceptable: ≥ 70%
 *   - poor: < 70%
 * @param {{fiveHourPercent: number}} entry
 * @param {number} [targetPct]
 * @returns {'optimal'|'acceptable'|'poor'}
 */
function classifyCycle(entry, targetPct = DEFAULT_TARGET_PCT) {
  const p = entry?.fiveHourPercent ?? 0;
  if (p >= targetPct) return 'optimal';
  if (p >= ACCEPTABLE_PCT) return 'acceptable';
  return 'poor';
}

/**
 * Filtra los eventos del orquestador que cayeron dentro del ciclo.
 * @param {Array<{at: number}>} events
 * @param {{resetsAt: number}} entry
 * @returns {Array<any>}
 */
function eventsInCycle(events, entry) {
  if (!events?.length || !entry) return [];
  const { startMs, endMs } = cycleWindow(entry.resetsAt);
  return events.filter(e => e && typeof e.at === 'number' && e.at >= startMs && e.at <= endMs);
}

/**
 * Inferencia de causa probable para un ciclo sub-óptimo.
 * Reglas en orden de especificidad.
 *
 * @param {{fiveHourPercent: number}} entry
 * @param {Array<any>} events
 * @param {number} [targetPct]
 * @returns {{category: string, detail: string}|null} - null si ciclo óptimo
 */
function probableCause(entry, events, targetPct = DEFAULT_TARGET_PCT) {
  const cls = classifyCycle(entry, targetPct);
  if (cls === 'optimal') return null;

  const list = events || [];
  const counts = {
    skillExecuted: list.filter(e => e.type === 'skill-executed').length,
    plannerNoOp: list.filter(e => e.type === 'planner-decision' && e.decision === 'no_op').length,
    plannerError: list.filter(e => e.type === 'planner-decision' && e.error).length,
    analyzeError: list.filter(e => e.type === 'analyze-error').length,
    tickSkipNoActive: list.filter(e => e.type === 'tick-skip' && e.reason === 'no-active-projects').length,
    tickSkipMaint: list.filter(e => e.type === 'tick-skip' && e.reason === 'all-in-maintenance').length,
    tickError: list.filter(e => e.type === 'tick-error').length,
    trip: list.filter(e => e.type === 'circuit-breaker-trip').length,
  };

  // Más específicas primero
  if (counts.tickSkipNoActive > 0 && counts.skillExecuted === 0) {
    return { category: 'no-active-projects', detail: `${counts.tickSkipNoActive} ticks sin proyectos activos` };
  }
  if (counts.tickSkipMaint > counts.plannerNoOp && counts.skillExecuted === 0) {
    return { category: 'all-maintenance', detail: 'todos los proyectos activos en mantenimiento estable' };
  }
  if (counts.trip > 0) {
    return { category: 'circuit-breaker-trips', detail: `${counts.trip} proyecto(s) auto-pausados por fallos` };
  }
  if (counts.tickError > 0) {
    return { category: 'tick-errors', detail: `${counts.tickError} errores fatales en ticks` };
  }
  if (counts.plannerError >= 3) {
    return { category: 'planner-errors', detail: `${counts.plannerError} errores del planner` };
  }
  if (counts.plannerNoOp >= 5) {
    return { category: 'planner-blocked', detail: `planner devolvió no_op ${counts.plannerNoOp} veces` };
  }
  if (counts.skillExecuted === 0 && list.length === 0) {
    return { category: 'no-telemetry', detail: 'sin eventos registrados en este ciclo' };
  }
  if (counts.skillExecuted === 0) {
    return { category: 'no-executions', detail: 'ningún skill ejecutado' };
  }
  if (counts.skillExecuted < 3) {
    return { category: 'low-throughput', detail: `solo ${counts.skillExecuted} skill(s) ejecutados en 5h` };
  }
  return { category: 'unknown', detail: 'causa no identificada — revisar skills ejecutados' };
}

/**
 * Ranking de ciclos, peores primero (uso ascendente), con clasificación
 * y causa probable enriquecidas.
 *
 * @param {Array<any>} entries
 * @param {Array<any>} [events]
 * @param {{targetPct?: number, limit?: number}} [opts]
 */
function rankCycles(entries, events, opts = {}) {
  const targetPct = opts.targetPct ?? DEFAULT_TARGET_PCT;
  const enriched = (entries || []).map(entry => ({
    entry,
    classification: classifyCycle(entry, targetPct),
    cause: probableCause(entry, eventsInCycle(events || [], entry), targetPct),
  }));
  enriched.sort((a, b) => (a.entry.fiveHourPercent || 0) - (b.entry.fiveHourPercent || 0));
  return opts.limit ? enriched.slice(0, opts.limit) : enriched;
}

/**
 * Agrupa por día. Útil para el gráfico 30d.
 * @param {Array<{resetsAt: number, fiveHourPercent: number}>} entries
 * @returns {Array<{day: string, cycles: any[], avg: number}>}
 */
function bucketByDay(entries) {
  const buckets = {};
  for (const e of entries || []) {
    if (!e || typeof e.resetsAt !== 'number') continue;
    const day = new Date(e.resetsAt * 1000).toISOString().slice(0, 10);
    if (!buckets[day]) buckets[day] = { day, cycles: [], avg: 0 };
    buckets[day].cycles.push(e);
  }
  for (const b of Object.values(buckets)) {
    const sum = b.cycles.reduce((s, e) => s + (e.fiveHourPercent || 0), 0);
    b.avg = b.cycles.length ? Math.round(sum / b.cycles.length) : 0;
  }
  return Object.values(buckets).sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Resumen global: media, conteos por clasificación, coste total.
 *
 * @param {Array<any>} entries
 * @param {{targetPct?: number, now?: number, windowDays?: number}} [opts]
 */
function summarize(entries, opts = {}) {
  const targetPct = opts.targetPct ?? DEFAULT_TARGET_PCT;
  const avgResult = computeAverage(entries, opts);
  const classified = { optimal: 0, acceptable: 0, poor: 0 };
  let costUsd = 0;
  for (const e of entries || []) {
    classified[classifyCycle(e, targetPct)]++;
    if (typeof e.costUsd === 'number') costUsd += e.costUsd;
  }
  return {
    avg: avgResult.avg,
    avgCount: avgResult.count,
    avgWindowDays: avgResult.windowDays,
    avgStatus: avgResult.status,
    target: targetPct,
    totalCycles: (entries || []).length,
    counts: classified,
    costUsd: Math.round(costUsd * 100) / 100,
  };
}

module.exports = {
  cycleWindow,
  computeAverage,
  classifyCycle,
  eventsInCycle,
  probableCause,
  rankCycles,
  bucketByDay,
  summarize,
  CYCLE_HOURS,
  DEFAULT_TARGET_PCT,
  DEFAULT_AVG_WINDOW_DAYS,
};
