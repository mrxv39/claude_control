/**
 * orchestrator.js — Cerebro del sistema autónomo: un tick completo.
 *
 * Cose goals + evaluator + planner + circuit-breaker con dependency injection.
 * NO hace I/O directamente — las dependencias (getConfig, analyze, executor,
 * updateProject, recordEvent) se inyectan desde fuera. Esto permite tests
 * puros sin spawn ni fs.
 *
 * Flujo de un tick:
 *   1. Lee config, filtra proyectos activos con objetivo.
 *   2. Analiza cada proyecto (puede fallar → score 5 baseline).
 *   3. Evalúa contra plantilla → detecta transiciones.
 *   4. Persiste transiciones (reached/regressed).
 *   5. Selecciona proyectos que necesitan acción (no en mantenimiento estable).
 *   6. Llama al planner → decisión {run, project, skill, reasoning} | no_op.
 *   7. Si dry-run → log event. Si real → executor.execute + history + circuit breaker.
 *
 * @typedef {Object} TickDeps
 * @property {() => Promise<any>} getConfig
 * @property {(project: {name, path, stack}) => Promise<{checks, score}>} analyze
 * @property {(name: string, patch: any) => Promise<void>} updateProject
 * @property {(event: any) => void} recordEvent
 * @property {{decide: Function, buildConstraints: Function}} [planner]
 * @property {{execute: (task: any) => Promise<any>}} [executor] - null/undefined = dry-run
 * @property {number} [now]
 *
 * @typedef {Object} TickResult
 * @property {'skip'|'no_op'|'dry-run'|'executed'} action
 * @property {string} [reason]
 * @property {string} [project]
 * @property {string} [skill]
 * @property {string} [reasoning]
 * @property {'ok'|'fail'} [outcome]
 */

const goals = require('./goals');
const evaluator = require('./evaluator');
const defaultPlanner = require('./planner');
const circuitBreaker = require('./circuit-breaker');

// ---- Pure helpers ----

/**
 * Construye el objeto de proyecto que consume el planner.
 * @param {string} name
 * @param {any} project
 * @param {any} evaluation
 * @returns {import('./planner').PlannerProject}
 */
function makePlannerProject(name, project, evaluation) {
  return {
    name,
    path: project.path,
    stack: project.stack,
    objective: project.objective,
    evaluation,
    preferredSkills: goals.preferredSkills(project.objective?.template),
    recentHistory: (project.history || []).slice(-10),
  };
}

/**
 * Filtra los proyectos evaluados que merecen pasar al planner:
 *   - in-progress o regressed → necesitan acción
 *   - maintained + needsReevaluation → toca re-chequear
 *   - maintained + !needsReevaluation → skip (tranquilo)
 *   - reached → este tick ya transitó; el próximo tick decide
 *
 * @param {Array<{transition: string, needsReevaluation: boolean}>} evaluated
 */
function selectProjectsForPlanner(evaluated) {
  return evaluated.filter(e =>
    e.transition === 'in-progress' ||
    e.transition === 'regressed' ||
    (e.transition === 'maintained' && e.needsReevaluation)
  );
}

/**
 * Aplasta los historiales de todos los proyectos en una lista con {project}.
 * Útil para construir restricciones globales de cooldown.
 * @param {Record<string, any>} projects
 * @returns {Array<{project: string, skill: string, at: number, outcome: string}>}
 */
function buildGlobalHistory(projects) {
  const all = [];
  for (const [name, p] of Object.entries(projects || {})) {
    for (const h of (p?.history || [])) {
      if (h && h.skill && typeof h.at === 'number') {
        all.push({ project: name, skill: h.skill, at: h.at, outcome: h.outcome });
      }
    }
  }
  return all;
}

// ---- Tick completo ----

/**
 * Ejecuta un tick completo del orquestador.
 * @param {TickDeps} deps
 * @returns {Promise<TickResult>}
 */
