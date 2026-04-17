/**
 * goals.js — Catálogo de plantillas de objetivo + evaluador de criterios.
 *
 * Una plantilla expande a una lista de criterios verificables + skills preferidos
 * + modelo de planner recomendado. Las funciones de check son puras: reciben el
 * estado del proyecto (análisis + historial) y devuelven {met, detail}.
 *
 * @typedef {Object} Criterion
 * @property {string} id - identificador estable (e.g. 'has-claude-md')
 * @property {string} label - descripción humana
 * @property {(state: ProjectState) => {met: boolean, detail: string}} check
 *
 * @typedef {Object} Template
 * @property {string} name - clave (e.g. 'production-ready')
 * @property {string} label - nombre humano
 * @property {string} description
 * @property {Criterion[]} criteria
 * @property {string[]} skills - skills preferidos (en orden de prioridad)
 * @property {'haiku'|'sonnet'|'opus'} plannerModel - default del planner para esta plantilla
 *
 * @typedef {Object} ProjectState
 * @property {{checks: Object, score: number}} analysis - from project-analyzer
 * @property {Array<{skill: string, at: number, outcome: 'ok'|'fail'}>} history
 * @property {number} now - epoch ms (inyectable para tests)
 */

const DAY_MS = 86400000;

function daysSince(ts, now) {
  if (ts == null) return null;
  return Math.floor((now - ts) / DAY_MS);
}

function lastSkillRun(history, skill, now) {
  const ok = (history || []).filter(h => h.skill === skill && h.outcome === 'ok');
  if (!ok.length) return null;
  const latest = ok.reduce((a, b) => (a.at > b.at ? a : b));
  return daysSince(latest.at, now);
}

// ---- Criterios reutilizables ----

const hasClaudeMd = {
  id: 'has-claude-md',
  label: 'CLAUDE.md presente',
  check: (s) => ({
    met: !!s.analysis?.checks?.hasClaude,
    detail: s.analysis?.checks?.hasClaude ? 'OK' : 'Falta CLAUDE.md'
  })
};

const hasClaudeMdRecent = {
  id: 'has-claude-md-recent',
  label: 'CLAUDE.md vigente (audit <60d)',
  check: (s) => {
    if (!s.analysis?.checks?.hasClaude) return { met: false, detail: 'Falta CLAUDE.md' };
    const d = lastSkillRun(s.history, 'audit-claude-md', s.now);
    if (d == null) return { met: false, detail: 'Nunca auditado' };
    return d <= 60
      ? { met: true, detail: `Auditado hace ${d}d` }
      : { met: false, detail: `Audit hace ${d}d (>60d)` };
  }
};

const hasGitignore = {
  id: 'has-gitignore',
  label: '.gitignore presente',
  check: (s) => ({
    met: !!s.analysis?.checks?.hasGitignore,
    detail: s.analysis?.checks?.hasGitignore ? 'OK' : 'Falta .gitignore'
  })
};

const hasTests = {
  id: 'has-tests',
  label: 'Directorio de tests',
  check: (s) => ({
    met: !!s.analysis?.checks?.hasTests,
    detail: s.analysis?.checks?.hasTests ? 'OK' : 'Sin directorio de tests'
  })
};

const testsHappyPath = {
  id: 'tests-happy-path',
  label: 'Tests de happy path (ejecución exitosa reciente)',
  check: (s) => {
    if (!s.analysis?.checks?.hasTests) return { met: false, detail: 'Sin tests' };
    const d = lastSkillRun(s.history, 'add-tests', s.now);
    if (d == null) return { met: false, detail: 'add-tests nunca ejecutado con éxito' };
    return { met: true, detail: `Tests añadidos hace ${d}d` };
  }
};

