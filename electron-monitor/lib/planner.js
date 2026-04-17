/**
 * planner.js — LLM planner del orquestador autónomo.
 *
 * Decide qué skill ejecutar en qué proyecto activo en cada tick. Usa un router
 * dinámico de modelos (haiku / sonnet / opus) según complejidad de la decisión,
 * construye un prompt estructurado, llama a Claude CLI (inyectable para tests),
 * parsea la respuesta JSON de forma robusta y aplica guardrails (no repetir el
 * mismo skill <72h).
 *
 * API pública:
 *   - routeModel(state)            → 'haiku' | 'sonnet' | 'opus'
 *   - buildPrompt(state)           → string
 *   - parseResponse(rawText)       → {decision, project?, skill?, reasoning, error?}
 *   - applyGuardrails(decision, c) → {valid, reason}
 *   - decide(state, opts)          → async, full flow
 *
 * @typedef {Object} PlannerProject
 * @property {string} name
 * @property {string} path
 * @property {string} stack
 * @property {{template: string, note?: string}} objective
 * @property {{met: boolean, satisfied: number, total: number, criteria: Array<{id,label,met,detail}>}} evaluation
 * @property {string[]} preferredSkills
 * @property {Array<{skill: string, at: number, outcome: 'ok'|'fail'}>} recentHistory
 *
 * @typedef {Object} PlannerConstraints
 * @property {Array<{project: string, skill: string, availableAt: number}>} blockedExecutions
 *
 * @typedef {Object} PlannerState
 * @property {PlannerProject[]} activeProjects
 * @property {PlannerConstraints} [constraints]
 * @property {number} [now] - epoch ms, inyectable para tests
 *
 * @typedef {Object} PlannerDecision
 * @property {'run'|'no_op'} decision
 * @property {string} [project]
 * @property {string} [skill]
 * @property {string} reasoning
 * @property {string} [error]
 */

const { spawn } = require('child_process');
const goals = require('./goals');

const DAY_MS = 86400000;
const COOLDOWN_MS = 72 * 3600 * 1000; // 72h

// ---- Router de modelos ----

/**
 * Elige modelo según complejidad de la decisión.
 *   - haiku: caso trivial (1 proyecto activo, objetivo mecánico, criterios claros)
 *   - sonnet: default (caso 80%)
 *   - opus: creativo / ambiguo (nota libre significativa, explorar-idea, atasco)
 *
 * @param {PlannerState} state
 * @returns {'haiku'|'sonnet'|'opus'}
 */
function routeModel(state) {
  const active = state?.activeProjects || [];
  if (active.length === 0) return 'haiku';

  // Opus si cualquier proyecto activo requiere creatividad
  for (const p of active) {
    const tpl = p.objective?.template;
    if (tpl === 'explorar-idea') return 'opus';
    const note = p.objective?.note;
    if (note && /explor|prototip|idea|experiment|investig|creat/i.test(note)) return 'opus';
  }

  // Haiku si todo es muy simple: 1 proyecto, pocos criterios no cumplidos, sin nota
  if (active.length === 1) {
    const p = active[0];
    const unmetCount = p.evaluation?.criteria?.filter(c => !c.met).length ?? 0;
    if (unmetCount <= 2 && !p.objective?.note) return 'haiku';
  }

  return 'sonnet';
}

// ---- Construcción del prompt ----

function formatProject(p) {
  const obj = p.objective;
  const objLine = obj?.note
    ? `${obj.template} — "${obj.note}"`
    : obj?.template || '(sin objetivo)';
  const unmet = (p.evaluation?.criteria || []).filter(c => !c.met);
  const unmetLines = unmet.length
    ? unmet.map(c => `    - ${c.id}: ${c.detail}`).join('\n')
    : '    (todos los criterios cumplidos)';
  const skills = (p.preferredSkills || []).join(', ') || '(ninguno sugerido)';
  const recent = (p.recentHistory || []).slice(-5);
  const histLines = recent.length
    ? recent.map(h => `    - ${h.skill} (${h.outcome})`).join('\n')
    : '    (sin actividad reciente)';
  return [
    `### ${p.name}`,
    `  Objetivo: ${objLine}`,
    `  Cumplimiento: ${p.evaluation?.satisfied ?? 0}/${p.evaluation?.total ?? 0}`,
    `  Criterios no cumplidos:`,
    unmetLines,
    `  Skills preferidos: ${skills}`,
    `  Historial últimas 24h:`,
    histLines,
  ].join('\n');
}