async function tick(deps) {
  const {
    getConfig,
    analyze,
    updateProject,
    recordEvent,
    planner = defaultPlanner,
    executor = null,
  } = deps;
  const now = deps.now ?? Date.now();

  const config = await getConfig();
  const projects = config?.projects || {};
  const activeEntries = Object.entries(projects)
    .filter(([, p]) => p && p.active && p.objective?.template);

  if (!activeEntries.length) {
    recordEvent({ type: 'tick-skip', reason: 'no-active-projects', at: now });
    return { action: 'skip', reason: 'no-active-projects' };
  }

  // 1. Analizar cada proyecto activo
  const analyses = {};
  for (const [name, proj] of activeEntries) {
    try {
      analyses[name] = await analyze({ name, path: proj.path, stack: proj.stack });
    } catch (e) {
      recordEvent({ type: 'analyze-error', project: name, error: e.message, at: now });
      analyses[name] = { score: 5, checks: {} };
    }
  }

  // 2. Evaluar
  const evaluated = activeEntries.map(([name, proj]) => {
    const r = evaluator.evaluateProject(proj, analyses[name], { now });
    return { name, project: proj, analysis: analyses[name], ...r };
  });

  // 3. Persistir transiciones
  for (const e of evaluated) {
    if (e.transition === 'reached') {
      await updateProject(e.name, { maintenanceSince: now });
      recordEvent({ type: 'goal-reached', project: e.name, template: e.project.objective.template, at: now });
    } else if (e.transition === 'regressed') {
      await updateProject(e.name, { maintenanceSince: null });
      recordEvent({ type: 'goal-regressed', project: e.name, template: e.project.objective.template, at: now });
    }
  }

  // 4. Seleccionar para planner
  const forPlanner = selectProjectsForPlanner(evaluated);
  if (!forPlanner.length) {
    recordEvent({ type: 'tick-skip', reason: 'all-in-maintenance', at: now });
    return { action: 'skip', reason: 'all-in-maintenance' };
  }

  // 5. Construir estado del planner
  const globalHistory = buildGlobalHistory(projects);
  const plannerState = {
    now,
    activeProjects: forPlanner.map(e => makePlannerProject(e.name, e.project, e.evaluation)),
    constraints: { blockedExecutions: planner.buildConstraints(globalHistory) },
  };

  // 6. Decidir
  const decision = await planner.decide(plannerState);
  recordEvent({ type: 'planner-decision', ...decision, at: now });

  if (decision.decision === 'no_op') {
    return { action: 'no_op', reason: decision.reasoning };
  }

  // 7. Ejecutar (dry-run o real)
  if (!executor) {
    recordEvent({
      type: 'dry-run',
      project: decision.project,
      skill: decision.skill,
      reasoning: decision.reasoning,
      at: now,
    });
    return {
      action: 'dry-run',
      project: decision.project,
      skill: decision.skill,
      reasoning: decision.reasoning,
    };
  }

  const startedAt = now;
  let execResult;
  try {
    execResult = await executor.execute({
      project: decision.project,
      projectPath: projects[decision.project]?.path,
      skill: decision.skill,
    });
  } catch (e) {
    execResult = { status: 'failed', error: e.message };
  }
  const endedAt = deps.now != null ? deps.now : Date.now();
  const outcome = execResult?.status === 'done' ? 'ok' : 'fail';

  // 8. Actualizar history + circuit breaker
  const proj = projects[decision.project];
  const historyEntry = {
    skill: decision.skill,
    at: startedAt,
    outcome,
    scoreBefore: analyses[decision.project]?.score,
  };
  const newHistory = [...(proj?.history || []), historyEntry];

  const cb = circuitBreaker.recordExecution(
    proj?.failures24h,
    { skill: decision.skill, outcome, at: startedAt, durationMs: endedAt - startedAt },
    { now: endedAt },
  );

  const patch = { history: newHistory, failures24h: cb.failures };
  if (cb.tripped) patch.active = false;
  await updateProject(decision.project, patch);

  recordEvent({
    type: 'skill-executed',
    project: decision.project,
    skill: decision.skill,
    outcome,
    duration: endedAt - startedAt,
    at: startedAt,
  });

  if (cb.tripped) {
    recordEvent({
      type: 'circuit-breaker-trip',
      project: decision.project,
      reason: cb.reason,
      at: endedAt,
    });
  }

  return {
    action: 'executed',
    project: decision.project,
    skill: decision.skill,
    reasoning: decision.reasoning,
    outcome,
  };
}

module.exports = {
  tick,
  makePlannerProject,
  selectProjectsForPlanner,
  buildGlobalHistory,
};