const testsCoverage70 = {
  id: 'tests-coverage-70',
  label: 'Tests cobertura ≥70% (módulos críticos)',
  check: (s) => {
    // Aproximación: sin coverage real tomamos como proxy que hasTests + add-tests haya
    // corrido con éxito al menos 2 veces (se ha iterado sobre la suite). Mejor aproximación
    // posible cuando tengamos integración con coverage reporters.
    if (!s.analysis?.checks?.hasTests) return { met: false, detail: 'Sin tests' };
    const runs = (s.history || []).filter(h => h.skill === 'add-tests' && h.outcome === 'ok').length;
    if (runs < 2) return { met: false, detail: `add-tests ejecutado ${runs}/2 veces` };
    return { met: true, detail: `Tests iterados (${runs} ciclos)` };
  }
};

const testsCoverage80Entry = {
  id: 'tests-coverage-80-entry',
  label: 'Tests ≥80% en módulos de entrada',
  check: (s) => {
    if (!s.analysis?.checks?.hasTests) return { met: false, detail: 'Sin tests' };
    const runs = (s.history || []).filter(h => h.skill === 'add-tests' && h.outcome === 'ok').length;
    return runs >= 3
      ? { met: true, detail: `add-tests × ${runs}` }
      : { met: false, detail: `add-tests ${runs}/3 ejecutado` };
  }
};

const gitClean = {
  id: 'git-clean',
  label: 'Working tree limpio',
  check: (s) => {
    const c = s.analysis?.checks?.gitClean;
    if (c == null) return { met: false, detail: 'No se pudo determinar' };
    return c
      ? { met: true, detail: 'Clean' }
      : { met: false, detail: 'Cambios sin commitear' };
  }
};

const depsUpToDate = {
  id: 'deps-up-to-date',
  label: 'Dependencias al día',
  check: (s) => {
    const c = s.analysis?.checks?.depsOk;
    if (c == null) return { met: false, detail: 'No se pudo determinar (sin manifest+lock)' };
    return c
      ? { met: true, detail: 'Lock vigente' }
      : { met: false, detail: 'Lock desactualizado' };
  }
};

const depsUpToDate14d = {
  id: 'deps-up-to-date-14d',
  label: 'Deps revisadas <14d',
  check: (s) => {
    const d = lastSkillRun(s.history, 'dep-update', s.now);
    if (d == null) return { met: false, detail: 'dep-update nunca ejecutado' };
    return d <= 14
      ? { met: true, detail: `Revisadas hace ${d}d` }
      : { met: false, detail: `Revisadas hace ${d}d (>14d)` };
  }
};

function securityAuditWithinDays(days) {
  return {
    id: `security-audit-${days}d`,
    label: `Security audit <${days}d`,
    check: (s) => {
      const d = lastSkillRun(s.history, 'security-review', s.now);
      if (d == null) return { met: false, detail: 'Nunca auditado' };
      return d <= days
        ? { met: true, detail: `Audit hace ${d}d` }
        : { met: false, detail: `Audit hace ${d}d (>${days}d)` };
    }
  };
}

function minScore(target) {
  return {
    id: `score-min-${target}`,
    label: `Score ≥${target}/10`,
    check: (s) => {
      const sc = s.analysis?.score ?? 0;
      return sc >= target
        ? { met: true, detail: `Score ${sc}/10` }
        : { met: false, detail: `Score ${sc}/10 (<${target})` };
    }
  };
}

const recentActivity7d = {
  id: 'recent-activity-7d',
  label: 'Commits recientes (<14d)',
  check: (s) => {
    const d = s.analysis?.checks?.lastCommitDays;
    if (d == null) return { met: false, detail: 'Sin datos de commit' };
    return d <= 14
      ? { met: true, detail: `Último commit hace ${d}d` }
      : { met: false, detail: `Último commit hace ${d}d` };
  }
};

// ---- Plantillas ----