function formatConstraints(constraints, now) {
  const blocked = (constraints?.blockedExecutions || []).filter(b => b.availableAt > now);
  if (!blocked.length) return '(ninguna)';
  return blocked.map(b => `  - ${b.project}:${b.skill} (disponible en ${Math.round((b.availableAt - now) / 3600000)}h)`).join('\n');
}

/**
 * @param {PlannerState} state
 * @returns {string}
 */
function buildPrompt(state) {
  const now = state.now ?? Date.now();
  const active = state.activeProjects || [];

  if (!active.length) {
    return `No hay proyectos activos. Responde SOLO con JSON:\n{"decision": "no_op", "reasoning": "sin proyectos activos"}`;
  }

  const projectsBlock = active.map(formatProject).join('\n\n');
  const constraintsBlock = formatConstraints(state.constraints, now);

  return `Eres el planner de un orquestador autónomo que ejecuta tareas de ingeniería en proyectos de código sin supervisión humana continua.

Tu tarea: dado el estado actual de proyectos activos, decide qué skill ejecutar en qué proyecto AHORA para avanzar hacia los objetivos.

## Proyectos activos

${projectsBlock}

## Restricciones (no ejecutar)

${constraintsBlock}

## Reglas de decisión

1. Prioriza criterios no cumplidos del proyecto con objetivo más desalineado.
2. Elige skill de los "preferidos" del proyecto siempre que sea posible.
3. Evita repetir skills ejecutados con éxito en las últimas 24h del historial.
4. Respeta las restricciones (son cooldowns por 72h tras ejecución previa).
5. Si no hay nada útil que hacer ahora, responde con "no_op" y una razón breve.

## Formato de respuesta

Responde SOLO con un objeto JSON, SIN markdown, SIN prosa adicional:

{"decision": "run", "project": "<nombre>", "skill": "<nombre-skill>", "reasoning": "<1-2 frases explicando por qué>"}

o:

{"decision": "no_op", "reasoning": "<1 frase explicando por qué no hay acción>"}`;
}

// ---- Parseo robusto de respuesta ----

/**
 * Extrae el primer objeto JSON balanceado en un texto, ignorando fences de markdown
 * y prosa adicional antes o después.
 *
 * @param {string} rawText
 * @returns {PlannerDecision}
 */
function parseResponse(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { decision: 'no_op', reasoning: 'respuesta vacía del planner', error: 'empty' };
  }

  // Quitar fences de markdown si están presentes
  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Buscar primer objeto JSON balanceado
  const start = text.indexOf('{');
  if (start === -1) {
    return { decision: 'no_op', reasoning: 'respuesta sin JSON', error: 'no-json' };
  }
  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) {
    return { decision: 'no_op', reasoning: 'JSON mal formado', error: 'unbalanced' };
  }

  const jsonStr = text.slice(start, end + 1);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { decision: 'no_op', reasoning: 'JSON inválido', error: 'parse-error' };
  }

  // Validar shape mínimo
  const decision = parsed.decision;
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  if (decision !== 'run' && decision !== 'no_op') {
    return { decision: 'no_op', reasoning: reasoning || 'decision inválida', error: 'invalid-decision' };
  }
  if (decision === 'run') {
    if (!parsed.project || !parsed.skill) {
      return { decision: 'no_op', reasoning: reasoning || 'run sin project/skill', error: 'missing-fields' };
    }
    return { decision: 'run', project: parsed.project, skill: parsed.skill, reasoning };
  }
  return { decision: 'no_op', reasoning: reasoning || 'sin acción' };
}

