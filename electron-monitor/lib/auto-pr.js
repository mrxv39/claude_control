/**
 * auto-pr.js — Clasificación de blast radius + reglas de auto-merge / PR
 * automático para los outputs del orquestador autónomo.
 *
 * Blast radius por skill:
 *   - trivial:     cambios casi-seguros (docs, types, gitignore, cleanup puro).
 *                  → auto-merge tras `delayHours` de CI verde.
 *   - meaningful:  cambios útiles pero revisables (tests, audits, perf, deps).
 *                  → `gh pr create` automático con summary; usuario decide merge.
 *   - destructive: refactors grandes o cambios de UI amplios.
 *                  → se queda en rama `claudio/auto/*` hasta decisión manual.
 *
 * Funciones puras + wrappers con DI para los comandos externos (`gh`, `git`).
 */

const { spawn } = require('child_process');

/** Mapa base — overridable vía opts.overrides en classifyBlastRadius */
const BLAST_RADIUS = Object.freeze({
  'audit-claude-md': 'trivial',
  'fix-types': 'trivial',
  'git-cleanup': 'trivial',
  'ccusage': 'trivial',
  'dep-update': 'meaningful',
  'add-tests': 'meaningful',
  'security-review': 'meaningful',
  'ui-polish': 'meaningful',
  'supabase-audit': 'meaningful',
  'perf-audit': 'meaningful',
  'webapp-testing': 'meaningful',
  'trailofbits-security': 'meaningful',
  'pdf': 'meaningful',
  'simplify': 'destructive',
  'frontend-design': 'destructive',
});

const VALID_RADII = Object.freeze(['trivial', 'meaningful', 'destructive']);

const DEFAULT_TRIVIAL_DELAY_HOURS = 24;

/**
 * Clasifica un skill en trivial / meaningful / destructive.
 * Acepta metadata opcional del run (docsOnly, patchOnly, linesChanged) que
 * puede degradar o elevar la clasificación.
 *
 * @param {string} skill
 * @param {{docsOnly?: boolean, patchOnly?: boolean, linesChanged?: number, overrides?: Record<string,string>}} [meta]
 * @returns {'trivial'|'meaningful'|'destructive'}
 */
function classifyBlastRadius(skill, meta = {}) {
  const overrides = meta.overrides || {};
  let base = overrides[skill] || BLAST_RADIUS[skill] || 'meaningful';

  // Hints que pueden degradar (hacerlo menos peligroso)
  if (meta.docsOnly === true) return 'trivial';
  if (meta.patchOnly === true && base === 'meaningful') base = 'trivial';

  // Hints que pueden elevar
  if (typeof meta.linesChanged === 'number' && meta.linesChanged > 500 && base === 'meaningful') {
    base = 'destructive';
  }

  return VALID_RADII.includes(base) ? base : 'meaningful';
}

/**
 * Decide si una rama con cambios trivial debe auto-mergarse ya.
 *
 * @param {'trivial'|'meaningful'|'destructive'} blastRadius
 * @param {{branchAgeHours?: number, ciPassed?: boolean|null, requireCI?: boolean, delayHours?: number}} [opts]
 * @returns {{shouldMerge: boolean, reason: string}}
 */
function shouldAutoMerge(blastRadius, opts = {}) {
  const delayHours = opts.delayHours ?? DEFAULT_TRIVIAL_DELAY_HOURS;
  const requireCI = opts.requireCI !== false; // default true
  const branchAgeHours = opts.branchAgeHours ?? 0;
  const ciPassed = opts.ciPassed;

  if (blastRadius !== 'trivial') {
    return { shouldMerge: false, reason: `blast-radius=${blastRadius}` };
  }
  if (branchAgeHours < delayHours) {
    return { shouldMerge: false, reason: `rama joven (${branchAgeHours}h < ${delayHours}h)` };
  }
  if (requireCI && ciPassed === false) {
    return { shouldMerge: false, reason: 'CI en rojo' };
  }
  if (requireCI && ciPassed == null) {
    // No CI configured → permitir si delay ya pasó (útil para proyectos sin CI)
    return { shouldMerge: true, reason: 'trivial + delay cumplido (sin CI)' };
  }
  return { shouldMerge: true, reason: 'trivial + delay cumplido + CI verde' };
}

/**
 * Decide si hay que abrir PR automáticamente (meaningful).
 * @param {string} blastRadius
 * @returns {boolean}
 */
function shouldCreatePR(blastRadius) {
  return blastRadius === 'meaningful';
}

/**
 * Construye el body markdown de un PR automático.
 * Estable + determinístico para testing.
 *
 * @param {{project: string, skill: string, reasoning: string, diffStats?: string, eventUrl?: string, branch: string}} input
 * @returns {string}
 */
function buildPRBody(input) {
  const lines = [
    '## Generado automáticamente por el orquestador',
    '',
    `**Proyecto:** ${input.project}`,
    `**Skill:** ${input.skill}`,
    `**Rama:** \`${input.branch}\``,
    '',
    '### Por qué',
    input.reasoning || '(sin razonamiento registrado)',
  ];
  if (input.diffStats) {
    lines.push('', '### Cambios', '```', input.diffStats.trim(), '```');
  }
  if (input.eventUrl) {
    lines.push('', `[Ver evento en el Feed](${input.eventUrl})`);
  }
  lines.push('', '---', '', 'Revisa y merge si te encaja. Si no, cierra el PR.');
  return lines.join('\n');
}

function buildPRTitle(input) {
  const skill = input.skill || 'skill';
  const project = input.project || 'proyecto';
  return `auto(${skill}): ${project}`;
}

// ---- Wrappers I/O inyectables ----

function defaultGhRunner(args, cwd, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('gh timeout')); }, timeoutMs);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `gh exit ${code}`)); });
  });
}

/**
 * Crea un PR usando gh CLI.
 *
 * @param {{project: string, projectPath: string, skill: string, branch: string, reasoning: string, diffStats?: string}} input
 * @param {{ghRun?: Function, base?: string}} [opts]
 * @returns {Promise<{ok: boolean, url?: string, error?: string}>}
 */
async function createPR(input, opts = {}) {
  const ghRun = opts.ghRun || defaultGhRunner;
  const base = opts.base || 'master';
  const title = buildPRTitle(input);
  const body = buildPRBody(input);
  try {
    const out = await ghRun(
      ['pr', 'create', '--base', base, '--head', input.branch, '--title', title, '--body', body],
      input.projectPath
    );
    const url = (out.match(/https?:\/\/\S+/) || [])[0] || out;
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

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
 * Merge fast-forward de rama trivial a base.
 * Checkea primero que la rama está adelantada.
 *
 * @param {{projectPath: string, branch: string, base?: string}} input
 * @param {{gitRun?: Function}} [opts]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function autoMergeBranch(input, opts = {}) {
  const gitRun = opts.gitRun || defaultGitRunner;
  const base = input.base || 'master';
  try {
    // Checkout base
    await gitRun(['checkout', base], input.projectPath);
    // Fast-forward merge (no --ff-only if ya está adelantada; sino rechazar)
    await gitRun(['merge', '--ff-only', input.branch], input.projectPath);
    // Delete feature branch local
    await gitRun(['branch', '-d', input.branch], input.projectPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  classifyBlastRadius,
  shouldAutoMerge,
  shouldCreatePR,
  buildPRTitle,
  buildPRBody,
  createPR,
  autoMergeBranch,
  BLAST_RADIUS,
  VALID_RADII,
  DEFAULT_TRIVIAL_DELAY_HOURS,
};