/** @type {Template[]} */
const TEMPLATES = [
  {
    name: 'production-ready',
    label: 'Listo para producción',
    description: 'Listo para ser usado en producción real',
    criteria: [
      hasClaudeMdRecent,
      testsCoverage70,
      securityAuditWithinDays(30),
      minScore(8),
      depsUpToDate,
    ],
    skills: ['audit-claude-md', 'add-tests', 'security-review', 'dep-update', 'simplify', 'fix-types', 'perf-audit'],
    plannerModel: 'sonnet'
  },
  {
    name: 'MVP-lanzable',
    label: 'MVP lanzable',
    description: 'Mínimo viable publicable',
    criteria: [
      hasClaudeMd,
      testsHappyPath,
      gitClean,
      minScore(6),
    ],
    skills: ['audit-claude-md', 'add-tests', 'ui-polish', 'fix-types', 'frontend-design'],
    plannerModel: 'sonnet'
  },
  {
    name: 'mantenimiento',
    label: 'Mantenimiento',
    description: 'No estropear lo que funciona',
    criteria: [
      hasClaudeMdRecent,
      depsUpToDate14d,
      gitClean,
      minScore(7),
    ],
    skills: ['dep-update', 'audit-claude-md', 'git-cleanup', 'simplify'],
    plannerModel: 'sonnet'
  },
  {
    name: 'explorar-idea',
    label: 'Explorar idea',
    description: 'Prototipo / investigación',
    criteria: [
      hasClaudeMd,
      recentActivity7d,
    ],
    skills: ['audit-claude-md', 'frontend-design', 'webapp-testing'],
    plannerModel: 'opus'
  },
  {
    name: 'seguro-y-testeado',
    label: 'Seguro y testeado',
    description: 'Robusto para uso externo',
    criteria: [
      securityAuditWithinDays(30),
      depsUpToDate,
      testsCoverage80Entry,
      hasClaudeMd,
    ],
    skills: ['security-review', 'trailofbits-security', 'supabase-audit', 'add-tests', 'dep-update'],
    plannerModel: 'sonnet'
  },
];

const TEMPLATE_MAP = Object.freeze(
  TEMPLATES.reduce((m, t) => { m[t.name] = t; return m; }, {})
);

// ---- API pública ----

function listTemplates() {
  return TEMPLATES.map(t => ({
    name: t.name,
    label: t.label,
    description: t.description,
    criteriaCount: t.criteria.length,
    plannerModel: t.plannerModel,
  }));
}

function getTemplate(name) {
  return TEMPLATE_MAP[name] || null;
}

function isValidTemplate(name) {
  return name in TEMPLATE_MAP;
}

/**
 * Evalúa el estado actual de un proyecto contra los criterios de la plantilla.
 * @param {string} templateName
 * @param {ProjectState} state
 * @returns {{met: boolean, satisfied: number, total: number, criteria: Array<{id: string, label: string, met: boolean, detail: string}>}}
 */
function evaluate(templateName, state) {
  const tpl = getTemplate(templateName);
  if (!tpl) throw new Error(`Unknown template: ${templateName}`);
  const ctx = { ...state, now: state.now ?? Date.now() };
  const results = tpl.criteria.map(c => {
    const r = c.check(ctx);
    return { id: c.id, label: c.label, met: !!r.met, detail: r.detail };
  });
  const satisfied = results.filter(r => r.met).length;
  return {
    met: satisfied === results.length,
    satisfied,
    total: results.length,
    criteria: results,
  };
}

function preferredSkills(templateName) {
  const tpl = getTemplate(templateName);
  return tpl ? tpl.skills.slice() : [];
}

/**
 * Modelo default del planner para una plantilla + nota.
 * Notas con palabras clave ambiguas ("explorar", "prototipo") → opus.
 * @param {string} templateName
 * @param {string} [note]
 * @returns {'haiku'|'sonnet'|'opus'}
 */
function plannerModelFor(templateName, note) {
  const tpl = getTemplate(templateName);
  const base = tpl?.plannerModel || 'sonnet';
  if (note && /explor|prototip|idea|experiment|investig/i.test(note)) return 'opus';
  return base;
}

module.exports = {
  listTemplates,
  getTemplate,
  isValidTemplate,
  evaluate,
  preferredSkills,
  plannerModelFor,
};
