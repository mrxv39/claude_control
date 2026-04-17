/**
 * planner-learner.js — Extrae patrones del historial de ejecuciones para que
 * el planner se auto-calibre sin intervención del usuario.
 *
 * Idea: si `audit-claude-md` falla 4/5 veces en proyectos Tauri con template
 * `production-ready`, el planner debería evitar esa combinación. Detectamos
 * patrones estadísticamente significativos (sample ≥ N, desviación del
 * success rate global ≥ Δ) y los formateamos como "lecciones aprendidas"
 * que se inyectan en el prompt.
 *
 * Módulo puro.
 *
 * @typedef {Object} ExecutionRecord
 * @property {string} skill
 * @property {string} [stack] - 'node'|'python'|'tauri+rust'|...
 * @property {string} [template] - 'production-ready'|...
 * @property {'ok'|'fail'} outcome
 * @property {number} at
 * @property {number} [scoreBefore]
 * @property {number} [scoreAfter]
 *
 * @typedef {Object} Pattern
 * @property {string} skill
 * @property {string|null} stack
 * @property {string|null} template
 * @property {number} runs
 * @property {number} successes
 * @property {number} successRate - 0..1
 * @property {number} deviation - vs global rate (positivo = mejor, negativo = peor)
 * @property {'positive'|'negative'} direction
 * @property {number} confidence - 0..1 aprox, basada en sample size
 */

const DEFAULT_MIN_SAMPLE = 3;
const DEFAULT_MIN_DEVIATION = 0.25;
const DEFAULT_MAX_LESSONS = 5;

function globalSuccessRate(history) {
  if (!history?.length) return 0.5;
  const ok = history.filter(h => h.outcome === 'ok').length;
  return ok / history.length;
}

/**
 * Genera grupos según las dimensiones pedidas (skill siempre; stack/template opcionales).
 * @param {ExecutionRecord[]} history
 * @returns {Map<string, {key: {skill, stack, template}, records: ExecutionRecord[]}>}
 */
function groupByDimensions(history) {
  const groups = new Map();
  const push = (key, record) => {
    const sig = JSON.stringify(key);
    if (!groups.has(sig)) groups.set(sig, { key, records: [] });
    groups.get(sig).records.push(record);
  };

  for (const r of history || []) {
    if (!r || !r.skill) continue;
    // Siempre por skill solo
    push({ skill: r.skill, stack: null, template: null }, r);
    // Por skill + stack si disponible
    if (r.stack) push({ skill: r.skill, stack: r.stack, template: null }, r);
    // Por skill + template
    if (r.template) push({ skill: r.skill, stack: null, template: r.template }, r);
    // Por skill + stack + template (más específico)
    if (r.stack && r.template) push({ skill: r.skill, stack: r.stack, template: r.template }, r);
  }
  return groups;
}

/**
 * Extrae patrones estadísticamente significativos del historial.
 *
 * @param {ExecutionRecord[]} history
 * @param {{minSample?: number, minDeviation?: number}} [opts]
 * @returns {Pattern[]}
 */
function extractPatterns(history, opts = {}) {
  const minSample = opts.minSample ?? DEFAULT_MIN_SAMPLE;
  const minDeviation = opts.minDeviation ?? DEFAULT_MIN_DEVIATION;
  const global = globalSuccessRate(history);

  const patterns = [];
  const groups = groupByDimensions(history);
  for (const { key, records } of groups.values()) {
    if (records.length < minSample) continue;
    const successes = records.filter(r => r.outcome === 'ok').length;
    const rate = successes / records.length;
    const deviation = rate - global;
    if (Math.abs(deviation) < minDeviation) continue;

    const confidence = Math.min(1, records.length / 10);
    patterns.push({
      skill: key.skill,
      stack: key.stack,
      template: key.template,
      runs: records.length,
      successes,
      successRate: Math.round(rate * 100) / 100,
      deviation: Math.round(deviation * 100) / 100,
      direction: deviation > 0 ? 'positive' : 'negative',
      confidence: Math.round(confidence * 100) / 100,
    });
  }

  // Orden: patrones negativos más fuertes primero (más importante evitar errores),
  // luego positivos. Dentro, desvío absoluto desc + confianza desc.
  patterns.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === 'negative' ? -1 : 1;
    const devDiff = Math.abs(b.deviation) - Math.abs(a.deviation);
    if (Math.abs(devDiff) > 0.01) return devDiff;
    return b.confidence - a.confidence;
  });

  return patterns;
}

/**
 * Convierte un patrón en una frase humana/planner-readable.
 * @param {Pattern} p
 * @returns {string}
 */
function describePattern(p) {
  const context = [
    p.stack ? `stack ${p.stack}` : null,
    p.template ? `template ${p.template}` : null,
  ].filter(Boolean).join(' + ');
  const where = context ? ` en ${context}` : '';
  const rate = `${Math.round(p.successRate * 100)}% éxito (${p.successes}/${p.runs})`;
  if (p.direction === 'negative') {
    return `Evitar \`${p.skill}\`${where}: ${rate}.`;
  }
  return `Preferir \`${p.skill}\`${where}: ${rate}.`;
}

/**
 * Genera el bloque "lecciones aprendidas" que se inyecta en el prompt del planner.
 * Limita a `maxLessons` para no saturar. Prefiere patrones más específicos
 * (con stack + template) frente a los generales.
 *
 * @param {Pattern[]} patterns
 * @param {{maxLessons?: number}} [opts]
 * @returns {string}
 */
function formatLessons(patterns, opts = {}) {
  const max = opts.maxLessons ?? DEFAULT_MAX_LESSONS;
  if (!patterns?.length) return '';
  // Prefiere específicos: mayor número de dimensiones no-null primero
  const specificity = p => (p.stack ? 1 : 0) + (p.template ? 1 : 0);
  const sorted = [...patterns].sort((a, b) => {
    const s = specificity(b) - specificity(a);
    if (s !== 0) return s;
    return Math.abs(b.deviation) - Math.abs(a.deviation);
  });
  const top = sorted.slice(0, max);
  return top.map(describePattern).join('\n');
}

/**
 * Shortcut: history → lessons string.
 * @param {ExecutionRecord[]} history
 * @param {{minSample?: number, minDeviation?: number, maxLessons?: number}} [opts]
 * @returns {string}
 */
function learnLessons(history, opts = {}) {
  const patterns = extractPatterns(history, opts);
  return formatLessons(patterns, opts);
}

module.exports = {
  extractPatterns,
  formatLessons,
  describePattern,
  learnLessons,
  globalSuccessRate,
  DEFAULT_MIN_SAMPLE,
  DEFAULT_MIN_DEVIATION,
  DEFAULT_MAX_LESSONS,
};
