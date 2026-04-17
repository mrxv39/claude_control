/**
 * autonomous-store.js — Adaptador de persistencia para el orquestador autónomo.
 *
 * Expone exactamente el contrato que consume `AutonomousOrchestrator`
 * (getConfig, updateProject, recordEvent) sin modificar el orchestrator-store
 * existente. Detrás usa el mismo orchestrator.json para los campos nuevos
 * (`projects.*.active/objective/history/failures24h/maintenanceSince`,
 * `tokenTargetPct`, `tokenAvgWindowDays`, `telegram`, `autoMerge`, `vacationMode`)
 * y un JSONL separado (`autonomous-events.jsonl`) para el feed.
 *
 * Inicializa campos nuevos con defaults seguros sin tocar campos antiguos:
 * un proyecto preexistente (con stack/path/score/suggestions/etc.) NO pierde
 * nada — simplemente gana active:false, objective:null, history:[],
 * failures24h:[], maintenanceSince:null al primer acceso.
 */

const fs = require('fs');
const path = require('path');
const store = require('./orchestrator-store');

const EVENTS_PATH = path.join(store.STATE_DIR, 'autonomous-events.jsonl');
const PENDING_PATH = path.join(store.STATE_DIR, 'pending-questions.json');
const PLANNER_HISTORY_PATH = path.join(store.STATE_DIR, 'planner-history.jsonl');

const AUTONOMOUS_DEFAULTS = {
  tokenTargetPct: 90,
  tokenAvgWindowDays: 7,
  digestTime: '09:00',
  telegram: { enabled: false, botToken: null, chatId: null, timeoutHours: 12 },
  autoMerge: { trivialDelayHours: 24, requireCI: true },
  vacationMode: { active: false, until: null, overrides: {} },
};

const PROJECT_AUTONOMOUS_DEFAULTS = {
  active: false,
  objective: null,
  history: [],
  failures24h: [],
  maintenanceSince: null,
};

// ---- Deep merge pura (para patches) ----

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, patch) {
  if (!isPlainObject(target)) return patch;
  if (!isPlainObject(patch)) return patch;
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(target[k])) out[k] = deepMerge(target[k], v);
    else out[k] = v;
  }
  return out;
}

function withAutonomousDefaults(project) {
  const base = project || {};
  const out = { ...PROJECT_AUTONOMOUS_DEFAULTS, ...base };
  if (!Array.isArray(out.history)) out.history = [];
  if (!Array.isArray(out.failures24h)) out.failures24h = [];
  return out;
}

// ---- Config ----

/**
 * Devuelve la config completa con los campos autónomos rellenos (no muta el
 * archivo — son defaults en memoria).
 * @returns {any}
 */
function getConfig() {
  const raw = store.load();
  const out = { ...AUTONOMOUS_DEFAULTS, ...raw };
  // Asegura que telegram/autoMerge/vacationMode son objetos (no null)
  out.telegram = { ...AUTONOMOUS_DEFAULTS.telegram, ...(raw.telegram || {}) };
  out.autoMerge = { ...AUTONOMOUS_DEFAULTS.autoMerge, ...(raw.autoMerge || {}) };
  out.vacationMode = { ...AUTONOMOUS_DEFAULTS.vacationMode, ...(raw.vacationMode || {}) };
  // Enriquece cada proyecto con defaults autónomos
  const projects = {};
  for (const [name, p] of Object.entries(raw.projects || {})) {
    projects[name] = withAutonomousDefaults(p);
  }
  out.projects = projects;
  return out;
}

/**
 * Aplica un patch parcial al archivo de config (top-level).
 * @param {Partial<any>} partial
 */
function updateConfig(partial) {
  const current = store.load();
  const next = deepMerge(current, partial);
  store.save(next);
  return next;
}

// ---- Proyectos ----

function getProject(name) {
  const cfg = store.load();
  return withAutonomousDefaults(cfg.projects?.[name]);
}

/**
 * Aplica deep-merge al proyecto. Crea el proyecto con defaults si no existe.
 * @param {string} name
 * @param {Partial<any>} patch
 */
function updateProject(name, patch) {
  if (!name) throw new Error('updateProject requires name');
  const cfg = store.load();
  cfg.projects = cfg.projects || {};
  const current = withAutonomousDefaults(cfg.projects[name]);
  cfg.projects[name] = deepMerge(current, patch);
  store.save(cfg);
  return cfg.projects[name];
}

function toggleActive(name, active) {
  return updateProject(name, { active: !!active });
}

function setObjective(name, objective) {
  return updateProject(name, { objective });
}

function appendHistory(name, entry) {
  const p = getProject(name);
  const history = [...(p.history || []), entry];
  return updateProject(name, { history });
}

// ---- Event log (feed) ----

function ensureDir() {
  fs.mkdirSync(store.STATE_DIR, { recursive: true });
}

/**
 * Append-only event log. Cada línea = un JSON. Lo usa AutonomousOrchestrator
 * como `recordEvent`.
 * @param {any} event
 */
function appendEvent(event) {
  if (!event || typeof event !== 'object') return;
  ensureDir();
  const withTs = { at: Date.now(), ...event };
  fs.appendFileSync(EVENTS_PATH, JSON.stringify(withTs) + '\n', 'utf-8');
}

function readEvents(maxLines = 200) {
  if (!fs.existsSync(EVENTS_PATH)) return [];
  try {
    const lines = fs.readFileSync(EVENTS_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---- Pending questions ----

function loadPendingQuestions() {
  if (!fs.existsSync(PENDING_PATH)) return [];
  try {
    const raw = fs.readFileSync(PENDING_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePendingQuestions(queue) {
  ensureDir();
  fs.writeFileSync(PENDING_PATH, JSON.stringify(queue, null, 2), 'utf-8');
}

// ---- Planner history (para learner) ----

function appendPlannerHistory(record) {
  if (!record || !record.skill) return;
  ensureDir();
  const withTs = { at: Date.now(), ...record };
  fs.appendFileSync(PLANNER_HISTORY_PATH, JSON.stringify(withTs) + '\n', 'utf-8');
}

function readPlannerHistory(maxLines = 500) {
  if (!fs.existsSync(PLANNER_HISTORY_PATH)) return [];
  try {
    const lines = fs.readFileSync(PLANNER_HISTORY_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  getConfig,
  updateConfig,
  getProject,
  updateProject,
  toggleActive,
  setObjective,
  appendHistory,
  appendEvent,
  readEvents,
  loadPendingQuestions,
  savePendingQuestions,
  appendPlannerHistory,
  readPlannerHistory,
  withAutonomousDefaults,
  deepMerge,
  AUTONOMOUS_DEFAULTS,
  PROJECT_AUTONOMOUS_DEFAULTS,
  EVENTS_PATH,
  PENDING_PATH,
  PLANNER_HISTORY_PATH,
};
