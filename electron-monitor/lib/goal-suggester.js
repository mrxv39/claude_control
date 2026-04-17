/**
 * goal-suggester.js — Sugiere plantilla de objetivo para un proyecto
 * basándose en su estado actual. Dos capas:
 *
 *   1. Heurística local (pura, gratis): clasifica por stack + actividad +
 *      cobertura sin llamar al LLM. Cubre el 70% de casos.
 *   2. LLM (Sonnet, inyectable): reservado para casos ambiguos o cuando
 *      la heurística devuelve baja confianza.
 *
 * El onboarding pasa de "elige plantilla entre 5 para cada uno de tus 38
 * proyectos" a "acepta/edita/salta la sugerencia".
 *
 * @typedef {Object} ProjectInfo
 * @property {string} name
 * @property {string} path
 * @property {string} stack - 'node'|'python'|'tauri+rust'|'electron'|...
 * @property {string} [readme] - contenido de README.md (truncado)
 * @property {Object} [packageManifest] - package.json | Cargo.toml parseado
 * @property {number} [recentCommits] - commits en últimos 14d
 * @property {number} [lastCommitDays] - días desde último commit
 * @property {{hasClaude: boolean, hasTests: boolean, hasGitignore: boolean, gitClean: boolean|null, depsOk: boolean|null}} [checks]
 * @property {number} [score]
 *
 * @typedef {Object} Suggestion
 * @property {'production-ready'|'MVP-lanzable'|'mantenimiento'|'explorar-idea'|'seguro-y-testeado'} template
 * @property {string} [note]
 * @property {number} confidence - 0..1
 * @property {string} reasoning
 * @property {'heuristic'|'llm'} source
 */

const { spawn } = require('child_process');

const VALID_TEMPLATES = Object.freeze([
  'production-ready',
  'MVP-lanzable',
  'mantenimiento',
  'explorar-idea',
  'seguro-y-testeado',
]);

// ---- Heurística local ----

/**
 * Heurística sin LLM. Señales:
 *   - Muchos commits recientes + tests → MVP-lanzable (desarrollo activo)
 *   - Score alto estable + commits esporádicos → mantenimiento
 *   - Sin tests + sin CLAUDE.md + poca actividad → explorar-idea
 *   - Menciones de "auth", "pagos", "API pública" en README → seguro-y-testeado
 *   - Score alto + tests + CLAUDE.md + deps ok → production-ready
 *
 * @param {ProjectInfo} info
 * @returns {Suggestion}
 */
function heuristicSuggest(info) {
  const checks = info?.checks || {};
  const score = info?.score ?? 5;
  const commits = info?.recentCommits ?? 0;
  const lastDays = info?.lastCommitDays ?? 999;
  const readme = (info?.readme || '').toLowerCase();

  // Señal de dominio sensible → seguro-y-testeado
  if (/auth|login|password|pagos?|payment|stripe|lightning|oauth|jwt|token|api pública|api publica/.test(readme)) {
    return {
      template: 'seguro-y-testeado',
      confidence: 0.8,
      reasoning: 'README menciona dominio sensible (auth, pagos, API pública o tokens)',
      source: 'heuristic',
    };
  }

  // Proyecto maduro sin nada que hacer → production-ready si llega a criterios
  if (score >= 8 && checks.hasClaude && checks.hasTests && checks.depsOk) {
    return {
      template: 'production-ready',
      confidence: 0.85,
      reasoning: `Score ${score}/10, tests, CLAUDE.md y deps al día — listo para estabilizar producción`,
      source: 'heuristic',
    };
  }

  // Desarrollo activo (commits recientes) + algo de tests → MVP-lanzable
  if (commits >= 3 && (checks.hasTests || score >= 6)) {
    return {
      template: 'MVP-lanzable',
      confidence: 0.75,
      reasoning: `${commits} commits en últimos 14d — proyecto en desarrollo activo hacia MVP`,
      source: 'heuristic',
    };
  }

  // Proyecto estable con score medio-alto y baja actividad → mantenimiento
  if (score >= 6 && lastDays > 14 && lastDays < 90) {
    return {
      template: 'mantenimiento',
      confidence: 0.7,
      reasoning: `Score ${score}/10, último commit hace ${lastDays}d — proyecto estable que solo requiere mantenimiento`,
      source: 'heuristic',
    };
  }

  // Sin CLAUDE.md + sin tests + poca actividad → explorar-idea
  if (!checks.hasClaude && !checks.hasTests && commits < 3) {
    return {
      template: 'explorar-idea',
      confidence: 0.6,
      reasoning: 'Sin CLAUDE.md, sin tests y poca actividad — parece un experimento o idea temprana',
      source: 'heuristic',
    };
  }

  // Fallback: MVP-lanzable con baja confianza
  return {
    template: 'MVP-lanzable',
    confidence: 0.35,
    reasoning: 'Heurística sin señal clara — MVP-lanzable como default seguro',
    source: 'heuristic',
  };
}

// ---- Prompt + parseo LLM ----

