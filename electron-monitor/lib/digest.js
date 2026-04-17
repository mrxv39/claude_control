/**
 * digest.js — Resumen narrativo de actividad reciente.
 *
 * Dos capas:
 *   1. `aggregateEvents()` — rollup estadístico puro de eventos del
 *      autonomous-orchestrator (runs, fallos, transiciones, trips, no_ops).
 *   2. `generateDigest()` — narración humana usando Haiku (DI) a partir
 *      del rollup. Fallback a resumen plano sin LLM si la invocación falla.
 *
 * Se usa al arrancar la app (briefing matutino), al mandar push Telegram,
 * y como input del feed global.
 */

const { spawn } = require('child_process');

const DAY_MS = 86400000;

/**
 * Agrega eventos del Feed en estadísticas por proyecto / skill / tipo.
 * @param {Array<any>} events
 * @param {{since?: number, until?: number}} [opts]
 */
function aggregateEvents(events, opts = {}) {
  const now = Date.now();
  const until = opts.until ?? now;
  const since = opts.since ?? (until - DAY_MS);
  const inRange = (events || []).filter(e =>
    e && typeof e.at === 'number' && e.at >= since && e.at <= until
  );

  const bySkill = {};
  const byProject = {};
  const byType = {};
  const transitions = [];
  const trips = [];
  const errors = [];
  let totalRuns = 0, successful = 0, failed = 0;

  for (const e of inRange) {
    byType[e.type] = (byType[e.type] || 0) + 1;

    if (e.type === 'skill-executed') {
      totalRuns++;
      if (e.outcome === 'ok') successful++;
      else failed++;

      const skill = e.skill || '?';
      if (!bySkill[skill]) bySkill[skill] = { ok: 0, fail: 0 };
      bySkill[skill][e.outcome === 'ok' ? 'ok' : 'fail']++;

      const proj = e.project || '?';
      if (!byProject[proj]) byProject[proj] = { runs: 0, ok: 0, fail: 0 };
      byProject[proj].runs++;
      byProject[proj][e.outcome === 'ok' ? 'ok' : 'fail']++;
    } else if (e.type === 'goal-reached' || e.type === 'goal-regressed') {
      transitions.push({ project: e.project, template: e.template, type: e.type, at: e.at });
    } else if (e.type === 'circuit-breaker-trip') {
      trips.push({ project: e.project, reason: e.reason, at: e.at });
    } else if (e.type === 'tick-error' || e.type === 'analyze-error') {
      errors.push({ type: e.type, error: e.error, at: e.at });
    }
  }

  return {
    windowStart: since,
    windowEnd: until,
    windowHours: Math.round((until - since) / 3600000),
    totals: { totalRuns, successful, failed },
    bySkill,
    byProject,
    byType,
    transitions,
    trips,
    errors,
  };
}

/**
 * Resumen plano sin LLM. Fallback si el LLM falla o para mostrar
 * en el feed sin gastar tokens.
 * @param {ReturnType<typeof aggregateEvents>} agg
 * @param {{avgPct?: number, targetPct?: number}} [metrics]
 * @returns {string}
 */
function plainDigest(agg, metrics = {}) {
  if (!agg || agg.totals.totalRuns === 0 && !agg.transitions.length && !agg.trips.length) {
    return `Sin actividad en las últimas ${agg?.windowHours ?? 24}h.`;
  }
  const parts = [];
  const t = agg.totals;
  parts.push(`Últimas ${agg.windowHours}h: ${t.totalRuns} skill${t.totalRuns !== 1 ? 's' : ''} ejecutado${t.totalRuns !== 1 ? 's' : ''}, ${t.successful} OK · ${t.failed} FAIL.`);

  const topSkills = Object.entries(agg.bySkill)
    .sort((a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail))
    .slice(0, 3);
  if (topSkills.length) {
    const list = topSkills.map(([s, v]) => `${s} (${v.ok}/${v.ok + v.fail})`).join(', ');
    parts.push(`Skills más activos: ${list}.`);
  }

  if (agg.transitions.length) {
    const reached = agg.transitions.filter(t => t.type === 'goal-reached');
    const regressed = agg.transitions.filter(t => t.type === 'goal-regressed');
    if (reached.length) parts.push(`${reached.length} proyecto${reached.length !== 1 ? 's' : ''} cumplió objetivo: ${reached.map(r => r.project).join(', ')}.`);
    if (regressed.length) parts.push(`${regressed.length} regresión: ${regressed.map(r => r.project).join(', ')}.`);
  }

  if (agg.trips.length) {
    parts.push(`Circuit breaker disparado en: ${agg.trips.map(t => t.project).join(', ')}.`);
  }

  if (agg.errors.length) {
    parts.push(`${agg.errors.length} errores en ticks.`);
  }

  if (typeof metrics.avgPct === 'number') {
    const target = metrics.targetPct ?? 90;
    const status = metrics.avgPct >= target ? '✓' : '⚠';
    parts.push(`AVG uso ${metrics.avgPct}% ${status} (objetivo ${target}%).`);
  }

  return parts.join(' ');
}