// ---- Guardrails ----

/**
 * Valida que la decisión no repita un skill en cooldown.
 *
 * @param {PlannerDecision} decision
 * @param {PlannerConstraints} constraints
 * @param {number} [now]
 * @returns {{valid: boolean, reason: string}}
 */
function applyGuardrails(decision, constraints, now) {
  if (decision.decision !== 'run') return { valid: true, reason: '' };
  const t = now ?? Date.now();
  const blocked = (constraints?.blockedExecutions || []).find(
    b => b.project === decision.project && b.skill === decision.skill && b.availableAt > t
  );
  if (blocked) {
    const hours = Math.round((blocked.availableAt - t) / 3600000);
    return { valid: false, reason: `cooldown de ${decision.project}:${decision.skill} (${hours}h restantes)` };
  }
  return { valid: true, reason: '' };
}

/**
 * Construye la lista de `blockedExecutions` a partir del historial reciente
 * de todos los proyectos. Cada ejecución OK aplica cooldown de 72h al mismo
 * {project, skill}.
 *
 * @param {Array<{project: string, skill: string, at: number, outcome: string}>} globalHistory
 * @param {number} [cooldownMs]
 * @returns {Array<{project: string, skill: string, availableAt: number}>}
 */
function buildConstraints(globalHistory, cooldownMs = COOLDOWN_MS) {
  if (!Array.isArray(globalHistory)) return [];
  return globalHistory
    .filter(h => h && h.outcome === 'ok' && h.project && h.skill && typeof h.at === 'number')
    .map(h => ({ project: h.project, skill: h.skill, availableAt: h.at + cooldownMs }));
}

// ---- Invocación real de Claude CLI ----

/**
 * Invocador default — llama al CLI `claude --print --model X`.
 * @param {'haiku'|'sonnet'|'opus'} model
 * @param {string} prompt
 * @param {{timeoutMs?: number, cwd?: string}} [opts]
 * @returns {Promise<string>}
 */
function defaultInvoke(model, prompt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120000;
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '-p', prompt,
      '--model', model,
      '--max-turns', '1',
      '--output-format', 'text',
      '--dangerously-skip-permissions',
    ];
    const proc = spawn('claude', args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    proc.stdin.end();
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error(`planner timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`planner exit ${code}: ${err.slice(0, 200)}`));
      resolve(out);
    });
  });
}

// ---- Flujo completo ----

/**
 * Decide la próxima acción. Flujo completo con fallback seguro ante fallos.
 *
 * @param {PlannerState} state
 * @param {{invoke?: (m: string, p: string, o?: any) => Promise<string>, cwd?: string, timeoutMs?: number, modelOverride?: string}} [opts]
 * @returns {Promise<PlannerDecision & {model: string}>}
 */
async function decide(state, opts = {}) {
  const invoke = opts.invoke || defaultInvoke;
  const model = opts.modelOverride || routeModel(state);

  if (!state?.activeProjects?.length) {
    return { decision: 'no_op', reasoning: 'sin proyectos activos', model };
  }

  const prompt = buildPrompt(state);
  let raw;
  try {
    raw = await invoke(model, prompt, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  } catch (e) {
    return { decision: 'no_op', reasoning: `invocación fallida: ${e.message}`, error: 'invoke-error', model };
  }

  const parsed = parseResponse(raw);
  const guardrail = applyGuardrails(parsed, state.constraints, state.now);
  if (!guardrail.valid) {
    return { decision: 'no_op', reasoning: guardrail.reason, error: 'guardrail', model };
  }
  return { ...parsed, model };
}

module.exports = {
  routeModel,
  buildPrompt,
  parseResponse,
  applyGuardrails,
  buildConstraints,
  decide,
  COOLDOWN_MS,
};