function summarizePackageManifest(pm) {
  if (!pm || typeof pm !== 'object') return '(sin manifest)';
  const parts = [];
  if (pm.name) parts.push(`name: ${pm.name}`);
  if (pm.description) parts.push(`desc: ${pm.description}`);
  if (Array.isArray(pm.keywords) && pm.keywords.length) parts.push(`keywords: ${pm.keywords.slice(0, 6).join(', ')}`);
  if (pm.scripts && typeof pm.scripts === 'object') {
    const keys = Object.keys(pm.scripts).slice(0, 8);
    if (keys.length) parts.push(`scripts: ${keys.join(', ')}`);
  }
  return parts.length ? parts.join(' · ') : '(manifest vacío)';
}

/**
 * Construye el prompt para el LLM.
 * @param {ProjectInfo} info
 * @returns {string}
 */
function buildSuggestionPrompt(info) {
  const readme = (info?.readme || '').trim().slice(0, 800);
  const manifest = summarizePackageManifest(info?.packageManifest);
  const checks = info?.checks || {};
  const checksStr = [
    checks.hasClaude ? 'CLAUDE.md:✓' : 'CLAUDE.md:✗',
    checks.hasTests ? 'tests:✓' : 'tests:✗',
    checks.hasGitignore ? '.gitignore:✓' : '.gitignore:✗',
    checks.gitClean === true ? 'git:clean' : checks.gitClean === false ? 'git:dirty' : 'git:?',
    checks.depsOk === true ? 'deps:up' : checks.depsOk === false ? 'deps:stale' : 'deps:?',
  ].join(' · ');

  return `Clasifica el siguiente proyecto en una de estas plantillas de objetivo:

1. **production-ready**: listo para producción estable (apps/librerías maduras)
2. **MVP-lanzable**: mínimo viable en desarrollo activo hacia un lanzamiento
3. **mantenimiento**: estable, solo evitar que se rompa
4. **explorar-idea**: prototipo / research / experimento
5. **seguro-y-testeado**: dominio sensible (auth, pagos, API pública, datos personales)

## Proyecto

- **name**: ${info?.name || '?'}
- **stack**: ${info?.stack || '?'}
- **score**: ${info?.score ?? '?'}/10
- **commits últimos 14d**: ${info?.recentCommits ?? '?'}
- **último commit hace**: ${info?.lastCommitDays ?? '?'}d
- **checks**: ${checksStr}
- **manifest**: ${manifest}

### README (primeros 800 chars)
${readme || '(sin README)'}

## Responde SOLO con JSON, sin prosa:

{"template": "<nombre>", "note": "<nota breve o vacío>", "confidence": 0.0-1.0, "reasoning": "<1-2 frases>"}`;
}

/**
 * Parsea la respuesta del LLM. Tolera fences y preámbulo como planner.parseResponse.
 * @param {string} rawText
 * @returns {Suggestion}
 */
function parseSuggestion(rawText) {
  const fallback = (reason) => ({
    template: 'MVP-lanzable',
    note: '',
    confidence: 0.2,
    reasoning: `(sugeridor fallback: ${reason})`,
    source: 'llm',
  });

  if (typeof rawText !== 'string' || !rawText.trim()) return fallback('respuesta vacía');

  let text = rawText.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return fallback('sin JSON');
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return fallback('JSON sin cerrar');

  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch { return fallback('JSON inválido'); }

  if (!VALID_TEMPLATES.includes(parsed.template)) return fallback(`template inválido: ${parsed.template}`);
  const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
  return {
    template: parsed.template,
    note: typeof parsed.note === 'string' ? parsed.note : '',
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    source: 'llm',
  };
}

// ---- Invocación LLM ----

function defaultInvoke(model, prompt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
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
    const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error(`suggester timeout ${timeoutMs}ms`)); }, timeoutMs);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.slice(0, 200))); });
  });
}

/**
 * Flujo completo: intenta heurística primero; si la confianza es baja
 * (< confidenceThreshold) invoca LLM. Fallback siempre a la heurística.
 *
 * @param {ProjectInfo} info
 * @param {{invoke?: Function, confidenceThreshold?: number, alwaysLLM?: boolean, cwd?: string}} [opts]
 * @returns {Promise<Suggestion>}
 */
async function suggest(info, opts = {}) {
  const heuristic = heuristicSuggest(info);
  const threshold = opts.confidenceThreshold ?? 0.6;
  if (!opts.alwaysLLM && heuristic.confidence >= threshold) return heuristic;

  const invoke = opts.invoke || defaultInvoke;
  try {
    const prompt = buildSuggestionPrompt(info);
    const raw = await invoke('sonnet', prompt, { cwd: opts.cwd });
    const llm = parseSuggestion(raw);
    // Si el LLM tiene baja confianza, prefiere la heurística (más explicable)
    return llm.confidence > heuristic.confidence ? llm : heuristic;
  } catch (e) {
    return {
      ...heuristic,
      reasoning: `${heuristic.reasoning} (LLM falló: ${e.message})`,
    };
  }
}

module.exports = {
  heuristicSuggest,
  buildSuggestionPrompt,
  parseSuggestion,
  suggest,
  VALID_TEMPLATES,
};