function buildDigestPrompt(agg, metrics = {}) {
  const stats = JSON.stringify({
    window_hours: agg.windowHours,
    total_runs: agg.totals.totalRuns,
    successful: agg.totals.successful,
    failed: agg.totals.failed,
    by_skill: agg.bySkill,
    by_project: agg.byProject,
    transitions: agg.transitions.map(t => ({ project: t.project, type: t.type, template: t.template })),
    trips: agg.trips.map(t => ({ project: t.project, reason: t.reason })),
    errors_count: agg.errors.length,
    avg_token_pct: metrics.avgPct ?? null,
    target_pct: metrics.targetPct ?? 90,
  }, null, 2);

  return `Eres un asistente conciso que resume la actividad de un sistema autónomo de tareas de código.

A continuación recibes estadísticas de las últimas ${agg.windowHours} horas. Genera un briefing de 2-3 frases en español neutro. Destaca:
  - Volumen de trabajo y tasa de éxito
  - Proyectos que cumplieron objetivo o regresionaron
  - Circuit breaker disparado (si hay)
  - Si el AVG de tokens está por debajo del objetivo, menciónalo

NO uses markdown. NO uses listas. Solo prosa natural, corta, directa.

\`\`\`json
${stats}
\`\`\``;
}

/**
 * Limpia la respuesta del LLM (quita fences, prosa extra).
 * @param {string} raw
 * @returns {string}
 */
function cleanDigestText(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.trim();
  const fence = t.match(/```(?:markdown)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // Si hay un párrafo "claro", quédate con él. Sino el texto entero.
  return t.split('\n\n')[0].trim();
}

// ---- Invocación ----

function defaultInvoke(model, prompt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 45000;
  return new Promise((resolve, reject) => {
    const args = [
      '--print', '-p', prompt,
      '--model', model,
      '--max-turns', '1',
      '--output-format', 'text',
      '--dangerously-skip-permissions',
    ];
    const proc = spawn('claude', args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    proc.stdin.end();
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('digest timeout')); }, timeoutMs);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.slice(0, 200))); });
  });
}

/**
 * Genera un digest narrativo. Usa Haiku por default (barato + rápido para resumen).
 *
 * @param {Array<any>} events
 * @param {{invoke?: Function, metrics?: any, since?: number, until?: number, cwd?: string, useLLM?: boolean}} [opts]
 * @returns {Promise<{text: string, source: 'llm'|'plain', agg: any}>}
 */
async function generateDigest(events, opts = {}) {
  const agg = aggregateEvents(events, opts);
  const useLLM = opts.useLLM !== false; // default true
  if (!useLLM || agg.totals.totalRuns === 0 && !agg.transitions.length && !agg.trips.length) {
    return { text: plainDigest(agg, opts.metrics), source: 'plain', agg };
  }
  const invoke = opts.invoke || defaultInvoke;
  try {
    const prompt = buildDigestPrompt(agg, opts.metrics);
    const raw = await invoke('haiku', prompt, { cwd: opts.cwd });
    const text = cleanDigestText(raw);
    if (!text) return { text: plainDigest(agg, opts.metrics), source: 'plain', agg };
    return { text, source: 'llm', agg };
  } catch (e) {
    return { text: plainDigest(agg, opts.metrics), source: 'plain', agg };
  }
}

module.exports = {
  aggregateEvents,
  plainDigest,
  buildDigestPrompt,
  cleanDigestText,
  generateDigest,
};
